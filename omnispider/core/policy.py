from __future__ import annotations

import asyncio
import hashlib
import json
import re
import time
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from urllib.parse import urljoin, urlparse, urlunparse
from urllib.robotparser import RobotFileParser

import httpx
import structlog

from omnispider.core.config import AppConfig
from omnispider.core.models import EngineType, FetchResult, PageSource

log = structlog.get_logger()


def normalize_url(url: str) -> str:
    parsed = urlparse(url.strip())
    scheme = parsed.scheme.lower()
    netloc = parsed.netloc.lower()
    path = parsed.path or "/"
    if path != "/" and path.endswith("/"):
        path = path.rstrip("/")
    return urlunparse((scheme, netloc, path, "", parsed.query, ""))


def domain_of(url: str) -> str:
    return urlparse(url).netloc.lower()


def is_same_domain(url: str, base: str) -> bool:
    return domain_of(url) == domain_of(base)


class RateLimiter:
    def __init__(self, requests_per_second: float) -> None:
        self._interval = 1.0 / max(requests_per_second, 0.1)
        self._last_request: dict[str, float] = defaultdict(float)
        self._lock = asyncio.Lock()

    async def acquire(self, host: str) -> None:
        async with self._lock:
            now = time.monotonic()
            elapsed = now - self._last_request[host]
            if elapsed < self._interval:
                await asyncio.sleep(self._interval - elapsed)
            self._last_request[host] = time.monotonic()


class RobotsCache:
    def __init__(self, user_agent: str, timeout: float) -> None:
        self._user_agent = user_agent
        self._timeout = timeout
        self._parsers: dict[str, RobotFileParser | None] = {}
        self._lock = asyncio.Lock()

    async def allowed(self, client: httpx.AsyncClient, url: str) -> bool:
        host = domain_of(url)
        async with self._lock:
            if host not in self._parsers:
                self._parsers[host] = await self._fetch_parser(client, host)
            parser = self._parsers[host]
        if parser is None:
            return True
        return parser.can_fetch(self._user_agent, url)

    async def _fetch_parser(self, client: httpx.AsyncClient, host: str) -> RobotFileParser | None:
        robots_url = f"https://{host}/robots.txt"
        try:
            response = await client.get(robots_url, timeout=self._timeout, follow_redirects=True)
            if response.status_code >= 400:
                return None
            parser = RobotFileParser()
            parser.parse(response.text.splitlines())
            return parser
        except Exception as exc:
            log.debug("robots_fetch_failed", host=host, error=str(exc))
            return None


class CrawlPolicy:
    def __init__(self, config: AppConfig) -> None:
        self._config = config
        self._rate_limiter = RateLimiter(config.policy.rate_limit_per_host)
        self._robots = RobotsCache(
            config.orchestrator.user_agent,
            config.orchestrator.request_timeout_seconds,
        )

    async def preflight(
        self,
        client: httpx.AsyncClient,
        url: str,
        *,
        allowed_domains: list[str] | None,
        seed_url: str,
    ) -> tuple[bool, str | None]:
        parsed = urlparse(url)
        if parsed.scheme not in self._config.policy.allowed_schemes:
            return False, "scheme_not_allowed"
        host = parsed.netloc.lower()
        if host in self._config.policy.blocked_domains:
            return False, "domain_blocked"
        if allowed_domains and not any(host == d or host.endswith(f".{d}") for d in allowed_domains):
            if not self._config.policy.follow_external_links:
                return False, "external_domain"
            if allowed_domains and not is_same_domain(url, seed_url):
                return False, "domain_not_allowed"
        if self._config.policy.respect_robots_txt:
            if not await self._robots.allowed(client, url):
                return False, "robots_disallowed"
        await self._rate_limiter.acquire(host)
        return True, None

    def select_engine(
        self,
        *,
        requested: EngineType,
        js_rendering: bool,
        source: PageSource,
    ) -> EngineType:
        if requested != EngineType.AUTO:
            return requested
        if source in (PageSource.WAYBACK, PageSource.COMMON_CRAWL):
            return EngineType.ARCHIVE
        if js_rendering:
            return EngineType(self._config.engines.routing.js_heavy)
        return EngineType(self._config.engines.default)


_JS_HINTS = re.compile(
    r"(react|angular|vue|next\.js|nuxt|__NEXT_DATA__|window\.__INITIAL_STATE__)",
    re.IGNORECASE,
)


def needs_js_rendering(html: str) -> bool:
    if len(html) < 500:
        return True
    text = html[:50000]
    if "<noscript" in text.lower() and len(re.findall(r"<a\s+href=", text, re.I)) < 3:
        return True
    return bool(_JS_HINTS.search(text))


def content_hash(body: bytes) -> str:
    return hashlib.sha256(body).hexdigest()


def save_content(content_dir: Path, url: str, body: bytes) -> str:
    digest = content_hash(body)
    shard = digest[:2]
    target_dir = content_dir / shard
    target_dir.mkdir(parents=True, exist_ok=True)
    path = target_dir / f"{digest}.html"
    path.write_bytes(body)
    return str(path)


def extract_title(html: str) -> str | None:
    match = re.search(r"<title[^>]*>([^<]+)</title>", html, re.IGNORECASE)
    return match.group(1).strip() if match else None


def serialize_fetch_result(result: FetchResult) -> dict:
    return {
        "url": result.url,
        "final_url": result.final_url,
        "status_code": result.status_code,
        "content_type": result.content_type,
        "engine": result.engine.value,
        "source": result.source.value,
        "archive_timestamp": result.archive_timestamp,
        "error": result.error,
        "body_size": len(result.body),
    }


def load_json_lines(path: Path) -> list[dict]:
    if not path.exists():
        return []
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line:
            rows.append(json.loads(line))
    return rows


def absolute_url(base: str, link: str) -> str | None:
    if not link or link.startswith(("#", "mailto:", "javascript:", "tel:", "data:")):
        return None
    joined = urljoin(base, link)
    parsed = urlparse(joined)
    if parsed.scheme not in ("http", "https"):
        return None
    return normalize_url(joined)
