from __future__ import annotations

import json
import os
import secrets
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

from .security import sanitize_file_name
from .store import load_drive_oauth_tokens, save_drive_oauth_tokens

DRIVE_API = "https://www.googleapis.com/drive/v3"
DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3"
GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file"


def is_google_oauth_configured() -> bool:
    return bool(
        os.environ.get("GOOGLE_CLIENT_ID", "").strip()
        and os.environ.get("GOOGLE_CLIENT_SECRET", "").strip()
    )


def build_google_auth_url(redirect_uri: str, state: str) -> str:
    client_id = os.environ.get("GOOGLE_CLIENT_ID", "").strip()
    params = {
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": DRIVE_SCOPE,
        "access_type": "offline",
        "prompt": "consent",
        "state": state,
    }
    return f"{GOOGLE_AUTH_URL}?{urllib.parse.urlencode(params)}"


def exchange_google_code(code: str, redirect_uri: str, uid: str = "local") -> dict[str, Any]:
    client_id = os.environ.get("GOOGLE_CLIENT_ID", "").strip()
    client_secret = os.environ.get("GOOGLE_CLIENT_SECRET", "").strip()
    if not client_id or not client_secret:
        raise RuntimeError("Faltan GOOGLE_CLIENT_ID o GOOGLE_CLIENT_SECRET en el entorno.")

    body = urllib.parse.urlencode(
        {
            "code": code,
            "client_id": client_id,
            "client_secret": client_secret,
            "redirect_uri": redirect_uri,
            "grant_type": "authorization_code",
        }
    ).encode("utf-8")
    req = urllib.request.Request(
        GOOGLE_TOKEN_URL,
        data=body,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    bundle = {
        "access_token": data["access_token"],
        "refresh_token": data.get("refresh_token"),
        "expires_at": time.time() + int(data.get("expires_in", 3600)) - 60,
    }
    save_drive_oauth_tokens(uid, bundle)
    return bundle


def get_valid_drive_access_token(uid: str = "local") -> str | None:
    bundle = load_drive_oauth_tokens(uid)
    if not bundle:
        return None
    if bundle.get("access_token") and float(bundle.get("expires_at", 0)) > time.time():
        return str(bundle["access_token"])

    refresh_token = bundle.get("refresh_token")
    client_id = os.environ.get("GOOGLE_CLIENT_ID", "").strip()
    client_secret = os.environ.get("GOOGLE_CLIENT_SECRET", "").strip()
    if not refresh_token or not client_id or not client_secret:
        return bundle.get("access_token")

    body = urllib.parse.urlencode(
        {
            "refresh_token": refresh_token,
            "client_id": client_id,
            "client_secret": client_secret,
            "grant_type": "refresh_token",
        }
    ).encode("utf-8")
    req = urllib.request.Request(
        GOOGLE_TOKEN_URL,
        data=body,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            refreshed = json.loads(resp.read().decode("utf-8"))
        bundle["access_token"] = refreshed["access_token"]
        bundle["expires_at"] = time.time() + int(refreshed.get("expires_in", 3600)) - 60
        save_drive_oauth_tokens(uid, bundle)
        return str(bundle["access_token"])
    except Exception:
        return None


def _escape_drive_query(val: str) -> str:
    return val.replace("\\", "\\\\").replace("'", "\\'")


def _drive_json_request(
    url: str, access_token: str, method: str = "GET", payload: dict[str, Any] | None = None
) -> dict[str, Any]:
    headers = {"Authorization": f"Bearer {access_token}"}
    data: bytes | None = None
    if payload is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=25) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as err:
        err_txt = err.read().decode("utf-8", errors="ignore")
        raise RuntimeError(f"Error de Google Drive (HTTP {err.code}): {err_txt[:200]}")


def ensure_drive_folder(
    access_token: str, folder_name: str, parent_id: str | None = None
) -> tuple[str, str]:
    safe_name = sanitize_file_name(folder_name)
    parent_clause = f" and '{_escape_drive_query(parent_id)}' in parents" if parent_id else ""
    query = (
        f"name = '{_escape_drive_query(safe_name)}' and "
        f"mimeType = 'application/vnd.google-apps.folder' and trashed = false{parent_clause}"
    )
    search_url = (
        f"{DRIVE_API}/files?q={urllib.parse.quote(query)}"
        "&fields=files(id,name,webViewLink)&spaces=drive&pageSize=5"
    )
    res = _drive_json_request(search_url, access_token)
    files = res.get("files") or []
    if files:
        f = files[0]
        return f["id"], f.get("webViewLink") or f"https://drive.google.com/drive/folders/{f['id']}"

    body: dict[str, Any] = {
        "name": safe_name,
        "mimeType": "application/vnd.google-apps.folder",
    }
    if parent_id:
        body["parents"] = [parent_id]
    created = _drive_json_request(
        f"{DRIVE_API}/files?fields=id,name,webViewLink", access_token, method="POST", payload=body
    )
    return created["id"], created.get("webViewLink") or f"https://drive.google.com/drive/folders/{created['id']}"


def find_drive_file_in_folder(
    access_token: str, folder_id: str, file_name: str
) -> dict[str, Any] | None:
    safe_name = sanitize_file_name(file_name)
    query = (
        f"name = '{_escape_drive_query(safe_name)}' and "
        f"'{_escape_drive_query(folder_id)}' in parents and trashed = false"
    )
    url = f"{DRIVE_API}/files?q={urllib.parse.quote(query)}&fields=files(id,name,mimeType,webViewLink)&pageSize=5"
    res = _drive_json_request(url, access_token)
    files = res.get("files") or []
    return files[0] if files else None


def sync_file_to_drive(
    access_token: str,
    folder_id: str,
    file_name: str,
    mime_type: str,
    content: bytes,
) -> tuple[str, str, str]:
    """Sube o actualiza automáticamente en lugar (PATCH) sin pausar por conflictos."""
    safe_name = sanitize_file_name(file_name)
    existing = find_drive_file_in_folder(access_token, folder_id, safe_name)
    existing_id = existing["id"] if existing else None

    boundary = f"aules_sync_{secrets.token_hex(12)}"
    metadata: dict[str, Any] = {"name": safe_name, "mimeType": mime_type}
    if not existing_id:
        metadata["parents"] = [folder_id]

    preamble = (
        f"--{boundary}\r\n"
        "Content-Type: application/json; charset=UTF-8\r\n\r\n"
        f"{json.dumps(metadata)}\r\n"
        f"--{boundary}\r\n"
        f"Content-Type: {mime_type or 'application/octet-stream'}\r\n\r\n"
    ).encode("utf-8")
    epilogue = f"\r\n--{boundary}--".encode("utf-8")
    body_bytes = preamble + content + epilogue

    target_url = (
        f"{DRIVE_UPLOAD_API}/files/{urllib.parse.quote(existing_id)}?uploadType=multipart&fields=id,name,webViewLink"
        if existing_id
        else f"{DRIVE_UPLOAD_API}/files?uploadType=multipart&fields=id,name,webViewLink"
    )
    req = urllib.request.Request(
        target_url,
        data=body_bytes,
        headers={
            "Authorization": f"Bearer {access_token}",
            "Content-Type": f"multipart/related; boundary={boundary}",
        },
        method="PATCH" if existing_id else "POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=45) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as err:
        err_txt = err.read().decode("utf-8", errors="ignore")
        raise RuntimeError(f'Error al subir "{safe_name}" a Google Drive (HTTP {err.code}): {err_txt[:200]}')

    return (
        data["id"],
        data.get("webViewLink") or f"https://drive.google.com/file/d/{data['id']}/view",
        data["name"],
    )


def list_drive_folder_children(access_token: str, folder_id: str) -> list[dict[str, Any]]:
    query = f"'{_escape_drive_query(folder_id)}' in parents and trashed = false"
    url = (
        f"{DRIVE_API}/files?q={urllib.parse.quote(query)}"
        "&fields=files(id,name,mimeType,webViewLink)&orderBy=folder,name&pageSize=100"
    )
    res = _drive_json_request(url, access_token)
    return list(res.get("files") or [])
