<div align="center">

# Omnispider

### All-in-one web spider orchestrator for the full digital surface

**Live web · JavaScript rendering · Internet Archive · Global discovery · Multi-engine routing**

<br/>

[![Python 3.11+](https://img.shields.io/badge/python-3.11+-0f172a?style=for-the-badge&logo=python&logoColor=fbbf24)](https://www.python.org/)
[![FastAPI](https://img.shields.io/badge/api-FastAPI-1e293b?style=for-the-badge&logo=fastapi&logoColor=22d3ee)](https://fastapi.tiangolo.com/)
[![License: MIT](https://img.shields.io/badge/license-MIT-14532d?style=for-the-badge)](LICENSE)
[![Status](https://img.shields.io/badge/status-active-166534?style=for-the-badge)](https://github.com/houseofasher/web-crawlers)

<br/>

[Quick Start](#-quick-start) · [Architecture](#-architecture) · [Workflows](#-workflow-logic) · [Engines](#-engine-matrix) · [API](#-rest-api) · [Config](#-configuration)

</div>

---

## Overview

**Omnispider** is a unified crawl orchestrator that routes every request through policy, discovery, and the best engine for the job — static HTTP, browser rendering, archival snapshots, or fast link discovery.

It synthesizes patterns from 12 crawler ecosystems (Scrapy, Playwright, Puppeteer, Crawlee, Colly, Katana, Splash, MechanicalSoup, Portia, Heritrix3, Nutch, StormCrawler) into one pipeline with a CLI, REST API, and persistent frontier.

<table>
<tr>
<td width="33%" align="center">

**Temporal**
<br/><br/>
Wayback Machine CDX
<br/>
Historical snapshots
<br/>
Past → present

</td>
<td width="33%" align="center">

**Spatial**
<br/><br/>
Sitemaps · robots.txt
<br/>
Global seeds · ccTLD
<br/>
Four corners of the web

</td>
<td width="33%" align="center">

**Surface**
<br/><br/>
Static HTML · JS apps
<br/>
Forms · feeds · archives
<br/>
Every page type

</td>
</tr>
</table>

> **Scope note:** Omnispider maximizes *reachable* public coverage ethically — respecting `robots.txt`, rate limits, and domain policy. No crawler can fetch every page ever published; deleted, private, and auth-gated content remains out of scope.

---

## Architecture

```mermaid
flowchart TB
    subgraph INPUT["Input Layer"]
        SEEDS["Seed URLs"]
        GLOBAL["Global Seeds / ccTLD"]
        SITEMAP["Sitemap / robots.txt"]
        ARCHIVE_SEED["Wayback CDX Snapshots"]
    end

    subgraph CORE["Omnispider Core"]
        FRONTIER["Frontier Queue<br/><i>SQLite · priority · depth</i>"]
        POLICY["Policy Gate<br/><i>robots.txt · rate limit · domain</i>"]
        ROUTER["Engine Router<br/><i>auto · http · playwright · archive</i>"]
    end

    subgraph ENGINES["Engine Layer"]
        HTTP["HTTP Engine"]
        PW["Playwright"]
        ARC["Archive / Wayback"]
        KAT["Katana Discovery"]
        SPL["Splash Sidecar"]
        MECH["MechanicalSoup"]
        SCR["Scrapy Batch"]
    end

    subgraph OUTPUT["Output Layer"]
        STORE["SQLite + Content Store"]
        LINKS["Link Extractor"]
        API["REST API / CLI"]
    end

    SEEDS --> FRONTIER
    GLOBAL --> FRONTIER
    SITEMAP --> FRONTIER
    ARCHIVE_SEED --> FRONTIER

    FRONTIER --> POLICY
    POLICY --> ROUTER

    ROUTER --> HTTP
    ROUTER --> PW
    ROUTER --> ARC
    ROUTER --> KAT
    ROUTER --> SPL
    ROUTER --> MECH
    ROUTER --> SCR

    HTTP --> STORE
    PW --> STORE
    ARC --> STORE
    SPL --> STORE
    MECH --> STORE

    STORE --> LINKS
    LINKS -->|"expand frontier"| FRONTIER
    STORE --> API
```

---

## Workflow logic

### End-to-end crawl lifecycle

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant CLI as CLI / API
    participant ORCH as Orchestrator
    participant DISC as Discovery
    participant FR as Frontier
    participant POL as Policy
    participant ENG as Engine
    participant DB as Storage

    User->>CLI: crawl / POST /v1/jobs
    CLI->>ORCH: submit_job(seeds, depth, limits)
    ORCH->>DISC: sitemaps · robots · katana · wayback
    DISC->>FR: enqueue seed URLs
    loop Until max_pages or frontier empty
        FR->>POL: pop next URL
        POL->>POL: robots.txt + rate limit + domain
        alt blocked
            POL-->>FR: skip
        else allowed
            POL->>ENG: route engine (auto/http/playwright/archive)
            ENG->>ENG: fetch + render if needed
            ENG->>DB: save page + metadata
            DB->>FR: extract links → enqueue children
        end
    end
    ORCH->>CLI: job completed
    CLI->>User: pages crawled / failed
```

### Engine auto-routing decision tree

```mermaid
flowchart TD
    START(["Incoming URL"]) --> SOURCE{Source type?}

    SOURCE -->|Wayback / Archive| ARC["Archive Engine"]
    SOURCE -->|Live web| JS{JS rendering forced?}

    JS -->|Yes| PW["Playwright Engine"]
    JS -->|No| FETCH["HTTP Engine"]

    FETCH --> CHECK{Response OK?}
    CHECK -->|No| PW
    CHECK -->|Yes| HEUR{Page needs JS?}

    HEUR -->|Yes| PW
    HEUR -->|No| DONE(["Store + extract links"])

    PW --> DONE
    ARC --> DONE

    style START fill:#0f172a,color:#e2e8f0,stroke:#334155
    style DONE fill:#14532d,color:#ecfdf5,stroke:#166534
    style ARC fill:#1e3a5f,color:#dbeafe,stroke:#2563eb
    style PW fill:#3b0764,color:#f3e8ff,stroke:#9333ea
    style FETCH fill:#1e293b,color:#e2e8f0,stroke:#475569
```

### Discovery pipeline

```mermaid
flowchart LR
    S["Seed URL"] --> R["robots.txt"]
    S --> M["sitemap.xml"]
    S --> K["Katana binary"]
    S --> W["Wayback CDX"]

    R --> F["Unified Frontier"]
    M --> F
    K --> F
    W --> F

    F --> C["Concurrent Workers"]
    C --> P["Policy Gate"]
    P --> E["Engine Fetch"]
    E --> X["Link Extraction"]
    X --> F
```

---

## Engine matrix

| Engine | Best for | Vendor inspiration | Install |
|--------|----------|-------------------|---------|
| `http` | Static pages, APIs, feeds | Scrapy · Colly | built-in |
| `playwright` | SPAs, React, Vue, Next.js | Playwright · Puppeteer | `pip install -e ".[browser]"` |
| `archive` | Historical snapshots | Heritrix · Internet Archive | built-in |
| `katana` | Fast link discovery | Katana · Colly | [Install Katana](https://github.com/projectdiscovery/katana) |
| `splash` | JS render sidecar | Splash | run Splash on `:8050` |
| `mechanical` | Forms, sessions | MechanicalSoup | `pip install -e ".[forms]"` |
| `scrapy` | Batch spider projects | Scrapy · Portia | `pip install -e ".[scrapy]"` |
| `auto` | Smart routing (default) | Crawlee patterns | built-in |

Reference vendor trees can be extracted locally — see [`vendors/README.md`](vendors/README.md).

---

## Quick start

### 1 · Install

```bash
git clone https://github.com/houseofasher/web-crawlers.git
cd web-crawlers

python -m venv .venv
source .venv/bin/activate        # macOS / Linux
# .venv\Scripts\activate         # Windows

pip install -e .
```

### 2 · Crawl

```bash
# Live web + sitemaps + Wayback snapshots
omnispider crawl https://example.com --depth 3 --max-pages 500

# Skip archive layer
omnispider crawl https://example.com --no-archive

# Force JavaScript rendering
omnispider crawl https://example.com --js
```

### 3 · Discover & archive

```bash
# Fast URL discovery (sitemaps + Katana when installed)
omnispider discover https://example.com --max 200

# List Wayback Machine snapshots for a URL
omnispider archive https://example.com
```

### 4 · Serve API

```bash
omnispider serve --port 8080
# → http://127.0.0.1:8080/health
```

### Optional power-ups

```bash
pip install -e ".[browser]" && playwright install chromium   # JS rendering
pip install -e ".[forms]"                                       # form crawling
pip install -e ".[scrapy]"                                        # Scrapy adapter
pip install -e ".[dev]" && pytest                               # run tests
```

---

## REST API

```bash
# Start a crawl job
curl -X POST http://127.0.0.1:8080/v1/jobs \
  -H "Content-Type: application/json" \
  -d '{
    "seeds": ["https://example.com"],
    "max_depth": 3,
    "max_pages": 100,
    "include_archive": true,
    "js_rendering": false
  }'

# Poll job status
curl http://127.0.0.1:8080/v1/jobs/{job_id}

# List crawled pages
curl "http://127.0.0.1:8080/v1/jobs/{job_id}/pages?limit=50"
```

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/health` | Service health |
| `POST` | `/v1/jobs` | Create crawl job |
| `GET` | `/v1/jobs` | List jobs |
| `GET` | `/v1/jobs/{id}` | Job status |
| `GET` | `/v1/jobs/{id}/pages` | Paginated page results |
| `GET` | `/v1/engines` | Engine catalog |

---

## Configuration

Edit [`config/default.yaml`](config/default.yaml):

```yaml
orchestrator:
  max_concurrency: 16
  max_depth: 5
  max_pages_per_job: 10000

policy:
  respect_robots_txt: true
  rate_limit_per_host: 2.0

archive:
  enabled: true

discovery:
  sitemap: true
  global_seeds:
    - "https://www.wikipedia.org/"

storage:
  database_path: "./data/omnispider.db"
  content_dir: "./data/content"
```

---

## Project layout

```
web-crawlers/
├── omnispider/
│   ├── cli.py              # Typer CLI
│   ├── api.py              # FastAPI server
│   ├── core/
│   │   ├── orchestrator.py # Main crawl loop
│   │   ├── frontier.py     # URL queue (SQLite)
│   │   ├── storage.py      # Jobs + pages persistence
│   │   └── policy.py       # robots.txt + rate limits
│   ├── engines/            # HTTP, Playwright, Archive, Katana…
│   └── discovery/          # Sitemaps, link extraction
├── config/default.yaml
├── tests/
└── vendors/                # Optional local reference trees
```

---

## Data output

| Artifact | Location | Contents |
|----------|----------|----------|
| Job store | `./data/omnispider.db` | Jobs, frontier, page metadata |
| HTML shards | `./data/content/` | SHA-256 sharded page bodies |
| Logs | stdout (structlog) | Structured JSON-ish events |

---

## Repositories

This project is maintained at:

- [github.com/houseofasher/web-crawlers](https://github.com/houseofasher/web-crawlers)
- [github.com/shep95/web-crawlers](https://github.com/shep95/web-crawlers)

---

## License

MIT — see [LICENSE](LICENSE).
