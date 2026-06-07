from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

import aiosqlite
import structlog

from omnispider.core.config import AppConfig
from omnispider.core.models import (
    CrawlJob,
    CrawlStatus,
    EngineType,
    FrontierEntry,
    PageRecord,
    PageSource,
)

log = structlog.get_logger()

SCHEMA = """
CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    spec_json TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    pages_crawled INTEGER DEFAULT 0,
    pages_failed INTEGER DEFAULT 0,
    error TEXT
);

CREATE TABLE IF NOT EXISTS frontier (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL,
    url TEXT NOT NULL,
    depth INTEGER NOT NULL,
    source TEXT NOT NULL,
    priority INTEGER DEFAULT 0,
    archive_timestamp TEXT,
    status TEXT DEFAULT 'pending',
    UNIQUE(job_id, url, archive_timestamp)
);

CREATE TABLE IF NOT EXISTS pages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL,
    url TEXT NOT NULL,
    final_url TEXT,
    status_code INTEGER,
    content_type TEXT,
    title TEXT,
    depth INTEGER,
    source TEXT,
    engine TEXT,
    fetched_at TEXT,
    content_path TEXT,
    content_hash TEXT,
    links_found INTEGER DEFAULT 0,
    archive_timestamp TEXT,
    metadata_json TEXT,
    UNIQUE(job_id, url, archive_timestamp)
);

CREATE TABLE IF NOT EXISTS visited (
    job_id TEXT NOT NULL,
    url TEXT NOT NULL,
    archive_timestamp TEXT,
    PRIMARY KEY (job_id, url, archive_timestamp)
);

CREATE INDEX IF NOT EXISTS idx_frontier_job_status ON frontier(job_id, status, priority DESC);
CREATE INDEX IF NOT EXISTS idx_pages_job ON pages(job_id);
"""


