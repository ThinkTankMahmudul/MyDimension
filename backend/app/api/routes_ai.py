"""Gemini AI routes: mood suggestion, summary, writing help, transcription.

Only the text/audio the owner explicitly sends here is passed to Gemini.
If Gemini is not configured, these return a friendly 503 (via
``AINotConfiguredError``) -- never a 500 crash, and the owner's original
text is never overwritten by AI output.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status

from ..core.security import require_admin
from ..schemas.schemas import AIRequest, AIResponse
from ..services.ai_service import AINotConfiguredError, get_ai_service

router = APIRouter(prefix="/api/ai", tags=["ai"])


def _run(task: str, payload: AIRequest) -> AIResponse:
    try:
        result = get_ai_service().process_text(payload.text, task)
    except AINotConfiguredError as exc:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                            detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY,
                            detail="The AI service could not be reached. Please try again.") from exc
    note = "AI suggestion only -- not a fact or a diagnosis." if task == "mood" else None
    return AIResponse(result=result, note=note)


@router.post("/mood", response_model=AIResponse)
def ai_mood(payload: AIRequest, _email: str = Depends(require_admin)):
    return _run("mood", payload)


@router.post("/summary", response_model=AIResponse)
def ai_summary(payload: AIRequest, _email: str = Depends(require_admin)):
    return _run("summary", payload)


@router.post("/improve", response_model=AIResponse)
def ai_improve(payload: AIRequest, _email: str = Depends(require_admin)):
    return _run("improve", payload)


@router.post("/transcribe", response_model=AIResponse)
async def ai_transcribe(file: UploadFile = File(...),
                        _email: str = Depends(require_admin)):
    if not (file.content_type or "").startswith("audio/"):
        raise HTTPException(status_code=400, detail="Please upload an audio file.")
    data = await file.read()
    if len(data) > 25 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="Audio file is too large (max 25 MB).")
    try:
        result = get_ai_service().transcribe_audio(data, file.content_type or "audio/mpeg")
    except AINotConfiguredError as exc:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                            detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY,
                            detail="The AI service could not be reached. Please try again.") from exc
    return AIResponse(result=result, note="Please review the transcript before saving it.")
