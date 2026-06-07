from __future__ import annotations

import asyncio
import json
import shutil
import tempfile
from pathlib import Path

import httpx
import structlog

from omnispider.core.config import AppConfig
from omnispider.core.models import EngineType, FetchResult, PageSource
from omnispider.engines.base import BaseEngine

log = structlog.get_logger()


class ScrapyEngine(BaseEngine):
    """Run exported Scrapy spiders as subprocess jobs (Scrapy / Portia export compatible)."""

    engine_type = EngineType.SCRAPY

    async def run_spider(
        self,
        project_dir: Path,
        spider_name: str,
        *,
        output_path: Path | None = None,
    ) -> Path:
        if not shutil.which("scrapy"):
            raise RuntimeError("Scrapy not installed. Run: pip install omnispider[scrapy]")

        out = output_path or Path(tempfile.mkdtemp()) / "items.jsonl"
        out.parent.mkdir(parents=True, exist_ok=True)
        cmd = [
            "scrapy",
            "crawl",
            spider_name,
            "-O",
            str(out),
        ]
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            cwd=str(project_dir),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _, stderr = await proc.communicate()
        if proc.returncode != 0:
            raise RuntimeError(stderr.decode("utf-8", errors="replace"))
        return out

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
            error="scrapy_runs_as_batch_spider_not_single_fetch",
        )


class EngineRegistry:
    def __init__(self, config: AppConfig) -> None:
        from omnispider.engines.archive_engine import ArchiveEngine
        from omnispider.engines.browser_engines import (
            KatanaEngine,
            MechanicalEngine,
            PlaywrightEngine,
            SplashEngine,
        )
        from omnispider.engines.http_engine import HttpEngine

        self._engines: dict[EngineType, BaseEngine] = {
            EngineType.HTTP: HttpEngine(config),
            EngineType.ARCHIVE: ArchiveEngine(config),
            EngineType.PLAYWRIGHT: PlaywrightEngine(config),
            EngineType.KATANA: KatanaEngine(config),
            EngineType.SPLASH: SplashEngine(config),
            EngineType.MECHANICAL: MechanicalEngine(config),
            EngineType.SCRAPY: ScrapyEngine(config),
        }

    def get(self, engine_type: EngineType) -> BaseEngine:
        return self._engines[engine_type]

    async def close_all(self) -> None:
        for engine in self._engines.values():
            await engine.close()
