from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from urllib.parse import urljoin, urlparse

import httpx
import structlog
from bs4 import BeautifulSoup

from omnispider.core.policy import absolute_url, normalize_url

log = structlog.get_logger()

_SITEMAP_NS = {"sm": "http://www.sitemaps.org/schemas/sitemap/0.9"}


async def fetch_text(client: httpx.AsyncClient, url: str, timeout: float, user_agent: str) -> str | None:
    try:
        response = await client.get(
            url,
            timeout=timeout,
            follow_redirects=True,
            headers={"User-Agent": user_agent},
        )
        if response.status_code >= 400:
            return None
        return response.text
    except Exception as exc:
        log.debug("fetch_text_failed", url=url, error=str(exc))
        return None


def _parse_sitemap_xml(content: str, base_url: str) -> tuple[list[str], list[str]]:
    page_urls: list[str] = []
    sitemap_urls: list[str] = []
    try:
        root = ET.fromstring(content)
    except ET.ParseError:
        return page_urls, sitemap_urls

    tag = root.tag.lower()
    if tag.endswith("sitemapindex"):
        for loc in root.findall(".//sm:sitemap/sm:loc", _SITEMAP_NS):
            if loc.text:
                sitemap_urls.append(normalize_url(loc.text.strip()))
        for loc in root.findall(".//{*}sitemap/{*}loc"):
            if loc.text:
                sitemap_urls.append(normalize_url(loc.text.strip()))
    elif tag.endswith("urlset"):
        for loc in root.findall(".//sm:url/sm:loc", _SITEMAP_NS):
            if loc.text:
                page_urls.append(normalize_url(loc.text.strip()))
        for loc in root.findall(".//{*}url/{*}loc"):
            if loc.text:
                page_urls.append(normalize_url(loc.text.strip()))
    return page_urls, sitemap_urls


async def discover_sitemap_urls(
    client: httpx.AsyncClient,
    seed: str,
    *,
    timeout: float,
    user_agent: str,
    max_urls: int = 5000,
) -> list[str]:
    parsed = urlparse(seed)
    candidates = [
        f"{parsed.scheme}://{parsed.netloc}/sitemap.xml",
        f"{parsed.scheme}://{parsed.netloc}/sitemap_index.xml",
        urljoin(seed, "/sitemap.xml"),
    ]
    discovered: list[str] = []
    seen_sitemaps: set[str] = set()
    queue = list(dict.fromkeys(candidates))

    while queue and len(discovered) < max_urls:
        sitemap_url = queue.pop(0)
        if sitemap_url in seen_sitemaps:
            continue
        seen_sitemaps.add(sitemap_url)
        content = await fetch_text(client, sitemap_url, timeout, user_agent)
        if not content:
            continue
        pages, nested = _parse_sitemap_xml(content, seed)
        discovered.extend(pages)
        queue.extend(n for n in nested if n not in seen_sitemaps)

    return list(dict.fromkeys(discovered))[:max_urls]


async def discover_robots_sitemaps(
    client: httpx.AsyncClient,
    seed: str,
    *,
    timeout: float,
    user_agent: str,
) -> list[str]:
    parsed = urlparse(seed)
    robots_url = f"{parsed.scheme}://{parsed.netloc}/robots.txt"
    text = await fetch_text(client, robots_url, timeout, user_agent)
    if not text:
        return []
    sitemaps: list[str] = []
    for line in text.splitlines():
        if line.lower().startswith("sitemap:"):
            url = line.split(":", 1)[1].strip()
            sitemaps.append(normalize_url(url))
    return sitemaps


def extract_links(html: str, base_url: str) -> list[str]:
    soup = BeautifulSoup(html, "lxml")
    links: list[str] = []
    for tag in soup.find_all("a", href=True):
        absolute = absolute_url(base_url, tag["href"])
        if absolute:
            links.append(absolute)
    for tag in soup.find_all(["link", "script", "img", "iframe"], href=True):
        absolute = absolute_url(base_url, tag.get("href") or tag.get("src", ""))
        if absolute:
            links.append(absolute)
    for tag in soup.find_all("script", src=True):
        absolute = absolute_url(base_url, tag["src"])
        if absolute:
            links.append(absolute)
    return list(dict.fromkeys(links))


def extract_feed_links(html: str, base_url: str) -> list[str]:
    soup = BeautifulSoup(html, "lxml")
    feeds: list[str] = []
    for tag in soup.find_all("link", rel=True, href=True):
        rel = " ".join(tag.get("rel", [])).lower()
        if "alternate" in rel or "feed" in rel:
            absolute = absolute_url(base_url, tag["href"])
            if absolute:
                feeds.append(absolute)
    return feeds


# ccTLD seeds for global digital realm coverage (sample set; extend via config)
GLOBAL_CCTLD_SEEDS = [
    "https://www.google.com/",
    "https://www.baidu.com/",
    "https://www.yandex.ru/",
    "https://www.wikipedia.org/",
    "https://archive.org/",
]
