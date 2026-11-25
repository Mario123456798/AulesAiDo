from __future__ import annotations

import base64
import hashlib
import hmac
import ipaddress
import json
import os
import re
import secrets
import time
from pathlib import Path
from urllib.parse import urljoin, urlparse

_EPHEMERAL_FALLBACK_KEY = secrets.token_bytes(32)


def _derive_server_key(purpose: str) -> bytes:
    secret_source = (
        os.environ.get("SESSION_SECRET", "").strip()
        or os.environ.get("AULES_SESSION_SECRET", "").strip()
        or os.environ.get("GROQ_API_KEY", "").strip()
    )
    if not secret_source:
        return hashlib.sha256(_EPHEMERAL_FALLBACK_KEY + purpose.encode("utf-8")).digest()
    return hashlib.sha256(f"{purpose}:{secret_source}".encode("utf-8")).digest()


def _b64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _b64url_decode(val: str) -> bytes:
    pad = "=" * ((4 - len(val) % 4) % 4)
    return base64.urlsafe_b64decode(val + pad)


def encrypt_server_data(plain_text: str) -> str:
    """Cifrado autenticado sin dependencias externas (CTR-HMAC-SHA256)."""
    master = _derive_server_key("aules-session")
    enc_key = hashlib.sha256(b"enc:" + master).digest()
    mac_key = hashlib.sha256(b"mac:" + master).digest()

    nonce = secrets.token_bytes(16)
    plain_bytes = plain_text.encode("utf-8")

    keystream = bytearray()
    counter = 0
    while len(keystream) < len(plain_bytes):
        block = hashlib.sha256(enc_key + nonce + counter.to_bytes(4, "big")).digest()
        keystream.extend(block)
        counter += 1

    cipher_bytes = bytes(a ^ b for a, b in zip(plain_bytes, keystream))
    tag = hmac.new(mac_key, nonce + cipher_bytes, hashlib.sha256).digest()
    return f"{_b64url_encode(nonce)}.{_b64url_encode(tag)}.{_b64url_encode(cipher_bytes)}"


def decrypt_server_data(payload: str) -> str | None:
    try:
        parts = payload.split(".")
        if len(parts) != 3:
            return None
        nonce = _b64url_decode(parts[0])
        tag = _b64url_decode(parts[1])
        cipher_bytes = _b64url_decode(parts[2])

        master = _derive_server_key("aules-session")
        enc_key = hashlib.sha256(b"enc:" + master).digest()
        mac_key = hashlib.sha256(b"mac:" + master).digest()

        expected_tag = hmac.new(mac_key, nonce + cipher_bytes, hashlib.sha256).digest()
        if not hmac.compare_digest(tag, expected_tag):
            return None

        keystream = bytearray()
        counter = 0
        while len(keystream) < len(cipher_bytes):
            block = hashlib.sha256(enc_key + nonce + counter.to_bytes(4, "big")).digest()
            keystream.extend(block)
            counter += 1

        plain_bytes = bytes(a ^ b for a, b in zip(cipher_bytes, keystream))
        return plain_bytes.decode("utf-8")
    except Exception:
        return None


def hash_password_scrypt(password: str) -> str:
    salt = secrets.token_bytes(16)
    derived = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=16384, r=8, p=1, dklen=32)
    return f"{_b64url_encode(salt)}.{_b64url_encode(derived)}"


def verify_password_scrypt(password: str, stored_hash: str) -> bool:
    try:
        salt_b64, dk_b64 = stored_hash.split(".", 1)
        salt = _b64url_decode(salt_b64)
        expected = _b64url_decode(dk_b64)
        actual = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=16384, r=8, p=1, dklen=len(expected))
        return hmac.compare_digest(actual, expected)
    except Exception:
        return False


