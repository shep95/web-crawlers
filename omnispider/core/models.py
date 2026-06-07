from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Any

from pydantic import BaseModel, Field, HttpUrl


class EngineType(str, Enum):
    HTTP = "http"
    PLAYWRIGHT = "playwright"
    MECHANICAL = "mechanical"
    ARCHIVE = "archive"
    KATANA = "katana"
    SPLASH = "splash"
    SCRAPY = "scrapy"
    AUTO = "auto"


class PageSource(str, Enum):
    LIVE = "live"
    WAYBACK = "wayback"
    COMMON_CRAWL = "common_crawl"
    SITEMAP = "sitemap"
    SEED = "seed"


class CrawlStatus(str, Enum):
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


class CrawlJobSpec(BaseModel):
    seeds: list[str] = Field(min_length=1)
    engine: EngineType = EngineType.AUTO
    max_depth: int = Field(default=3, ge=0, le=50)
    max_pages: int = Field(default=1000, ge=1, le=1_000_000)
    include_archive: bool = True
    include_sitemaps: bool = True
    js_rendering: bool = False
    allowed_domains: list[str] | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class CrawlJob(CrawlJobSpec):
    id: str
    status: CrawlStatus = CrawlStatus.PENDING
    created_at: datetime = Field(default_factory=datetime.utcnow)
    started_at: datetime | None = None
    finished_at: datetime | None = None
    pages_crawled: int = 0
    pages_failed: int = 0
    error: str | None = None


class PageRecord(BaseModel):
    url: str
    final_url: str | None = None
    status_code: int | None = None
    content_type: str | None = None
    title: str | None = None
    depth: int = 0
    source: PageSource = PageSource.LIVE
    engine: EngineType = EngineType.HTTP
    fetched_at: datetime = Field(default_factory=datetime.utcnow)
    content_path: str | None = None
    content_hash: str | None = None
    links_found: int = 0
    archive_timestamp: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class FetchResult(BaseModel):
    url: str
    final_url: str
    status_code: int
    headers: dict[str, str] = Field(default_factory=dict)
    body: bytes = b""
    content_type: str | None = None
    engine: EngineType = EngineType.HTTP
    source: PageSource = PageSource.LIVE
    archive_timestamp: str | None = None
    error: str | None = None

    @property
    def ok(self) -> bool:
        return 200 <= self.status_code < 400 and self.error is None


class FrontierEntry(BaseModel):
    url: str
    depth: int = 0
    source: PageSource = PageSource.LIVE
    priority: int = 0
    archive_timestamp: str | None = None


class JobCreateRequest(BaseModel):
    seeds: list[HttpUrl]
    engine: EngineType = EngineType.AUTO
    max_depth: int = Field(default=3, ge=0, le=50)
    max_pages: int = Field(default=1000, ge=1, le=1_000_000)
    include_archive: bool = True
    include_sitemaps: bool = True
    js_rendering: bool = False
    allowed_domains: list[str] | None = None


class JobResponse(BaseModel):
    id: str
    status: CrawlStatus
    pages_crawled: int
    pages_failed: int
    created_at: datetime
    started_at: datetime | None = None
    finished_at: datetime | None = None
    error: str | None = None


class ErrorEnvelope(BaseModel):
    error: str
    detail: str | None = None
    correlation_id: str | None = None
