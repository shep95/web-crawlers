from __future__ import annotations

import asyncio
import uuid
from datetime import datetime

import httpx
import structlog

from omnispider.core.config import AppConfig
from omnispider.core.models import (
    CrawlJob,
    CrawlJobSpec,
    CrawlStatus,
    EngineType,
    FrontierEntry,
    PageRecord,
    PageSource,
)
from omnispider.core.policy import (
    content_hash,
    extract_title,
    needs_js_rendering,
    normalize_url,
    save_content,
)
from omnispider.core.storage import Storage
from omnispider.discovery.links import (
    GLOBAL_CCTLD_SEEDS,
    discover_robots_sitemaps,
    discover_sitemap_urls,
    extract_links,
)
from omnispider.engines.registry import EngineRegistry

log = structlog.get_logger()


class Orchestrator:
    """Unified crawl orchestrator spanning live web, archives, and multi-engine rendering."""

    def __init__(self, config: AppConfig) -> None:
        self._config = config
        self._storage = Storage(config)
        self._engines = EngineRegistry(config)
        from omnispider.core.policy import CrawlPolicy

        self._policy = CrawlPolicy(config)
        self._active_jobs: dict[str, asyncio.Task] = {}
        self._page_limit_lock = asyncio.Lock()

    async def initialize(self) -> None:
        await self._storage.initialize()

    async def shutdown(self) -> None:
        for task in list(self._active_jobs.values()):
            task.cancel()
        await self._engines.close_all()

    def create_job(self, spec: CrawlJobSpec) -> CrawlJob:
        job_id = str(uuid.uuid4())
        return CrawlJob(id=job_id, **spec.model_dump())

    async def submit_job(self, spec: CrawlJobSpec) -> CrawlJob:
        job = self.create_job(spec)
        await self._storage.create_job(job)
        task = asyncio.create_task(self._run_job(job))
        self._active_jobs[job.id] = task
        task.add_done_callback(lambda _: self._active_jobs.pop(job.id, None))
        return job

    async def get_job(self, job_id: str) -> CrawlJob | None:
        return await self._storage.get_job(job_id)

    async def list_jobs(self, limit: int = 50) -> list[CrawlJob]:
        return await self._storage.list_jobs(limit)

    async def list_pages(self, job_id: str, limit: int = 100, offset: int = 0) -> list[PageRecord]:
        return await self._storage.list_pages(job_id, limit, offset)

    async def _seed_frontier(self, job: CrawlJob, client: httpx.AsyncClient) -> None:
        entries: list[FrontierEntry] = []
        seeds = [normalize_url(s) for s in job.seeds]

        if self._config.discovery.cc_tld_seeds:
            seeds.extend(GLOBAL_CCTLD_SEEDS)

        for seed in seeds:
            entries.append(FrontierEntry(url=seed, depth=0, source=PageSource.SEED, priority=100))

        if job.include_sitemaps and self._config.discovery.sitemap:
            for seed in seeds:
                sitemap_urls = await discover_sitemap_urls(
                    client,
                    seed,
                    timeout=self._config.orchestrator.request_timeout_seconds,
                    user_agent=self._config.orchestrator.user_agent,
                )
                robots_sitemaps = await discover_robots_sitemaps(
                    client,
                    seed,
                    timeout=self._config.orchestrator.request_timeout_seconds,
                    user_agent=self._config.orchestrator.user_agent,
                )
                for url in sitemap_urls + robots_sitemaps:
                    entries.append(
                        FrontierEntry(url=url, depth=0, source=PageSource.SITEMAP, priority=90)
                    )

        katana = self._engines.get(EngineType.KATANA)
        discovered = await katana.discover_urls(
            client,
            seeds,
            max_urls=min(job.max_pages, 500),
        )
        for url in discovered:
            entries.append(FrontierEntry(url=normalize_url(url), depth=1, source=PageSource.LIVE, priority=80))

        if job.include_archive and self._config.archive.enabled:
            archive = self._engines.get(EngineType.ARCHIVE)
            from omnispider.engines.archive_engine import ArchiveEngine

            assert isinstance(archive, ArchiveEngine)
            for seed in seeds:
                snapshots = await archive.discover_archive_frontier(client, seed)
                for url, timestamp in snapshots:
                    entries.append(
                        FrontierEntry(
                            url=url,
                            depth=0,
                            source=PageSource.WAYBACK,
                            priority=70,
                            archive_timestamp=timestamp,
                        )
                    )

        await self._storage.enqueue_frontier(job.id, entries)
        log.info("frontier_seeded", job_id=job.id, entries=len(entries))

    async def _run_job(self, job: CrawlJob) -> None:
        job.status = CrawlStatus.RUNNING
        job.started_at = datetime.utcnow()
        await self._storage.update_job(job)

        timeout = httpx.Timeout(self._config.orchestrator.request_timeout_seconds)
        limits = httpx.Limits(max_connections=self._config.orchestrator.max_concurrency)

        try:
            async with httpx.AsyncClient(timeout=timeout, limits=limits) as client:
                await self._seed_frontier(job, client)
                sem = asyncio.Semaphore(self._config.orchestrator.max_concurrency)
                workers = [
                    asyncio.create_task(self._worker(job, client, sem))
                    for _ in range(min(self._config.orchestrator.max_concurrency, 8))
                ]
                await asyncio.gather(*workers, return_exceptions=True)

            job.status = CrawlStatus.COMPLETED
        except asyncio.CancelledError:
            job.status = CrawlStatus.CANCELLED
            job.error = "cancelled"
        except Exception as exc:
            job.status = CrawlStatus.FAILED
            job.error = str(exc)
            log.exception("job_failed", job_id=job.id, error=str(exc))
        finally:
            job.finished_at = datetime.utcnow()
            await self._storage.update_job(job)

    async def _worker(self, job: CrawlJob, client: httpx.AsyncClient, sem: asyncio.Semaphore) -> None:
        seed_url = normalize_url(job.seeds[0])
        idle_rounds = 0
        while job.pages_crawled < job.max_pages:
            entry = await self._storage.pop_frontier(job.id)
            if entry is None:
                idle_rounds += 1
                if idle_rounds >= 6:
                    break
                await asyncio.sleep(0.5)
                continue
            idle_rounds = 0

            if entry.depth > job.max_depth:
                await self._storage.mark_frontier_done(job.id, entry.url, entry.archive_timestamp)
                continue

            visited = await self._storage.mark_visited(job.id, entry.url, entry.archive_timestamp)
            if not visited:
                await self._storage.mark_frontier_done(job.id, entry.url, entry.archive_timestamp)
                continue

            allowed, reason = await self._policy.preflight(
                client,
                entry.url,
                allowed_domains=job.allowed_domains,
                seed_url=seed_url,
            )
            if not allowed:
                log.debug("url_skipped", url=entry.url, reason=reason)
                job.pages_failed += 1
                await self._storage.mark_frontier_done(job.id, entry.url, entry.archive_timestamp)
                await self._storage.update_job(job)
                continue

            async with sem:
                async with self._page_limit_lock:
                    if job.pages_crawled >= job.max_pages:
                        await self._storage.mark_frontier_done(
                            job.id, entry.url, entry.archive_timestamp
                        )
                        break
                page = await self._fetch_and_process(job, client, entry, seed_url)

            if page:
                async with self._page_limit_lock:
                    job.pages_crawled += 1
            else:
                job.pages_failed += 1
            await self._storage.mark_frontier_done(job.id, entry.url, entry.archive_timestamp)
            await self._storage.update_job(job)

    async def _fetch_and_process(
        self,
        job: CrawlJob,
        client: httpx.AsyncClient,
        entry: FrontierEntry,
        seed_url: str,
    ) -> PageRecord | None:
        engine_type = self._policy.select_engine(
            requested=job.engine,
            js_rendering=job.js_rendering,
            source=entry.source,
        )
        engine = self._engines.get(engine_type)
        result = await engine.fetch(
            client,
            entry.url,
            source=entry.source,
            archive_timestamp=entry.archive_timestamp,
        )

        if not result.ok:
            if (
                result.error != "katana_is_discovery_only"
                and result.status_code != 404
                and entry.source == PageSource.LIVE
                and not job.js_rendering
            ):
                pw = self._engines.get(EngineType.PLAYWRIGHT)
                retry = await pw.fetch(client, entry.url, source=entry.source)
                if retry.ok:
                    result = retry
                    engine_type = EngineType.PLAYWRIGHT

        if not result.ok or not result.body:
            return None

        html = result.body.decode("utf-8", errors="replace")
        if (
            entry.source == PageSource.LIVE
            and not job.js_rendering
            and needs_js_rendering(html)
        ):
            pw = self._engines.get(EngineType.PLAYWRIGHT)
            retry = await pw.fetch(client, entry.url, source=entry.source)
            if retry.ok and retry.body:
                result = retry
                html = retry.body.decode("utf-8", errors="replace")
                engine_type = EngineType.PLAYWRIGHT

        content_path = None
        digest = content_hash(result.body)
        if self._storage.store_html and "html" in (result.content_type or "text/html"):
            content_path = save_content(self._storage.content_dir, entry.url, result.body)

        links = extract_links(html, result.final_url) if self._config.discovery.link_extraction else []
        page = PageRecord(
            url=entry.url,
            final_url=result.final_url,
            status_code=result.status_code,
            content_type=result.content_type,
            title=extract_title(html),
            depth=entry.depth,
            source=entry.source,
            engine=engine_type,
            content_path=content_path,
            content_hash=digest,
            links_found=len(links),
            archive_timestamp=entry.archive_timestamp,
        )
        await self._storage.save_page(job.id, page)

        if entry.depth < job.max_depth and entry.source == PageSource.LIVE:
            child_entries = [
                FrontierEntry(
                    url=link,
                    depth=entry.depth + 1,
                    source=PageSource.LIVE,
                    priority=50 - entry.depth,
                )
                for link in links[:200]
            ]
            await self._storage.enqueue_frontier(job.id, child_entries)

        return page
