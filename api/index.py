"""Vercel entrypoint for the MyDimension FastAPI backend.

Vercel's Python runtime loads the app from a supported entrypoint
file. The FastAPI app itself lives in ``backend/app/main.py`` so the
project stays clean for local development; this thin file only adds
``backend/`` to ``sys.path`` and re-exports that app as ``app``.

Vercel docs (frameworks/backend/fastapi): a FastAPI app is detected
from an entrypoint file, and ``vercel.json`` can set ``maxDuration``.
No secrets are read here.
"""
from __future__ import annotations

import os
import sys

# ``backend/`` is the directory containing the ``app`` package.
_BACKEND_DIR = os.path.join(os.path.dirname(__file__), "..", "backend")
_BACKEND_DIR = os.path.normpath(_BACKEND_DIR)
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

from app.main import app  # noqa: E402,F401  (re-exported for Vercel)

__all__ = ["app"]
