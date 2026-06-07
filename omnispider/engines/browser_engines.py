from __future__ import annotations

import asyncio
import json
import shutil
import subprocess
from typing import Any

import httpx
import structlog

from omnispider.core.config import AppConfig
from omnispider.core.models import EngineType, FetchResult, PageSource
from omnispider.engines.base import BaseEngine

log = structlog.get_logger()


class PlaywrightEngine(BaseEngine):
    engine_type = EngineType.PLAYWRIGHT

    def __init__(self, config: AppConfig) -> None:
        super().__init__(config)
        self._headless = config.engines.playwright.headless
        self._wait_until = config.engines.playwright.wait_until
        self._timeout_ms = config.orchestrator.request_timeout_seconds * 1000
        self._playwright: Any = None
        self._browser: Any = None
        self._lock = asyncio.Lock()

    async def _ensure_browser(self) -> None:
        if self._browser is not None:
            return
        async with self._lock:
            if self._browser is not None:
                return
            try:
                from playwright.async_api import async_playwright
            except ImportError as exc:
                raise RuntimeError(
                    "Playwright not installed. Run: pip install omnispider[browser] && playwright install"
                ) from exc
            self._playwright = await async_playwright().start()
            self._browser = await self._playwright.chromium.launch(headless=self._headless)

    async def fetch(
        self,
        client: httpx.AsyncClient,
        url: str,
        *,
        source: PageSource = PageSource.LIVE,
        archive_timestamp: str | None = None,
    ) -> FetchResult:
        await self._ensure_browser()
        assert self._browser is not None
        page = await self._browser.new_page(
            user_agent=self._config.orchestrator.user_agent,
        )
        try:
            response = await page.goto(
                url,
                wait_until=self._wait_until,
                timeout=self._timeout_ms,
            )
            html = await page.content()
            status = response.status if response else 200
            headers = await response.all_headers() if response else {}
            return FetchResult(
                url=url,
                final_url=page.url,
                status_code=status,
                headers=headers,
                body=html.encode("utf-8", errors="replace"),
                content_type="text/html",
                engine=self.engine_type,
                source=source,
                archive_timestamp=archive_timestamp,
            )
        except Exception as exc:
            log.warning("playwright_fetch_failed", url=url, error=str(exc))
            return FetchResult(
                url=url,
                final_url=url,
                status_code=0,
                engine=self.engine_type,
                source=source,
                archive_timestamp=archive_timestamp,
                error=str(exc),
            )
        finally:
            await page.close()

    async def close(self) -> None:
        if self._browser:
            await self._browser.close()
            self._browser = None
        if self._playwright:
            await self._playwright.stop()
            self._playwright = None


class KatanaEngine(BaseEngine):
    """Fast link discovery via ProjectDiscovery Katana (Go binary)."""

    engine_type = EngineType.KATANA

    async def discover_urls(
        self,
        client: httpx.AsyncClient,
        seeds: list[str],
        *,
        max_urls: int = 1000,
    ) -> list[str]:
        binary = self._config.engines.katana.binary
        if not shutil.which(binary):
            log.info("katana_not_found", binary=binary)
            return []

        discovered: list[str] = []
        for seed in seeds:
            cmd = [
                binary,
                "-u",
                seed,
                "-jsonl",
                "-d",
                str(min(self._config.orchestrator.max_depth, 5)),
                "-c",
                str(min(self._config.orchestrator.max_concurrency, 10)),
            ] + self._config.engines.katana.extra_args
            try:
                proc = await asyncio.create_subprocess_exec(
                    *cmd,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
                stdout, _ = await asyncio.wait_for(
                    proc.communicate(),
                    timeout=self._config.orchestrator.request_timeout_seconds * 10,
                )
                for line in stdout.decode("utf-8", errors="replace").splitlines():
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        row = json.loads(line)
                        endpoint = row.get("request", {}).get("endpoint") or row.get("url")
                        if endpoint:
                            discovered.append(endpoint)
                    except json.JSONDecodeError:
                        continue
                    if len(discovered) >= max_urls:
                        break
            except Exception as exc:
                log.warning("katana_discovery_failed", seed=seed, error=str(exc))
        return list(dict.fromkeys(discovered))[:max_urls]

    async def fetch(
        self,
        client: httpx.AsyncClient,
        url: str,
        *,
        source: PageSource = PageSource.LIVE,
        archive_timestamp: str | None = None,
    ) -> FetchResult:
        return FetchResult(
            url=url,
            final_url=url,
            status_code=0,
            engine=self.engine_type,
            source=source,
            error="katana_is_discovery_only",
        )


class SplashEngine(BaseEngine):
    engine_type = EngineType.SPLASH

    async def fetch(
        self,
        client: httpx.AsyncClient,
        url: str,
        *,
        source: PageSource = PageSource.LIVE,
        archive_timestamp: str | None = None,
    ) -> FetchResult:
        base = self._config.engines.splash.base_url.rstrip("/")
        render_url = f"{base}/render.html"
        try:
            response = await client.get(
                render_url,
                params={"url": url, "timeout": self._config.orchestrator.request_timeout_seconds},
                timeout=self._config.orchestrator.request_timeout_seconds + 5,
                headers={"User-Agent": self._config.orchestrator.user_agent},
            )
            return FetchResult(
                url=url,
                final_url=url,
                status_code=response.status_code,
                headers=dict(response.headers),
                body=response.content,
                content_type=response.headers.get("content-type", "text/html"),
                engine=self.engine_type,
                source=source,
                archive_timestamp=archive_timestamp,
            )
        except Exception as exc:
            return FetchResult(
                url=url,
                final_url=url,
                status_code=0,
                engine=self.engine_type,
                source=source,
                error=str(exc),
            )


class MechanicalEngine(BaseEngine):
    engine_type = EngineType.MECHANICAL

    async def fetch(
        self,
        client: httpx.AsyncClient,
        url: str,
        *,
        source: PageSource = PageSource.LIVE,
        archive_timestamp: str | None = None,
    ) -> FetchResult:
        try:
            import mechanicalsoup
        except ImportError as exc:
            return FetchResult(
                url=url,
                final_url=url,
                status_code=0,
                engine=self.engine_type,
                source=source,
                error="MechanicalSoup not installed. Run: pip install omnispider[forms]",
            )

        def _sync_fetch() -> FetchResult:
            browser = mechanicalsoup.StatefulBrowser(user_agent=self._config.orchestrator.user_agent)
            try:
                page = browser.open(url, timeout=self._config.orchestrator.request_timeout_seconds)
                html = page.text or ""
                status = page.status_code or 200
                return FetchResult(
                    url=url,
                    final_url=page.url or url,
                    status_code=status,
                    body=html.encode("utf-8", errors="replace"),
                    content_type="text/html",
                    engine=self.engine_type,
                    source=source,
                    archive_timestamp=archive_timestamp,
                )
            except Exception as exc:
                return FetchResult(
                    url=url,
                    final_url=url,
                    status_code=0,
                    engine=self.engine_type,
                    source=source,
                    error=str(exc),
                )

        return await asyncio.to_thread(_sync_fetch)