def create_signed_session_cookie(uid: str, ttl_seconds: int = 86400 * 7) -> str:
    key = _derive_server_key("web-cookie")
    payload = {
        "uid": uid,
        "exp": int(time.time()) + ttl_seconds,
        "jti": secrets.token_hex(8),
    }
    raw_b64 = _b64url_encode(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
    sig = hmac.new(key, raw_b64.encode("ascii"), hashlib.sha256).digest()
    return f"{raw_b64}.{_b64url_encode(sig)}"


def verify_signed_session_cookie(token: str) -> str | None:
    try:
        raw_b64, sig_b64 = token.split(".", 1)
        key = _derive_server_key("web-cookie")
        expected = hmac.new(key, raw_b64.encode("ascii"), hashlib.sha256).digest()
        if not hmac.compare_digest(expected, _b64url_decode(sig_b64)):
            return None
        payload = json.loads(_b64url_decode(raw_b64).decode("utf-8"))
        if int(payload.get("exp", 0)) <= int(time.time()):
            return None
        uid = str(payload.get("uid", "")).strip()
        return uid or None
    except Exception:
        return None


def is_private_or_loopback_host(hostname: str) -> bool:
    lower = hostname.strip().lower().strip("[]")
    if (
        not lower
        or lower == "localhost"
        or lower == "metadata.google.internal"
        or lower.endswith(".local")
        or lower.endswith(".internal")
    ):
        return True
    try:
        ip = ipaddress.ip_address(lower)
        return (
            ip.is_private
            or ip.is_loopback
            or ip.is_link_local
            or ip.is_reserved
            or ip.is_multicast
            or ip.is_unspecified
        )
    except ValueError:
        return False


def validate_aules_base_url(raw_url: str) -> str:
    trimmed = raw_url.strip()
    if not trimmed:
        raise ValueError("Debes indicar la URL de tu portal Aules o Moodle.")

    parsed = urlparse(trimmed)
    if parsed.scheme.lower() != "https" or not parsed.netloc:
        raise ValueError("Por seguridad, la URL de Aules debe usar HTTPS válido (ej. https://aules.edu.gva.es/fp).")

    host = parsed.hostname or ""
    if is_private_or_loopback_host(host):
        raise ValueError("La URL indicada apunta a una dirección privada no permitida.")

    clean_path = re.sub(r"/login/index\.php.*$", "", parsed.path, flags=re.IGNORECASE).rstrip("/")
    return f"https://{parsed.netloc}{clean_path}"


def assert_same_origin_aules_url(target_url: str, base_url: str) -> str:
    base = urlparse(base_url)
    resolved = urljoin(base_url.rstrip("/") + "/", target_url)
    parsed = urlparse(resolved)
    if parsed.scheme.lower() != "https" or parsed.netloc.lower() != base.netloc.lower():
        raise ValueError("Enlace fuera del dominio autorizado de Aules.")
    if is_private_or_loopback_host(parsed.hostname or ""):
        raise ValueError("Destino de red no permitido.")
    return resolved


def is_safe_external_href(url: str | None) -> str:
    if not url:
        return "#"
    trimmed = url.strip()
    if trimmed.startswith("/"):
        return trimmed
    parsed = urlparse(trimmed)
    if parsed.scheme.lower() in {"https", "http"} and parsed.netloc:
        return trimmed
    return "#"


def sanitize_file_name(name: str) -> str:
    cleaned = re.sub(r'[\\/:*?"<>|]', "_", name)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return (cleaned[:140] if cleaned else "archivo")


def resolve_confined_path(base_dir: Path, relative_name: str) -> Path:
    if not relative_name or "/" in relative_name or "\\" in relative_name or ".." in relative_name:
        raise ValueError("Nombre de archivo o ruta inválida.")
    resolved_base = base_dir.resolve()
    safe_name = re.sub(r"[^a-zA-Z0-9._-]", "_", relative_name).strip(".")
    if not safe_name or safe_name in {".", ".."}:
        raise ValueError("Nombre de archivo inválido.")
    resolved_target = (resolved_base / safe_name).resolve()
    if resolved_target == resolved_base or not resolved_target.is_relative_to(resolved_base):
        raise ValueError("Ruta de archivo fuera del directorio permitido.")
    return resolved_target
