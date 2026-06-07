from __future__ import annotations

from abc import ABC, abstractmethod

import httpx

from omnispider.core.config import AppConfig
from omnispider.core.models import EngineType, FetchResult, PageSource


class BaseEngine(ABC):
    engine_type: EngineType

    def __init__(self, config: AppConfig) -> None:
        self._config = config

    @abstractmethod
    async def fetch(
        self,
        client: httpx.AsyncClient,
        url: str,
        *,
        source: PageSource = PageSource.LIVE,
        archive_timestamp: str | None = None,
    ) -> FetchResult:
        raise NotImplementedError

    async def discover_urls(
        self,
        client: httpx.AsyncClient,
        seeds: list[str],
        *,
        max_urls: int = 1000,
    ) -> list[str]:
        return []

    async def close(self) -> None:
        return None
