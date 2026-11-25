"""Google Drive storage for photos and voice memories — per user.

Each user connects their *own* Google Drive (Settings → Connect
Google Drive); their files live in a ``MyDimension Memories`` folder
in their own Drive (``Photos`` / ``Voice-Memories`` subfolders), and
PostgreSQL only stores the Drive file id + metadata.

Why the user's own account (not a service account): a service
account has no Drive storage quota of its own, so every upload it
creates fails with Google's 403 ``storageQuotaExceeded`` — even into
a folder shared with it (found live 25 Nov 2026). Files created with
the user's own account count against that user's 15 GB free storage.

Credentials come from the user's stored refresh token (encrypted in
``drive_tokens``; see services/drive_auth.py). The owner's folder can
be pinned with ``GOOGLE_DRIVE_ROOT_FOLDER_ID`` so their uploads keep
landing in the same shared folder as before; other users get a
``MyDimension Memories`` folder created in their own Drive root.
"""
from __future__ import annotations

import io
import logging
import os

logger = logging.getLogger("mydimension.drive")

ROOT_FOLDER = "MyDimension Memories"
PHOTOS_FOLDER = "Photos"
VOICE_FOLDER = "Voice-Memories"


class DriveNotConfiguredError(Exception):
    """This user has not connected Google Drive yet."""


class GoogleDriveService:
    """Upload/download/delete files in one user's Google Drive."""

    def __init__(self, credentials=None, root_folder_id: str | None = None) -> None:
        # ``credentials`` is a google-auth Credentials object (from the
        # user's refresh token); it refreshes its access token itself.
        self._credentials = credentials
        self.root_folder_id = root_folder_id
        self._service = None
        self._folders: dict[str, str] = {}

    @property
    def configured(self) -> bool:
        return self._credentials is not None

    def _client(self):
        """Build the Drive client lazily; raise a friendly error if unconnected."""
        if not self.configured:
            raise DriveNotConfiguredError(
                "Google Drive is not connected yet. Connect your Google Drive "
                "in Settings to upload photos and voice memories."
            )
        if self._service is None:
            from googleapiclient.discovery import build

            self._service = build("drive", "v3", credentials=self._credentials)
        return self._service

    def ensure_folders(self) -> dict[str, str]:
        """Create ``MyDimension Memories / Photos|Voice-Memories`` if missing."""
        service = self._client()
        if self.root_folder_id:
            # Pinned folder (the owner's existing folder): use it as-is.
            self._folders[ROOT_FOLDER] = self.root_folder_id
        else:
            self._folders[ROOT_FOLDER] = self._find_or_create_folder(service, ROOT_FOLDER, None)
        self._folders[PHOTOS_FOLDER] = self._find_or_create_folder(
            service, PHOTOS_FOLDER, self._folders[ROOT_FOLDER])
        self._folders[VOICE_FOLDER] = self._find_or_create_folder(
            service, VOICE_FOLDER, self._folders[ROOT_FOLDER])
        return self._folders

    @staticmethod
    def _find_or_create_folder(service, name: str, parent_id: str | None) -> str:
        query = f"name = '{name}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false"
        if parent_id:
            query += f" and '{parent_id}' in parents"
        result = service.files().list(q=query, fields="files(id)").execute()
        files = result.get("files", [])
        if files:
            return files[0]["id"]
        body = {"name": name, "mimeType": "application/vnd.google-apps.folder"}
        if parent_id:
            body["parents"] = [parent_id]
        return service.files().create(body=body, fields="id").execute()["id"]

    def upload(self, file_name: str, mime_type: str, data: bytes,
               media_type: str) -> str:
        """Upload bytes to Drive; return the Drive file id."""
        service = self._client()
        folders = self.ensure_folders()
        parent = folders[PHOTOS_FOLDER if media_type == "photo" else VOICE_FOLDER]
        from googleapiclient.http import MediaIoBaseUpload

        media = MediaIoBaseUpload(io.BytesIO(data), mimetype=mime_type)
        created = service.files().create(
            body={"name": file_name, "parents": [parent]},
            media_body=media, fields="id").execute()
        logger.info("Uploaded %s to Drive (id hidden from logs).", file_name)
        return created["id"]

    def download(self, drive_file_id: str) -> bytes:
        service = self._client()
        from googleapiclient.http import MediaIoBaseDownload

        request = service.files().get_media(fileId=drive_file_id)
        buffer = io.BytesIO()
        downloader = MediaIoBaseDownload(buffer, request)
        done = False
        while not done:
            _, done = downloader.next_chunk()
        return buffer.getvalue()

    def delete(self, drive_file_id: str) -> None:
        self._client().files().delete(fileId=drive_file_id).execute()


def get_drive_service_for_user(user_id: str, is_owner: bool = False) -> GoogleDriveService:
    """Drive service for one user, from their stored refresh token.

    Raises DriveNotConfiguredError when the user has not connected
    Google Drive yet — the routes turn that into a friendly 503.
    """
    from .database_manager import db_manager
    from .drive_auth import (
        decrypt_refresh_token,
        drive_credentials_from_refresh_token,
    )

    encrypted = db_manager.get_drive_token(user_id)
    if not encrypted:
        raise DriveNotConfiguredError(
            "Google Drive is not connected yet. Connect your Google Drive "
            "in Settings to upload photos and voice memories."
        )
    credentials = drive_credentials_from_refresh_token(
        decrypt_refresh_token(encrypted))
    # The owner's uploads keep landing in their existing folder.
    root_folder_id = os.getenv("GOOGLE_DRIVE_ROOT_FOLDER_ID") or None
    if not is_owner:
        root_folder_id = None
    return GoogleDriveService(credentials=credentials,
                              root_folder_id=root_folder_id)
