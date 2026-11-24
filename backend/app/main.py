"""MyDimension backend entry point.

Run from ``backend/`` (the directory containing this ``app`` package) as::

    uvicorn app.main:app --reload

or::

    python -m app.main

Both work because all imports inside the package are relative.

The app serves only JSON APIs -- no secrets are ever served. Private
routes are protected by ``require_admin``; ``GET /health`` is public
so hosting / monitoring can check the service is up.
"""
from __future__ import annotations

import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .api import routes_ai, routes_auth, routes_calendar, routes_entries, routes_media
from .core.config import settings
from .services.database_manager import db_manager

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("mydimension")

app = FastAPI(title="MyDimension", version="1.0.0",
              description="Private single-owner AI diary and memory vault.")

# CORS: only the configured frontend origin may call the API from a browser.
# Session cookies are sent cross-origin only with credentials allowed.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.frontend_origin],
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE"],
    allow_headers=["*"],
)

# NOTE on sessions: this app uses a signed HttpOnly session cookie
# (see core/security.py). No server-side session store is needed; the
# cookie itself is signed and verified on every protected request.


@app.on_event("startup")
def on_startup() -> None:
    """Initialise the PostgreSQL schema when a DATABASE_URL is configured.

    Failures are logged, not fatal: the app still starts so the owner
    sees a friendly error instead of a crashed service.
    """
    try:
        db_manager.init_schema()
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning("Startup schema initialisation skipped: %s", exc)


@app.get("/health")
def health():
    """Public liveness check. Returns storage mode, never any secret."""
    return {
        "status": "ok",
        "app": "MyDimension",
        "storage": "postgresql" if db_manager.using_postgres else "dev-fallback (in-memory, not production persistence)",
        "ai_configured": bool(settings.gemini_api_key),
        "drive_configured": bool(settings.google_client_id),
    }


@app.exception_handler(Exception)
async def friendly_error_handler(_request, exc: Exception):  # noqa: ANN001
    """Catch-all: friendly JSON, never a stack trace or secret in the response."""
    logger.exception("Unhandled error: %s", type(exc).__name__)
    return JSONResponse(status_code=500,
                        content={"detail": "Something went wrong. Please try again."})


app.include_router(routes_auth.router)
app.include_router(routes_entries.router)
app.include_router(routes_media.router)
app.include_router(routes_ai.router)
app.include_router(routes_calendar.router)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app.main:app", host="0.0.0.0", port=8000, reload=True)
