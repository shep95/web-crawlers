from __future__ import annotations

import uuid
from contextlib import asynccontextmanager
from typing import Annotated

import structlog
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import JSONResponse

from omnispider.core.config import load_config
from omnispider.core.models import (
    CrawlJobSpec,
    CrawlStatus,
    ErrorEnvelope,
    JobCreateRequest,
    JobResponse,
    PageRecord,
)
from omnispider.core.orchestrator import Orchestrator

log = structlog.get_logger()
_cfg = load_config()
_orchestrator: Orchestrator | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _orchestrator
    _orchestrator = Orchestrator(_cfg)
    await _orchestrator.initialize()
    log.info("api_started")
    yield
    if _orchestrator:
        await _orchestrator.shutdown()
    log.info("api_stopped")


app = FastAPI(
    title="Omnispider API",
    version="0.1.0",
    description="Unified web spider orchestrator — live web, archives, multi-engine",
    lifespan=lifespan,
)


@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException):
    correlation_id = request.headers.get("X-Correlation-ID", str(uuid.uuid4()))
    envelope = ErrorEnvelope(
        error=str(exc.detail),
        correlation_id=correlation_id,
    )
    return JSONResponse(status_code=exc.status_code, content=envelope.model_dump())


def _orch() -> Orchestrator:
    if _orchestrator is None:
        raise HTTPException(status_code=503, detail="Orchestrator not initialized")
    return _orchestrator


def _job_response(job) -> JobResponse:
    return JobResponse(
        id=job.id,
        status=job.status,
        pages_crawled=job.pages_crawled,
        pages_failed=job.pages_failed,
        created_at=job.created_at,
        started_at=job.started_at,
        finished_at=job.finished_at,
        error=job.error,
    )


@app.get("/health")
async def health() -> dict:
    return {"status": "ok", "service": "omnispider", "version": "0.1.0"}


@app.post("/v1/jobs", response_model=JobResponse, status_code=202)
async def create_job(body: JobCreateRequest) -> JobResponse:
    spec = CrawlJobSpec(
        seeds=[str(s) for s in body.seeds],
        engine=body.engine,
        max_depth=body.max_depth,
        max_pages=body.max_pages,
        include_archive=body.include_archive,
        include_sitemaps=body.include_sitemaps,
        js_rendering=body.js_rendering,
        allowed_domains=body.allowed_domains,
    )
    job = await _orch().submit_job(spec)
    return _job_response(job)


@app.get("/v1/jobs", response_model=list[JobResponse])
async def list_jobs(limit: Annotated[int, Query(ge=1, le=200)] = 50) -> list[JobResponse]:
    jobs = await _orch().list_jobs(limit)
    return [_job_response(j) for j in jobs]


@app.get("/v1/jobs/{job_id}", response_model=JobResponse)
async def get_job(job_id: str) -> JobResponse:
    job = await _orch().get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return _job_response(job)


@app.get("/v1/jobs/{job_id}/pages", response_model=list[PageRecord])
async def get_job_pages(
    job_id: str,
    limit: Annotated[int, Query(ge=1, le=500)] = 100,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> list[PageRecord]:
    job = await _orch().get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return await _orch().list_pages(job_id, limit, offset)


@app.get("/v1/engines")
async def list_engines() -> dict:
    return {
        "engines": [
            {"id": "http", "description": "Native async HTTP crawler"},
            {"id": "playwright", "description": "JavaScript rendering via Playwright"},
            {"id": "archive", "description": "Internet Archive Wayback Machine"},
            {"id": "katana", "description": "Fast Go-based link discovery"},
            {"id": "splash", "description": "Splash JS render sidecar"},
            {"id": "mechanical", "description": "MechanicalSoup form crawler"},
            {"id": "scrapy", "description": "Scrapy batch spider adapter"},
            {"id": "auto", "description": "Automatic engine routing"},
        ],
        "vendors_path": _cfg.vendors.path,
    }
