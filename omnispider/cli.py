from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Optional

import structlog
import typer
import uvicorn

from omnispider.core.config import load_config
from omnispider.core.models import CrawlJobSpec, EngineType
from omnispider.core.orchestrator import Orchestrator

structlog.configure(
    processors=[
        structlog.processors.add_log_level,
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.dev.ConsoleRenderer(),
    ]
)

app = typer.Typer(
    name="omnispider",
    help="Omnispider — all-in-one web spider orchestrator",
    no_args_is_help=True,
)
log = structlog.get_logger()


def _run_async(coro):
    return asyncio.run(coro)


@app.command("crawl")
def crawl(
    seeds: list[str] = typer.Argument(..., help="Seed URLs to start crawling"),
    depth: int = typer.Option(3, "--depth", "-d", help="Maximum link depth"),
    max_pages: int = typer.Option(500, "--max-pages", "-m", help="Maximum pages per job"),
    engine: EngineType = typer.Option(EngineType.AUTO, "--engine", "-e", help="Crawl engine"),
    js: bool = typer.Option(False, "--js", help="Force JavaScript rendering"),
    no_archive: bool = typer.Option(False, "--no-archive", help="Skip Wayback Machine snapshots"),
    no_sitemap: bool = typer.Option(False, "--no-sitemap", help="Skip sitemap discovery"),
    domain: Optional[list[str]] = typer.Option(None, "--domain", help="Restrict to domains"),
    config: Optional[Path] = typer.Option(None, "--config", "-c", help="Config YAML path"),
    wait: bool = typer.Option(True, "--wait/--no-wait", help="Wait for job completion"),
) -> None:
    """Start a crawl job across live web + archives."""
    cfg = load_config(config)
    spec = CrawlJobSpec(
        seeds=seeds,
        engine=engine,
        max_depth=depth,
        max_pages=max_pages,
        include_archive=not no_archive,
        include_sitemaps=not no_sitemap,
        js_rendering=js,
        allowed_domains=domain,
    )

    async def _main() -> None:
        orchestrator = Orchestrator(cfg)
        await orchestrator.initialize()
        job = await orchestrator.submit_job(spec)
        typer.echo(f"Job {job.id} started — seeds: {', '.join(seeds)}")
        if wait:
            task = asyncio.current_task()
            while True:
                current = await orchestrator.get_job(job.id)
                if current and current.status.value in ("completed", "failed", "cancelled"):
                    typer.echo(
                        f"Job {job.id} {current.status.value}: "
                        f"{current.pages_crawled} pages, {current.pages_failed} failed"
                    )
                    if current.error:
                        typer.echo(f"Error: {current.error}")
                    break
                await asyncio.sleep(1)
        await orchestrator.shutdown()

    _run_async(_main())


@app.command("discover")
def discover(
    url: str = typer.Argument(..., help="Seed URL for fast link discovery"),
    max_urls: int = typer.Option(200, "--max", help="Maximum URLs to discover"),
    config: Optional[Path] = typer.Option(None, "--config", "-c"),
) -> None:
    """Fast URL discovery (Katana + sitemaps + robots)."""
    import httpx

    from omnispider.discovery.links import discover_robots_sitemaps, discover_sitemap_urls
    from omnispider.engines.registry import EngineRegistry

    cfg = load_config(config)

    async def _main() -> None:
        timeout = cfg.orchestrator.request_timeout_seconds
        ua = cfg.orchestrator.user_agent
        async with httpx.AsyncClient(timeout=timeout) as client:
            urls = await discover_sitemap_urls(client, url, timeout=timeout, user_agent=ua)
            urls += await discover_robots_sitemaps(client, url, timeout=timeout, user_agent=ua)
            registry = EngineRegistry(cfg)
            urls += await registry.get(EngineType.KATANA).discover_urls(
                client, [url], max_urls=max_urls
            )
            await registry.close_all()
        for u in list(dict.fromkeys(urls))[:max_urls]:
            typer.echo(u)

    _run_async(_main())


@app.command("archive")
def archive_lookup(
    url: str = typer.Argument(..., help="URL to look up in Wayback Machine"),
    config: Optional[Path] = typer.Option(None, "--config", "-c"),
) -> None:
    """List historical snapshots for a URL (temporal coverage)."""
    import httpx

    from omnispider.engines.archive_engine import ArchiveEngine

    cfg = load_config(config)

    async def _main() -> None:
        engine = ArchiveEngine(cfg)
        async with httpx.AsyncClient(timeout=cfg.orchestrator.request_timeout_seconds) as client:
            snapshots = await engine.list_snapshots(client, url)
        if not snapshots:
            typer.echo("No snapshots found.")
            return
        for ts in snapshots:
            typer.echo(f"{ts}  {engine.wayback_url(ts, url)}")

    _run_async(_main())


@app.command("jobs")
def jobs(
    config: Optional[Path] = typer.Option(None, "--config", "-c"),
) -> None:
    """List crawl jobs."""
    cfg = load_config(config)

    async def _main() -> None:
        orchestrator = Orchestrator(cfg)
        await orchestrator.initialize()
        for job in await orchestrator.list_jobs():
            typer.echo(
                f"{job.id[:8]}  {job.status.value:10}  "
                f"pages={job.pages_crawled}/{job.max_pages}  seeds={len(job.seeds)}"
            )
        await orchestrator.shutdown()

    _run_async(_main())


@app.command("serve")
def serve(
    host: Optional[str] = typer.Option(None, "--host"),
    port: Optional[int] = typer.Option(None, "--port"),
    config: Optional[Path] = typer.Option(None, "--config", "-c"),
) -> None:
    """Start the Omnispider REST API server."""
    cfg = load_config(config)
    h = host or cfg.api.host
    p = port or cfg.api.port
    typer.echo(f"Starting Omnispider API on http://{h}:{p}")
    uvicorn.run(
        "omnispider.api:app",
        host=h,
        port=p,
        factory=False,
        reload=False,
    )


@app.command("engines")
def engines_list() -> None:
    """List supported crawl engines and vendor references."""
    rows = [
        ("http", "Native async HTTP (Scrapy/Colly-inspired)", "built-in"),
        ("playwright", "JavaScript rendering (Playwright)", "vendors/playwright-main"),
        ("archive", "Wayback Machine temporal coverage", "Internet Archive CDX API"),
        ("katana", "Fast link discovery", "vendors/katana-dev"),
        ("splash", "JS render sidecar", "vendors/splash-master"),
        ("mechanical", "Form/session crawling", "vendors/MechanicalSoup-main"),
        ("scrapy", "Batch spider runs", "vendors/scrapy-master"),
        ("puppeteer", "Reference (use playwright engine)", "vendors/puppeteer-main"),
        ("portia", "Visual spider authoring", "vendors/portia-master"),
        ("heritrix3", "Large-scale archival", "vendors/heritrix3-master"),
        ("nutch", "Hadoop-scale crawling", "vendors/nutch-master"),
        ("stormcrawler", "Real-time distributed", "vendors/stormcrawler-main"),
        ("crawlee", "Node crawl framework", "vendors/crawlee-master"),
        ("colly", "Go fast crawler", "vendors/colly-master"),
    ]
    for name, desc, vendor in rows:
        typer.echo(f"{name:14} {desc:42} [{vendor}]")


if __name__ == "__main__":
    app()
