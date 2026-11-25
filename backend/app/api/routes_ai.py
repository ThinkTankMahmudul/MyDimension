"""Gemini AI routes: mood suggestion, summary, writing help, transcription.

Only the text/audio a verified user explicitly sends here is passed to Gemini.
These routes carry no per-user data, so only the auth guard changes.
If Gemini is not configured, these return a friendly 503 (via
``AINotConfiguredError``) -- never a 500 crash, and the owner's original
text is never overwritten by AI output.
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status

from ..core.config import GEMINI_MODEL
from ..core.security import require_user
from ..schemas.schemas import AIRequest, AIResponse
from ..services.ai_service import (
    AINotConfiguredError,
    OfflineAIService,
    TRANSCRIBE_LANGUAGES,
    get_ai_service,
)

logger = logging.getLogger("mydimension.ai.routes")

router = APIRouter(prefix="/api/ai", tags=["ai"])


@router.get("/status")
def ai_status(_user: dict = Depends(require_user)):
    """Real AI status: configured AND reachable.

    The old status line only checked that a key exists, so it said
    "ready" while every call failed. This makes one cheap model-metadata
    call (no generation, no tokens) and reports the truth.
    """
    service = get_ai_service()
    if isinstance(service, OfflineAIService):
        return {"configured": False, "reachable": False, "model": GEMINI_MODEL}
    return {"configured": True, "reachable": service.check_connection(),
            "model": GEMINI_MODEL}


def _run(task: str, payload: AIRequest) -> AIResponse:
    try:
        result = get_ai_service().process_text(payload.text, task)
    except AINotConfiguredError as exc:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                            detail=str(exc)) from exc
    except Exception as exc:
        # Log the real Gemini failure (key/model/network) — without this
        # the 502 below hides the cause and Vercel logs show nothing.
        logger.exception("Gemini %s failed: %s: %s", task, type(exc).__name__, exc)
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY,
                            detail="The AI service could not be reached. Please try again.") from exc
    note = "AI suggestion only -- not a fact or a diagnosis." if task == "mood" else None
    return AIResponse(result=result, note=note)


@router.post("/mood", response_model=AIResponse)
def ai_mood(payload: AIRequest, _user: dict = Depends(require_user)):
    return _run("mood", payload)


@router.post("/summary", response_model=AIResponse)
def ai_summary(payload: AIRequest, _user: dict = Depends(require_user)):
    return _run("summary", payload)


@router.post("/improve", response_model=AIResponse)
def ai_improve(payload: AIRequest, _user: dict = Depends(require_user)):
    return _run("improve", payload)


@router.post("/transcribe", response_model=AIResponse)
async def ai_transcribe(file: UploadFile = File(...),
                        language: str = Form("auto"),
                        _user: dict = Depends(require_user)):
    if not (file.content_type or "").startswith("audio/"):
        raise HTTPException(status_code=400, detail="Please upload an audio file.")
    if language not in TRANSCRIBE_LANGUAGES:
        raise HTTPException(status_code=400,
                            detail="language must be auto, bn or en.")
    data = await file.read()
    if len(data) > 25 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="Audio file is too large (max 25 MB).")
    try:
        result = get_ai_service().transcribe_audio(
            data, file.content_type or "audio/mpeg", language)
    except AINotConfiguredError as exc:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                            detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("Gemini transcribe failed: %s: %s", type(exc).__name__, exc)
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY,
                            detail="The AI service could not be reached. Please try again.") from exc
    return AIResponse(result=result, note="Please review the transcript before saving it.")
