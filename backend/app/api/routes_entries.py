"""Diary entry routes: list / create / read / update / delete.

All routes require the owner session (``require_admin``).
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status

from ..core.security import require_admin
from ..schemas.schemas import EntryCreate, EntryResponse, EntryUpdate
from ..services.diary_manager import DiaryManager

router = APIRouter(prefix="/api/entries", tags=["entries"])


def get_manager() -> DiaryManager:
    return DiaryManager()


@router.get("", response_model=list[EntryResponse])
def list_entries(search: str | None = Query(default=None),
                 mood: str | None = Query(default=None),
                 month: str | None = Query(default=None, pattern=r"^\d{4}-\d{2}$"),
                 _email: str = Depends(require_admin),
                 manager: DiaryManager = Depends(get_manager)):
    return [EntryResponse(**e.to_dict()) for e in manager.list_entries(search, mood, month)]


@router.post("", response_model=EntryResponse, status_code=status.HTTP_201_CREATED)
def create_entry(payload: EntryCreate, _email: str = Depends(require_admin),
                 manager: DiaryManager = Depends(get_manager)):
    try:
        entry = manager.create_entry(payload.title, payload.content, payload.mood, payload.tags)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return EntryResponse(**entry.to_dict())


@router.get("/{entry_id}", response_model=EntryResponse)
def get_entry(entry_id: str, _email: str = Depends(require_admin),
              manager: DiaryManager = Depends(get_manager)):
    entry = manager.get_entry(entry_id)
    if entry is None:
        raise HTTPException(status_code=404, detail="Entry not found.")
    return EntryResponse(**entry.to_dict())


@router.put("/{entry_id}", response_model=EntryResponse)
def update_entry(entry_id: str, payload: EntryUpdate,
                 _email: str = Depends(require_admin),
                 manager: DiaryManager = Depends(get_manager)):
    try:
        entry = manager.update_entry(entry_id, **payload.model_dump(exclude_unset=True))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if entry is None:
        raise HTTPException(status_code=404, detail="Entry not found.")
    return EntryResponse(**entry.to_dict())


@router.delete("/{entry_id}")
def delete_entry(entry_id: str, _email: str = Depends(require_admin),
                 manager: DiaryManager = Depends(get_manager)):
    if not manager.delete_entry(entry_id):
        raise HTTPException(status_code=404, detail="Entry not found.")
    return {"detail": "Entry deleted."}