class Storage:
    def __init__(self, config: AppConfig) -> None:
        self._db_path = Path(config.storage.database_path)
        self._content_dir = Path(config.storage.content_dir)
        self._store_html = config.storage.store_html
        self._store_metadata = config.storage.store_metadata

    async def initialize(self) -> None:
        self._db_path.parent.mkdir(parents=True, exist_ok=True)
        self._content_dir.mkdir(parents=True, exist_ok=True)
        async with aiosqlite.connect(self._db_path) as db:
            await db.executescript(SCHEMA)
            await db.commit()

    async def create_job(self, job: CrawlJob) -> None:
        async with aiosqlite.connect(self._db_path) as db:
            await db.execute(
                """
                INSERT INTO jobs (id, spec_json, status, created_at, pages_crawled, pages_failed)
                VALUES (?, ?, ?, ?, 0, 0)
                """,
                (
                    job.id,
                    job.model_dump_json(),
                    job.status.value,
                    job.created_at.isoformat(),
                ),
            )
            await db.commit()

    async def update_job(self, job: CrawlJob) -> None:
        async with aiosqlite.connect(self._db_path) as db:
            await db.execute(
                """
                UPDATE jobs SET status=?, started_at=?, finished_at=?,
                pages_crawled=?, pages_failed=?, error=?
                WHERE id=?
                """,
                (
                    job.status.value,
                    job.started_at.isoformat() if job.started_at else None,
                    job.finished_at.isoformat() if job.finished_at else None,
                    job.pages_crawled,
                    job.pages_failed,
                    job.error,
                    job.id,
                ),
            )
            await db.commit()

    async def get_job(self, job_id: str) -> CrawlJob | None:
        async with aiosqlite.connect(self._db_path) as db:
            db.row_factory = aiosqlite.Row
            async with db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)) as cursor:
                row = await cursor.fetchone()
                if not row:
                    return None
                job = CrawlJob.model_validate_json(row["spec_json"])
                job.id = row["id"]
                job.status = CrawlStatus(row["status"])
                job.created_at = datetime.fromisoformat(row["created_at"])
                job.started_at = (
                    datetime.fromisoformat(row["started_at"]) if row["started_at"] else None
                )
                job.finished_at = (
                    datetime.fromisoformat(row["finished_at"]) if row["finished_at"] else None
                )
                job.pages_crawled = row["pages_crawled"]
                job.pages_failed = row["pages_failed"]
                job.error = row["error"]
                return job

    async def list_jobs(self, limit: int = 50) -> list[CrawlJob]:
        async with aiosqlite.connect(self._db_path) as db:
            db.row_factory = aiosqlite.Row
            async with db.execute(
                "SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?", (limit,)
            ) as cursor:
                rows = await cursor.fetchall()
        jobs: list[CrawlJob] = []
        for row in rows:
            job = CrawlJob.model_validate_json(row["spec_json"])
            job.id = row["id"]
            job.status = CrawlStatus(row["status"])
            job.created_at = datetime.fromisoformat(row["created_at"])
            job.started_at = (
                datetime.fromisoformat(row["started_at"]) if row["started_at"] else None
            )
            job.finished_at = (
                datetime.fromisoformat(row["finished_at"]) if row["finished_at"] else None
            )
            job.pages_crawled = row["pages_crawled"]
            job.pages_failed = row["pages_failed"]
            job.error = row["error"]
            jobs.append(job)
        return jobs

    async def enqueue_frontier(self, job_id: str, entries: list[FrontierEntry]) -> int:
        inserted = 0
        async with aiosqlite.connect(self._db_path) as db:
            for entry in entries:
                try:
                    await db.execute(
                        """
                        INSERT OR IGNORE INTO frontier
                        (job_id, url, depth, source, priority, archive_timestamp, status)
                        VALUES (?, ?, ?, ?, ?, ?, 'pending')
                        """,
                        (
                            job_id,
                            entry.url,
                            entry.depth,
                            entry.source.value,
                            entry.priority,
                            entry.archive_timestamp,
                        ),
                    )
                    inserted += db.total_changes
                except Exception as exc:
                    log.debug("frontier_enqueue_skip", url=entry.url, error=str(exc))
            await db.commit()
        return inserted

    async def pop_frontier(self, job_id: str) -> FrontierEntry | None:
        async with aiosqlite.connect(self._db_path) as db:
            db.row_factory = aiosqlite.Row
            async with db.execute(
                """
                SELECT id, url, depth, source, priority, archive_timestamp
                FROM frontier
                WHERE job_id=? AND status='pending'
                ORDER BY priority DESC, depth ASC, id ASC
                LIMIT 1
                """,
                (job_id,),
            ) as cursor:
                row = await cursor.fetchone()
                if not row:
                    return None
                await db.execute(
                    "UPDATE frontier SET status='processing' WHERE id=?", (row["id"],)
                )
                await db.commit()
                return FrontierEntry(
                    url=row["url"],
                    depth=row["depth"],
                    source=PageSource(row["source"]),
                    priority=row["priority"],
                    archive_timestamp=row["archive_timestamp"],
                )

    async def mark_frontier_done(self, job_id: str, url: str, archive_timestamp: str | None) -> None:
        async with aiosqlite.connect(self._db_path) as db:
            await db.execute(
                """
                UPDATE frontier SET status='done'
                WHERE job_id=? AND url=? AND archive_timestamp IS ?
                """,
                (job_id, url, archive_timestamp),
            )
            await db.commit()

    async def mark_visited(self, job_id: str, url: str, archive_timestamp: str | None) -> bool:
        async with aiosqlite.connect(self._db_path) as db:
            try:
                await db.execute(
                    "INSERT OR IGNORE INTO visited (job_id, url, archive_timestamp) VALUES (?, ?, ?)",
                    (job_id, url, archive_timestamp),
                )
                await db.commit()
                return db.total_changes > 0
            except Exception:
                return False

    async def save_page(self, job_id: str, page: PageRecord) -> None:
        metadata_json = json.dumps(page.metadata) if self._store_metadata else "{}"
        async with aiosqlite.connect(self._db_path) as db:
            await db.execute(
                """
                INSERT OR REPLACE INTO pages
                (job_id, url, final_url, status_code, content_type, title, depth, source,
                 engine, fetched_at, content_path, content_hash, links_found, archive_timestamp,
                 metadata_json)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    job_id,
                    page.url,
                    page.final_url,
                    page.status_code,
                    page.content_type,
                    page.title,
                    page.depth,
                    page.source.value,
                    page.engine.value,
                    page.fetched_at.isoformat(),
                    page.content_path,
                    page.content_hash,
                    page.links_found,
                    page.archive_timestamp,
                    metadata_json,
                ),
            )
            await db.commit()

    async def list_pages(self, job_id: str, limit: int = 100, offset: int = 0) -> list[PageRecord]:
        async with aiosqlite.connect(self._db_path) as db:
            db.row_factory = aiosqlite.Row
            async with db.execute(
                """
                SELECT * FROM pages WHERE job_id=?
                ORDER BY fetched_at DESC LIMIT ? OFFSET ?
                """,
                (job_id, limit, offset),
            ) as cursor:
                rows = await cursor.fetchall()
        pages: list[PageRecord] = []
        for row in rows:
            pages.append(
                PageRecord(
                    url=row["url"],
                    final_url=row["final_url"],
                    status_code=row["status_code"],
                    content_type=row["content_type"],
                    title=row["title"],
                    depth=row["depth"],
                    source=PageSource(row["source"]),
                    engine=EngineType(row["engine"]),
                    fetched_at=datetime.fromisoformat(row["fetched_at"]),
                    content_path=row["content_path"],
                    content_hash=row["content_hash"],
                    links_found=row["links_found"],
                    archive_timestamp=row["archive_timestamp"],
                    metadata=json.loads(row["metadata_json"] or "{}"),
                )
            )
        return pages

    @property
    def content_dir(self) -> Path:
        return self._content_dir

    @property
    def store_html(self) -> bool:
        return self._store_html
