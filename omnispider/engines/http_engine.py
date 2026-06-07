from __future__ import annotations

import httpx
import structlog
from tenacity import retry, stop_after_attempt, wait_exponential

from omnispider.core.config import AppConfig
from omnispider.core.models import EngineType, FetchResult, PageSource
from omnispider.engines.base import BaseEngine

log = structlog.get_logger()


class HttpEngine(BaseEngine):
    engine_type = EngineType.HTTP

    def __init__(self, config: AppConfig) -> None:
        super().__init__(config)
        self._timeout = config.orchestrator.request_timeout_seconds
        self._attempts = config.orchestrator.retry_attempts
        self._user_agent = config.orchestrator.user_agent

    @retry(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=0.5, min=0.5, max=8),
        reraise=True,
    )
    async def _request(self, client: httpx.AsyncClient, url: str) -> httpx.Response:
        return await client.get(
            url,
            timeout=self._timeout,
            follow_redirects=True,
            headers={"User-Agent": self._user_agent},
        )

    async def fetch(
        self,
        client: httpx.AsyncClient,
        url: str,
        *,
        source: PageSource = PageSource.LIVE,
        archive_timestamp: str | None = None,
    ) -> FetchResult:
        try:
            response = await self._request(client, url)
            content_type = response.headers.get("content-type")
            return FetchResult(
                url=url,
                final_url=str(response.url),
                status_code=response.status_code,
                headers=dict(response.headers),
                body=response.content,
                content_type=content_type,
                engine=self.engine_type,
                source=source,
                archive_timestamp=archive_timestamp,
            )
        except Exception as exc:
            log.warning("http_fetch_failed", url=url, error=str(exc))
            return FetchResult(
                url=url,
                final_url=url,
                status_code=0,
                engine=self.engine_type,
                source=source,
                archive_timestamp=archive_timestamp,
                error=str(exc),
            )
