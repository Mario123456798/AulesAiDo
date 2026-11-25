from __future__ import annotations

import hashlib
import json
import secrets
import threading
from pathlib import Path
from typing import Any

from .models import AulesSession, PipelineRun, UserAgentStore
from .security import (
    decrypt_server_data,
    encrypt_server_data,
    hash_password_scrypt,
    resolve_confined_path,
    verify_password_scrypt,
)

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / ".data"
ATTACHMENTS_DIR = DATA_DIR / "attachments"
AUTH_FILE = DATA_DIR / "auth.json"

_STORE_LOCK = threading.RLock()
_AULES_SESSIONS: dict[str, AulesSession] = {}
_ACTIVE_RUNS: dict[str, PipelineRun] = {}
_CANCELLED_RUNS: set[str] = set()


def _ensure_dirs() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    ATTACHMENTS_DIR.mkdir(parents=True, exist_ok=True)


def _user_store_path(uid: str) -> Path:
    uid_hash = hashlib.sha256(uid.encode("utf-8")).hexdigest()[:24]
    return resolve_confined_path(DATA_DIR, f"store_{uid_hash}.json")


def has_claimed_admin_passcode() -> bool:
    _ensure_dirs()
    if not AUTH_FILE.exists():
        return False
    try:
        data = json.loads(AUTH_FILE.read_text(encoding="utf-8"))
        return bool(data.get("admin_passcode_hash"))
    except Exception:
        return False


def claim_admin_passcode(password: str) -> bool:
    """Asigna de forma atómica la contraseña maestra en el primer arranque si aún no existe."""
    with _STORE_LOCK:
        _ensure_dirs()
        if AUTH_FILE.exists():
            try:
                existing = json.loads(AUTH_FILE.read_text(encoding="utf-8"))
                if existing.get("admin_passcode_hash"):
                    return False
            except Exception:
                pass
        payload = {"admin_passcode_hash": hash_password_scrypt(password)}
        tmp = AUTH_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        tmp.replace(AUTH_FILE)
        return True


def verify_claimed_admin_passcode(password: str) -> bool:
    if not AUTH_FILE.exists():
        return False
    try:
        data = json.loads(AUTH_FILE.read_text(encoding="utf-8"))
        stored = str(data.get("admin_passcode_hash", ""))
        return bool(stored) and verify_password_scrypt(password, stored)
    except Exception:
        return False


def read_user_store(uid: str = "local", email: str = "") -> UserAgentStore:
    with _STORE_LOCK:
        _ensure_dirs()
        path = _user_store_path(uid)
        if not path.exists():
            store = UserAgentStore(uid=uid, email=email)
            write_user_store(store)
            return store
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
            store = UserAgentStore.from_dict(raw)
            if email and not store.email:
                store.email = email
            return store
        except Exception:
            store = UserAgentStore(uid=uid, email=email)
            write_user_store(store)
            return store


def write_user_store(store: UserAgentStore) -> None:
    with _STORE_LOCK:
        _ensure_dirs()
        path = _user_store_path(store.uid)
        tmp = path.with_name(f"{path.name}.{secrets.token_hex(6)}.tmp")
        tmp.write_text(json.dumps(store.to_dict(), indent=2, ensure_ascii=False), encoding="utf-8")
        tmp.replace(path)


def save_attachment_cache(uid: str, attachment_id: str, data: bytes) -> str:
    _ensure_dirs()
    uid_hash = hashlib.sha256(uid.encode("utf-8")).hexdigest()[:16]
    safe_id = "".join(ch if ch.isalnum() or ch in "_-" else "_" for ch in attachment_id)
    cache_key = f"{uid_hash}_{safe_id}.bin"
    target = resolve_confined_path(ATTACHMENTS_DIR, cache_key)
    target.write_bytes(data)
    return cache_key


def read_attachment_cache(cache_key: str) -> bytes | None:
    try:
        target = resolve_confined_path(ATTACHMENTS_DIR, cache_key)
        if target.exists():
            return target.read_bytes()
    except Exception:
        pass
    return None


def set_aules_session(uid: str, session: AulesSession) -> None:
    _AULES_SESSIONS[uid] = session
    store = read_user_store(uid)
    store.encrypted_aules_session = encrypt_server_data(json.dumps(session.to_dict()))
    write_user_store(store)


def get_or_restore_aules_session(uid: str) -> AulesSession | None:
    mem = _AULES_SESSIONS.get(uid)
    if mem:
        return mem
    store = read_user_store(uid)
    if not store.encrypted_aules_session:
        return None
    raw = decrypt_server_data(store.encrypted_aules_session)
    if not raw:
        return None
    try:
        parsed = json.loads(raw)
        if parsed.get("base_url") and isinstance(parsed.get("cookies"), dict):
            sess = AulesSession.from_dict(parsed)
            _AULES_SESSIONS[uid] = sess
            return sess
    except Exception:
        return None
    return None


def clear_aules_session(uid: str) -> None:
    _AULES_SESSIONS.pop(uid, None)
    store = read_user_store(uid)
    store.encrypted_aules_session = None
    write_user_store(store)


def save_drive_oauth_tokens(uid: str, token_bundle: dict[str, Any]) -> None:
    store = read_user_store(uid)
    store.encrypted_drive_oauth = encrypt_server_data(json.dumps(token_bundle))
    write_user_store(store)


def load_drive_oauth_tokens(uid: str) -> dict[str, Any] | None:
    store = read_user_store(uid)
    if not store.encrypted_drive_oauth:
        return None
    raw = decrypt_server_data(store.encrypted_drive_oauth)
    if not raw:
        return None
    try:
        data = json.loads(raw)
        return data if isinstance(data, dict) else None
    except Exception:
        return None


def clear_drive_oauth_tokens(uid: str) -> None:
    store = read_user_store(uid)
    store.encrypted_drive_oauth = None
    write_user_store(store)


def register_run(run: PipelineRun) -> None:
    _ACTIVE_RUNS[run.id] = run


def get_run(run_id: str) -> PipelineRun | None:
    return _ACTIVE_RUNS.get(run_id)


def mark_run_cancelled(run_id: str) -> None:
    _CANCELLED_RUNS.add(run_id)


def is_run_cancelled(run_id: str) -> bool:
    return run_id in _CANCELLED_RUNS
