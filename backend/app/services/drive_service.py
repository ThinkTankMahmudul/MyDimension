"""Google Drive storage for photos and voice memories.

The actual files live in the owner's Google Drive (folder
``MyDimension Memories`` with ``Photos`` and ``Voice-Memories``
subfolders); PostgreSQL only stores the Drive file id + metadata.

Degraded mode: if Drive credentials are not configured, the service
does NOT crash app startup. Every method raises the friendly
``DriveNotConfiguredError`` instead, and the API turns that into a
503 response telling the owner to connect Drive.
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
    """Drive credentials are missing; the owner needs to connect Drive."""


class GoogleDriveService:
    """Upload/download/delete files in the owner's Google Drive."""

    def __init__(self) -> None:
        # Credentials are expected via GOOGLE_DRIVE_CREDENTIALS (path to a
        # service-account / OAuth token file) or the standard
        # GOOGLE_APPLICATION_CREDENTIALS variable. Nothing secret is in code.
        self.credentials_path = (
            os.getenv("GOOGLE_DRIVE_CREDENTIALS")
            or os.getenv("GOOGLE_APPLICATION_CREDENTIALS")
        )
        self._service = None
        self._folders: dict[str, str] = {}

    @property
    def configured(self) -> bool:
        return bool(self.credentials_path and os.path.exists(self.credentials_path))

    def _client(self):
        """Build the Drive client lazily; raise a friendly error if unconfigured."""
        if not self.configured:
            raise DriveNotConfiguredError(
                "Google Drive is not connected yet. Connect Drive in Settings "
                "to upload photos and voice memories."
            )
        if self._service is None:
            from google.oauth2 import service_account
            from googleapiclient.discovery import build

            creds = service_account.Credentials.from_service_account_file(
                self.credentials_path,
                scopes=["https://www.googleapis.com/auth/drive.file"],
            )
            self._service = build("drive", "v3", credentials=creds)
        return self._service

    def ensure_folders(self) -> dict[str, str]:
        """Create ``MyDimension Memories / Photos|Voice-Memories`` if missing."""
        service = self._client()
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


# Shared instance used by the media routes.
drive_service = GoogleDriveService()
