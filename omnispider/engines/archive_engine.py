from __future__ import annotations

import httpx
import structlog

from omnispider.core.config import AppConfig
from omnispider.core.models import EngineType, FetchResult, PageSource
from omnispider.engines.base import BaseEngine

log = structlog.get_logger()


class ArchiveEngine(BaseEngine):
    """Temporal coverage via Internet Archive Wayback Machine CDX + render API."""

    engine_type = EngineType.ARCHIVE

    def __init__(self, config: AppConfig) -> None:
        super().__init__(config)
        self._cdx_url = config.archive.wayback_cdx_url
        self._render_base = config.archive.wayback_render_url.rstrip("/")
        self._max_snapshots = config.archive.max_snapshots_per_url
        self._timeout = config.orchestrator.request_timeout_seconds
        self._user_agent = config.orchestrator.user_agent

    async def list_snapshots(self, client: httpx.AsyncClient, url: str) -> list[str]:
        params = {
            "url": url,
            "output": "json",
            "fl": "timestamp,original,statuscode",
            "filter": "statuscode:200",
            "collapse": "timestamp:8",
            "limit": str(self._max_snapshots),
        }
        try:
            response = await client.get(
                self._cdx_url,
                params=params,
                timeout=self._timeout,
                headers={"User-Agent": self._user_agent},
            )
            response.raise_for_status()
            rows = response.json()
            if not rows or len(rows) < 2:
                return []
            timestamps = [row[0] for row in rows[1:] if row and row[0]]
            return timestamps
        except Exception as exc:
            log.warning("wayback_cdx_failed", url=url, error=str(exc))
            return []

    def wayback_url(self, timestamp: str, url: str) -> str:
        return f"{self._render_base}/{timestamp}/{url}"

    async def fetch(
        self,
        client: httpx.AsyncClient,
        url: str,
        *,
        source: PageSource = PageSource.WAYBACK,
        archive_timestamp: str | None = None,
    ) -> FetchResult:
        timestamp = archive_timestamp
        if not timestamp:
            snapshots = await self.list_snapshots(client, url)
            if not snapshots:
                return FetchResult(
                    url=url,
                    final_url=url,
                    status_code=404,
                    engine=self.engine_type,
                    source=PageSource.WAYBACK,
                    error="no_archive_snapshots",
                )
            timestamp = snapshots[-1]

        archive_url = self.wayback_url(timestamp, url)
        try:
            response = await client.get(
                archive_url,
                timeout=self._timeout,
                follow_redirects=True,
                headers={"User-Agent": self._user_agent},
            )
            return FetchResult(
                url=url,
                final_url=str(response.url),
                status_code=response.status_code,
                headers=dict(response.headers),
                body=response.content,
                content_type=response.headers.get("content-type"),
                engine=self.engine_type,
                source=PageSource.WAYBACK,
                archive_timestamp=timestamp,
            )
        except Exception as exc:
            log.warning("wayback_fetch_failed", url=url, timestamp=timestamp, error=str(exc))
            return FetchResult(
                url=url,
                final_url=archive_url,
                status_code=0,
                engine=self.engine_type,
                source=PageSource.WAYBACK,
                archive_timestamp=timestamp,
                error=str(exc),
            )

    async def discover_archive_frontier(
        self, client: httpx.AsyncClient, url: str
    ) -> list[tuple[str, str]]:
        timestamps = await self.list_snapshots(client, url)
        return [(url, ts) for ts in timestamps]
