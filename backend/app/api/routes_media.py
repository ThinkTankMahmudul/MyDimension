"""Photo / voice-memory routes.

Uploads go to the owner's Google Drive via GoogleDriveService; only the
Drive file id + metadata are stored in PostgreSQL. If Drive is not
connected, upload returns a friendly 503 (never a crash).
Allowed types: images and audio only, max ~25 MB per file.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, Response, status

from ..core.security import require_user
from ..models.models import MediaFile
from ..schemas.schemas import MediaResponse
from ..services.database_manager import db_manager
from ..services.drive_service import DriveNotConfiguredError, drive_service

router = APIRouter(prefix="/api/media", tags=["media"])

MAX_FILE_SIZE = 25 * 1024 * 1024  # ~25 MB
ALLOWED_IMAGE = {"image/jpeg", "image/png", "image/webp", "image/gif", "image/heic"}
ALLOWED_AUDIO = {"audio/mpeg", "audio/mp4", "audio/wav", "audio/webm", "audio/ogg", "audio/x-m4a"}


@router.post("/upload", response_model=MediaResponse, status_code=status.HTTP_201_CREATED)
async def upload_media(file: UploadFile = File(...),
                       media_type: str = Form("photo"),
                       caption: str | None = Form(default=None),
                       entry_id: str | None = Form(default=None),
                       _user: dict = Depends(require_user)):
    if media_type not in ("photo", "audio"):
        raise HTTPException(status_code=400, detail="media_type must be 'photo' or 'audio'.")
    allowed = ALLOWED_IMAGE if media_type == "photo" else ALLOWED_AUDIO
    if (file.content_type or "") not in allowed:
        raise HTTPException(status_code=400,
                            detail=f"That file type is not allowed for {media_type} uploads.")
    data = await file.read()
    if len(data) > MAX_FILE_SIZE:
        raise HTTPException(status_code=400, detail="File is too large (max 25 MB).")
    if not data:
        raise HTTPException(status_code=400, detail="Uploaded file is empty.")
    try:
        drive_file_id = drive_service.upload(file.filename or "upload",
                                             file.content_type or "application/octet-stream",
                                             data, media_type)
    except DriveNotConfiguredError as exc:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                            detail=str(exc)) from exc
    media = MediaFile(drive_file_id=drive_file_id, file_name=file.filename or "upload",
                      mime_type=file.content_type or "application/octet-stream",
                      media_type=media_type, file_size=len(data),
                      entry_id=entry_id, caption=caption)
    db_manager.create_media(media, user_id=_user["id"])
    return MediaResponse(**media.to_dict())


@router.get("", response_model=list[MediaResponse])
def list_media(media_type: str | None = None, _user: dict = Depends(require_user)):
    return [MediaResponse(**m.to_dict()) for m in db_manager.list_media(media_type, user_id=_user["id"])]


@router.get("/{media_id}/file")
def download_media_file(media_id: str, _user: dict = Depends(require_user)):
    """Stream the actual file bytes (photo/audio) for <img>/<audio> tags.

    NOTE: GET /{media_id} returns JSON metadata only — browsers cannot
    use it as an image/audio src, so this separate /file route exists.
    """
    media = db_manager.get_media(media_id, user_id=_user["id"])
    if media is None:
        raise HTTPException(status_code=404, detail="Media not found.")
    try:
        data = drive_service.download(media.drive_file_id)
    except DriveNotConfiguredError as exc:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                            detail=str(exc)) from exc
    return Response(content=data, media_type=media.mime_type,
                    headers={"Content-Disposition": f'inline; filename="{media.file_name}"'})


@router.get("/{media_id}", response_model=MediaResponse)
def get_media(media_id: str, _user: dict = Depends(require_user)):
    media = db_manager.get_media(media_id, user_id=_user["id"])
    if media is None:
        raise HTTPException(status_code=404, detail="Media not found.")
    return MediaResponse(**media.to_dict())


@router.delete("/{media_id}")
def delete_media(media_id: str, _user: dict = Depends(require_user)):
    media = db_manager.delete_media(media_id, user_id=_user["id"])
    if media is None:
        raise HTTPException(status_code=404, detail="Media not found.")
    try:
        drive_service.delete(media.drive_file_id)
    except DriveNotConfiguredError:
        pass  # file record is gone; Drive was never connected
    except Exception:
        pass  # do not fail the delete if Drive is unreachable
    return {"detail": "Media deleted."}
