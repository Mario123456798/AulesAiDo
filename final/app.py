from __future__ import annotations

import email.parser
import email.policy
import hmac
import html
import json
import os
import secrets
import threading
import time
import urllib.parse
from datetime import datetime, timezone
from http import cookies as http_cookies
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from core.aules_client import (
    connect_aules,
    discover_course_resources_for_course,
    download_and_extract_attachment,
    verify_aules_session_alive,
)
from core.context_engine import (
    is_task_actionable,
    is_task_no_submission,
    is_task_submitted_in_aules,
    needs_extra_course_context,
)
from core.document_builder import build_deliverable_file, extract_text_from_bytes
from core.drive_sync import (
    build_google_auth_url,
    ensure_drive_folder,
    exchange_google_code,
    get_valid_drive_access_token,
    is_google_oauth_configured,
    list_drive_folder_children,
    sync_file_to_drive,
)
from core.groq_client import (
    is_groq_configured,
    list_groq_models,
    normalize_groq_model,
    solve_and_analyze_task,
)
from core.models import AttachmentRecord, AulesProfile, TaskRecord
from core.pipeline import (
    get_course_reference_examples,
    start_background_run,
)
from core.security import (
    create_signed_session_cookie,
    is_safe_external_href,
    resolve_confined_path,
    sanitize_file_name,
    verify_signed_session_cookie,
)
from core.store import (
    claim_admin_passcode,
    clear_aules_session,
    clear_drive_oauth_tokens,
    get_or_restore_aules_session,
    get_run,
    has_claimed_admin_passcode,
    mark_run_cancelled,
    read_attachment_cache,
    read_user_store,
    save_attachment_cache,
    set_aules_session,
    verify_claimed_admin_passcode,
    write_user_store,
)

ROOT_DIR = Path(__file__).resolve().parent
TEMPLATES_DIR = ROOT_DIR / "templates"
STATIC_DIR = ROOT_DIR / "static"
SESSION_COOKIE_NAME = "aules_sync_session"
DEFAULT_UID = "local"

_OAUTH_STATES: dict[str, float] = {}


def _load_dotenv() -> None:
    env_file = ROOT_DIR / ".env"
    if not env_file.exists():
        return
    for line in env_file.read_text(encoding="utf-8", errors="ignore").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        k, v = stripped.split("=", 1)
        key = k.strip()
        val = v.strip().strip('"').strip("'")
        if key and key not in os.environ and val:
            os.environ[key] = val


def _esc(val: Any) -> str:
    return html.escape("" if val is None else str(val), quote=True)


def _load_template(name: str) -> str:
    return resolve_confined_path(TEMPLATES_DIR, name).read_text(encoding="utf-8")


def _render_template(raw: str, values: dict[str, str]) -> str:
    out = raw
    for k, v in values.items():
        out = out.replace(f"{{{{{k}}}}}", v)
    return out


def _normalize_store_tasks(uid: str = DEFAULT_UID) -> Any:
    store = read_user_store(uid)
    changed = False
    for t in store.tasks:
        if is_task_no_submission(t):
            if t.status != "no_submission" or t.requires_online_submission is not False:
                t.requires_online_submission = False
                t.is_submitted_in_aules = False
                t.status = "no_submission"
                t.error_message = None
                changed = True
        elif is_task_submitted_in_aules(t):
            if t.status != "reference" or t.is_submitted_in_aules is not True:
                t.is_submitted_in_aules = True
                t.status = "reference"
                t.error_message = None
                changed = True
        elif t.status == "awaiting_drive_confirm":
            has_sol = bool(t.deliverables and len(t.deliverables.homework_solution_md.strip()) >= 100)
            t.status = "solved" if has_sol else "downloaded"
            changed = True
    if store.runs and store.runs[0].status == "running" and not get_run(store.runs[0].id):
        store.runs[0].status = "error"
        store.runs[0].finished_at = datetime.now(timezone.utc).isoformat()
        store.runs[0].error_message = "Ejecución anterior interrumpida por reinicio del servidor."
        store.runs[0].current_item_label = "Ejecución anterior interrumpida"
        changed = True
    if changed:
        write_user_store(store)
    return store


def _format_duration(started_at: str, finished_at: str | None) -> str:
    try:
        start = datetime.fromisoformat(started_at.replace("Z", "+00:00")).timestamp()
        end = (
            datetime.fromisoformat(finished_at.replace("Z", "+00:00")).timestamp()
            if finished_at
            else time.time()
        )
        sec = max(0, int(end - start))
        return f"{sec // 60:02d}:{sec % 60:02d}"
    except Exception:
        return "00:00"


def _status_badge_meta(task: TaskRecord) -> tuple[str, str]:
    if is_task_no_submission(task):
        return "Sin entrega online", "tone-muted"
    if is_task_submitted_in_aules(task):
        return "Hecha · Referencia", "tone-muted"
    st = task.status
    if st == "synced":
        return "Sincronizada", "tone-success"
    if st == "solved":
        return "Resuelta", "tone-active"
    if st == "awaiting_drive_confirm":
        return "Lista para Drive", "tone-active"
    if st in ("downloaded", "analyzed"):
        return "Documentación leída", "tone-muted"
    if st == "error":
        return "Con error", "tone-error"
    return "Sin hacer", "tone-warning"


def _start_auto_sync_scheduler() -> None:
    def loop() -> None:
        last_run_at = 0.0
        while True:
            time.sleep(30)
            try:
                store = read_user_store(DEFAULT_UID)
                if not store.auto_sync_enabled:
                    continue
                if not is_groq_configured() or not get_or_restore_aules_session(DEFAULT_UID):
                    continue
                if store.runs:
                    latest = get_run(store.runs[0].id) or store.runs[0]
                    if latest.status == "running":
                        continue
                interval_sec = max(5, store.auto_sync_interval_minutes) * 60
                if time.time() - last_run_at >= interval_sec:
                    last_run_at = time.time()
                    start_background_run(DEFAULT_UID, mode="full", force_regenerate=False)
            except Exception:
                pass

    th = threading.Thread(target=loop, daemon=True)
    th.start()


class AulesRequestHandler(BaseHTTPRequestHandler):
    server_version = "AulesSyncPython/1.0"

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
        return

    def _send_bytes(
        self,
        status: int,
        content_type: str,
        payload: bytes,
        extra_headers: dict[str, str] | None = None,
    ) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        if extra_headers:
            for k, v in extra_headers.items():
                self.send_header(k, v)
        self.end_headers()
        self.wfile.write(payload)

    def _redirect(self, location: str, extra_headers: dict[str, str] | None = None) -> None:
        self.send_response(303)
        self.send_header("Location", location)
        if extra_headers:
            for k, v in extra_headers.items():
                self.send_header(k, v)
        self.end_headers()

    def _is_authenticated(self) -> str | None:
        raw_cookie = self.headers.get("Cookie", "")
        if not raw_cookie:
            return None
        jar = http_cookies.SimpleCookie()
        try:
            jar.load(raw_cookie)
        except Exception:
            return None
        morsel = jar.get(SESSION_COOKIE_NAME)
        if not morsel:
            return None
        return verify_signed_session_cookie(morsel.value)

    def _cookie_header(self, token: str, clear: bool = False) -> str:
        proto = self.headers.get("X-Forwarded-Proto", "").lower()
        is_https = proto == "https"
        parts = [
            f"{SESSION_COOKIE_NAME}={'' if clear else token}",
            "Path=/",
            "HttpOnly",
            f"Max-Age={0 if clear else 86400 * 7}",
        ]
        if is_https:
            parts.extend(["SameSite=None", "Secure", "Partitioned"])
        else:
            parts.append("SameSite=Lax")
        return "; ".join(parts)

    def _verify_same_origin_post(self) -> bool:
        expected_host = (self.headers.get("X-Forwarded-Host") or self.headers.get("Host") or "").split(",")[0].strip().lower()
        origin = self.headers.get("Origin", "").strip()
        referer = self.headers.get("Referer", "").strip()
        if origin:
            parsed = urllib.parse.urlparse(origin)
            return parsed.netloc.lower() == expected_host
        if referer:
            parsed = urllib.parse.urlparse(referer)
            return parsed.netloc.lower() == expected_host
        return True

    def _read_body(self, max_bytes: int = 16 * 1024 * 1024) -> bytes:
        length = int(self.headers.get("Content-Length", "0") or 0)
        if length < 0 or length > max_bytes:
            raise ValueError("Tamaño de petición fuera de rango permitido.")
        return self.rfile.read(length) if length > 0 else b""

    def _read_form_urlencoded(self) -> dict[str, str]:
        raw = self._read_body(256 * 1024).decode("utf-8", errors="ignore")
        parsed = urllib.parse.parse_qs(raw, keep_blank_values=True)
        return {k: v[0] if v else "" for k, v in parsed.items()}

    def _read_multipart(self) -> tuple[dict[str, str], list[tuple[str, str, str, bytes]]]:
        ctype = self.headers.get("Content-Type", "")
        raw_body = self._read_body(16 * 1024 * 1024)
        header_bytes = f"Content-Type: {ctype}\r\nMIME-Version: 1.0\r\n\r\n".encode("utf-8")
        msg = email.parser.BytesParser(policy=email.policy.default).parsebytes(header_bytes + raw_body)
        fields: dict[str, str] = {}
        files: list[tuple[str, str, str, bytes]] = []
        if msg.is_multipart():
            for part in msg.iter_parts():
                cd = part.get("Content-Disposition", "")
                name = part.get_param("name", header="content-disposition")
                filename = part.get_filename()
                payload = part.get_payload(decode=True) or b""
                if filename:
                    files.append((str(name or "file"), str(filename), part.get_content_type(), payload))
                elif name:
                    fields[str(name)] = payload.decode("utf-8", errors="ignore")
        return fields, files

    def _render_shell(
        self,
        *,
        section: str,
        title: str,
        breadcrumb: str,
        content_html: str,
        store: Any,
        aules_connected: bool,
        has_drive: bool,
        flash_error: str = "",
        flash_notice: str = "",
        auto_refresh: bool = False,
        topbar_cta: str = "",
    ) -> bytes:
        banner = ""
        if flash_error:
            banner = f'<div class="banner banner-error">{_esc(flash_error)}</div>'
        elif flash_notice:
            banner = f'<div class="banner banner-success">{_esc(flash_notice)}</div>'

        tpl = _load_template("base.html")
        html_str = _render_template(
            tpl,
            {
                "TITLE": _esc(title),
                "AUTO_REFRESH_META": '<meta http-equiv="refresh" content="2" />' if auto_refresh else "",
                "NAV_PROCESS_ACTIVE": "active" if section == "process" else "",
                "NAV_TASKS_ACTIVE": "active" if section == "tasks" else "",
                "NAV_KNOWLEDGE_ACTIVE": "active" if section == "knowledge" else "",
                "NAV_DRIVE_ACTIVE": "active" if section == "drive" else "",
                "NAV_CONNECTIONS_ACTIVE": "active" if section == "connections" else "",
                "NAV_TASKS_COUNT": str(len(store.tasks)),
                "NAV_KNOWLEDGE_COUNT": str(len(store.knowledge)),
                "SIDEBAR_USER": _esc(store.aules_profile.full_name if store.aules_profile else "Sesión local"),
                "SIDEBAR_AULES": "Conectada" if aules_connected else "Sin conectar",
                "SIDEBAR_DRIVE": "Autorizado" if has_drive else "Pendiente",
                "BREADCRUMB": _esc(breadcrumb),
                "TOPBAR_CTA": topbar_cta,
                "FLASH_BANNER": banner,
                "CONTENT": content_html,
            },
        )
        return html_str.encode("utf-8")

    def _render_login_page(self, error_msg: str = "") -> bytes:
        env_passcode = os.environ.get("AULES_APP_PASSCODE", "").strip()
        needs_claim = not env_passcode and not has_claimed_admin_passcode()
        tpl = _load_template("login.html")
        err_html = f'<div class="banner banner-error" style="margin-bottom: 16px;">{_esc(error_msg)}</div>' if error_msg else ""
        if needs_claim:
            values = {
                "AUTH_SUBTITLE": "Configura tu contraseña maestra local para proteger tus credenciales de Aules y Google Drive.",
                "AUTH_ERROR": err_html,
                "AUTH_ACTION": "/auth/setup",
                "AUTH_LABEL": "Elige una contraseña de acceso (mín. 4 caracteres)",
                "AUTH_CONFIRM_FIELD": (
                    '<div class="field-group">'
                    '<label for="passcode_confirm" class="field-label">Confirmar contraseña</label>'
                    '<input id="passcode_confirm" name="passcode_confirm" type="password" required minlength="4" class="input" placeholder="Repite la contraseña" />'
                    "</div>"
                ),
                "AUTH_BUTTON": "Crear contraseña y entrar",
            }
        else:
            values = {
                "AUTH_SUBTITLE": "Inicia sesión para gestionar tus asignaturas de Aules, Groq y Google Drive.",
                "AUTH_ERROR": err_html,
                "AUTH_ACTION": "/auth/login",
                "AUTH_LABEL": "Contraseña de acceso",
                "AUTH_CONFIRM_FIELD": "",
                "AUTH_BUTTON": "Entrar al estudio",
            }
        return _render_template(tpl, values).encode("utf-8")

    def _render_process_page(self, store: Any, aules_connected: bool, has_drive: bool, err: str, ok: str) -> bytes:
        latest_run = None
        if store.runs:
            latest_run = get_run(store.runs[0].id) or store.runs[0]
        is_running = bool(latest_run and latest_run.status == "running")

        todo_tasks = [t for t in store.tasks if is_task_actionable(t)]
        ref_count = sum(1 for t in store.tasks if is_task_submitted_in_aules(t))
        no_sub_count = sum(1 for t in store.tasks if is_task_no_submission(t))
        solved_count = sum(
            1
            for t in todo_tasks
            if t.deliverables and len(t.deliverables.homework_solution_md.strip()) >= 100
        )
        synced_count = sum(1 for t in todo_tasks if t.status == "synced")
        pending_count = max(0, len(todo_tasks) - synced_count)

        skipped_parts = []
        if ref_count > 0:
            skipped_parts.append(f"{ref_count} hechas (ref.)")
        if no_sub_count > 0:
            skipped_parts.append(f"{no_sub_count} sin entrega online")
        skipped_text = " · ".join(skipped_parts) if skipped_parts else "Solo resuelve las entregables sin hacer"

        groq_ok = is_groq_configured()
        ready_full = aules_connected and groq_ok
        can_pending = groq_ok and len(todo_tasks) > 0

        if is_running and latest_run:
            topbar_cta = (
                f'<form method="post" action="/agent/cancel">'
                f'<input type="hidden" name="run_id" value="{_esc(latest_run.id)}" />'
                f'<button type="submit" class="btn btn-danger">Detener Agente</button></form>'
            )
            action_btns = topbar_cta
        else:
            btns: list[str] = []
            if can_pending and pending_count > 0:
                btns.append(
                    '<form method="post" action="/agent/run">'
                    '<input type="hidden" name="mode" value="pending_only" />'
                    f'<button type="submit" class="btn btn-primary">Hacer no hechas y subir a Drive ({pending_count})</button></form>'
                )
            btns.append(
                '<form method="post" action="/agent/run">'
                '<input type="hidden" name="mode" value="full" />'
                f'<button type="submit" class="btn {"" if (can_pending and pending_count > 0) else "btn-primary"}" '
                f'{"disabled" if not ready_full else ""}>Ejecutar ciclo completo</button></form>'
            )
            btns.append(
                '<form method="post" action="/agent/run">'
                '<input type="hidden" name="mode" value="full" />'
                '<input type="hidden" name="force_regenerate" value="1" />'
                f'<button type="submit" class="btn" {"disabled" if not ready_full else ""}>Reprocesar todo</button></form>'
            )
            action_btns = "".join(btns)
            if can_pending and pending_count > 0:
                topbar_cta = (
                    '<form method="post" action="/agent/run">'
                    '<input type="hidden" name="mode" value="pending_only" />'
                    '<button type="submit" class="btn btn-primary">Hacer sin entregar y subir a Drive</button></form>'
                )
            elif ready_full:
                topbar_cta = (
                    '<form method="post" action="/agent/run">'
                    '<input type="hidden" name="mode" value="full" />'
                    '<button type="submit" class="btn btn-primary">Ejecutar Agente</button></form>'
                )
            else:
                topbar_cta = '<a href="/connections" class="btn btn-primary">Configurar Agente</a>'

        prereq_banner = ""
        if not ready_full:
            prereq_banner = (
                '<section class="card card-pad">'
                '<div style="display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:16px;">'
                '<div><h2 class="card-title">Prepara las conexiones para iniciar el agente</h2>'
                '<p class="card-subtitle">Aules: '
                f'{"Activa" if aules_connected else "Pendiente"} · Groq: '
                f'{"Configurada" if groq_ok else "Falta GROQ_API_KEY"} · Google Drive: '
                f'{"Autorizado" if has_drive else "Opcional / pendiente"}</p></div>'
                '<a href="/connections" class="btn btn-primary">Configurar conexiones</a>'
                "</div></section>"
            )

        from core.pipeline import build_initial_stages

        stages = latest_run.stages if latest_run and latest_run.stages else build_initial_stages()
        stages_html = ""
        for st in stages:
            st_cls = "active" if is_running and latest_run and latest_run.current_stage == st.index else ""
            if st.status == "completed":
                st_label, st_tone = (f"{st.completed_items} / {st.total_items}" if st.total_items > 0 else "Listo"), "tone-success"
            elif st.status == "active":
                st_label, st_tone = (f"{st.completed_items} / {st.total_items}" if st.total_items > 0 else "En curso"), "tone-active"
            elif st.status == "error":
                st_label, st_tone = "Error", "tone-error"
            else:
                st_label, st_tone = "Pendiente", "tone-muted"
            stages_html += (
                f'<li class="stage-item {st_cls}">'
                f'<div><p class="stage-name">0{st.index}. {_esc(st.title)}</p>'
                f'<p class="stage-desc">{_esc(st.description)}</p></div>'
                f'<span class="stage-status {st_tone}">{_esc(st_label)}</span></li>'
            )

        logs = list(reversed(latest_run.logs)) if latest_run else []
        if not logs:
            logs_html = (
                '<div class="empty-box"><p>Aún no hay actividad registrada. Ejecuta el agente para ver cada documento y tarea resuelta en vivo.</p></div>'
            )
        else:
            logs_html = ""
            for lg in logs:
                lvl_tone = {
                    "error": "tone-error",
                    "warning": "tone-warning",
                    "success": "tone-success",
                }.get(lg.level, "tone-muted")
                lvl_txt = {"error": "Error", "warning": "Aviso", "success": "Completado"}.get(lg.level, "Proceso")
                t_short = lg.timestamp[11:19] if len(lg.timestamp) >= 19 else lg.timestamp
                det = f'<p class="log-detail">{_esc(lg.detail)}</p>' if lg.detail else ""
                logs_html += (
                    f'<div class="log-entry">'
                    f'<div class="log-meta"><span>{_esc(t_short)}</span><span>·</span>'
                    f'<span>Etapa 0{lg.stage}</span><span>·</span>'
                    f'<span class="{lvl_tone}">{lvl_txt}</span></div>'
                    f'<p class="log-msg">{_esc(lg.message)}</p>{det}</div>'
                )

        status_map = {
            "running": "En ejecución",
            "completed": "Completado",
            "cancelled": "Cancelado",
            "error": "Detenido por error",
        }
        run_status_label = status_map.get(latest_run.status if latest_run else "", "En espera")
        dur_meta = (
            f'<span>·</span><span class="mono">Duración {_format_duration(latest_run.started_at, latest_run.finished_at)}</span>'
            if latest_run and latest_run.started_at
            else ""
        )
        pct = latest_run.overall_progress if latest_run else 0
        p_cls = "error" if latest_run and latest_run.status == "error" else ("done" if latest_run and latest_run.status == "completed" else "")

        content = _render_template(
            _load_template("process.html"),
            {
                "TOTAL_COURSES": str(len(store.courses)),
                "SOLVED_TASKS": str(solved_count),
                "TOTAL_TASKS": str(len(todo_tasks)),
                "SKIPPED_BREAKDOWN": _esc(skipped_text),
                "SYNCED_TASKS": str(synced_count),
                "AUTO_SYNC_LABEL": f"Cada {store.auto_sync_interval_minutes} min" if store.auto_sync_enabled else "Manual",
                "SELECTED_MODEL": _esc(store.selected_model),
                "PREREQ_BANNER": prereq_banner,
                "RUN_STATUS_LABEL": _esc(run_status_label),
                "RUN_DURATION_META": dur_meta,
                "RUN_ACTION_BUTTONS": action_btns,
                "CURRENT_ITEM_LABEL": _esc(latest_run.current_item_label if latest_run else "Listo para conectar con Aules y comenzar el análisis"),
                "PROGRESS_PCT": str(pct),
                "PROGRESS_CLASS": p_cls,
                "STAGES_HTML": stages_html,
                "LOG_COUNT": str(len(logs)),
                "LOGS_HTML": logs_html,
            },
        )
        return self._render_shell(
            section="process",
            title="Proceso en Vivo",
            breadcrumb="Proceso en Vivo",
            content_html=content,
            store=store,
            aules_connected=aules_connected,
            has_drive=has_drive,
            flash_error=err,
            flash_notice=ok,
            auto_refresh=is_running,
            topbar_cta=topbar_cta,
        )

    def _render_tasks_page(
        self,
        store: Any,
        qs: dict[str, list[str]],
        aules_connected: bool,
        has_drive: bool,
        err: str,
        ok: str,
    ) -> bytes:
        filter_mode = (qs.get("filter") or ["pending"])[0]
        course_filter = (qs.get("course") or ["all"])[0]
        search_q = (qs.get("q") or [""])[0].strip()
        selected_id = (qs.get("task") or [""])[0]
        active_tab = (qs.get("tab") or ["homework"])[0]

        tasks: list[TaskRecord] = store.tasks
        cnt_pending = cnt_ref = cnt_nosub = cnt_solved = cnt_synced = 0
        for t in tasks:
            if is_task_no_submission(t):
                cnt_nosub += 1
            elif is_task_submitted_in_aules(t):
                cnt_ref += 1
            else:
                cnt_pending += 1
                if t.status == "solved":
                    cnt_solved += 1
                if t.status == "synced":
                    cnt_synced += 1

        tabs_def = [
            ("pending", f"Sin hacer ({cnt_pending})"),
            ("reference", f"Hechas · Referencia ({cnt_ref})"),
            ("no_submission", f"Sin entrega online ({cnt_nosub})"),
            ("solved", f"Resueltas ({cnt_solved})"),
            ("synced", f"En Drive ({cnt_synced})"),
            ("all", f"Todas ({len(tasks)})"),
        ]
        filter_tabs_html = "".join(
            f'<a href="/tasks?filter={fid}&course={urllib.parse.quote(course_filter)}&q={urllib.parse.quote(search_q)}" '
            f'class="seg-item {"active" if filter_mode == fid else ""}">{_esc(flabel)}</a>'
            for fid, flabel in tabs_def
        )
        course_options_html = "".join(
            f'<option value="{_esc(c.id)}" {"selected" if course_filter == c.id else ""}>{_esc(c.name)}</option>'
            for c in store.courses
        )

        filtered: list[TaskRecord] = []
        for t in tasks:
            if course_filter != "all" and t.course_id != course_filter:
                continue
            done = is_task_submitted_in_aules(t)
            no_sub = is_task_no_submission(t)
            act = is_task_actionable(t)
            if filter_mode == "pending" and not act:
                continue
            if filter_mode == "reference" and not done:
                continue
            if filter_mode == "no_submission" and not no_sub:
                continue
            if filter_mode == "solved" and (not act or t.status != "solved"):
                continue
            if filter_mode == "synced" and (not act or t.status != "synced"):
                continue
            if search_q:
                ql = search_q.lower()
                if ql not in t.title.lower() and ql not in t.course_name.lower() and ql not in t.description_text.lower():
                    continue
            filtered.append(t)

        if not tasks:
            body_html = (
                '<div class="card empty-box"><h2>Todavía no hay tareas descargadas de Aules</h2>'
                '<p>Ejecuta el agente desde Proceso en Vivo para escanear tus asignaturas y resolver únicamente las tareas sin hacer.</p>'
                '<div style="margin-top:20px;"><a href="/" class="btn btn-primary">Ir a Proceso en Vivo</a></div></div>'
            )
        else:
            sel = next((t for t in filtered if t.id == selected_id), None) or (filtered[0] if filtered else None)
            rows_html = ""
            if not filtered:
                rows_html = '<div class="empty-box"><p>No hay tareas que coincidan con el filtro aplicado.</p></div>'
            else:
                for t in filtered:
                    st_txt, st_tone = _status_badge_meta(t)
                    is_sel = sel and sel.id == t.id
                    href = (
                        f"/tasks?filter={urllib.parse.quote(filter_mode)}&course={urllib.parse.quote(course_filter)}"
                        f"&q={urllib.parse.quote(search_q)}&task={urllib.parse.quote(t.id)}&tab={urllib.parse.quote(active_tab)}"
                    )
                    due_seg = f'<span>·</span><span>{_esc(t.due_date)}</span>' if t.due_date else ""
                    rows_html += (
                        f'<a href="{href}" class="list-row {"active" if is_sel else ""}">'
                        f'<div class="list-row-top"><span class="list-row-title">{_esc(t.title)}</span>'
                        f'<span class="{st_tone}" style="font-size:12px;white-space:nowrap;">{_esc(st_txt)}</span></div>'
                        f'<div class="meta-line"><span>{_esc(t.course_name)}</span>'
                        f'<span>·</span><span class="mono">{len(t.attachments)} adjunto(s)</span>{due_seg}</div></a>'
                    )

            if not sel:
                inspector_html = '<div class="empty-box"><p>Selecciona una tarea de la lista para ver sus detalles.</p></div>'
            else:
                sel_done = is_task_submitted_in_aules(sel)
                sel_nosub = is_task_no_submission(sel)
                sel_act = is_task_actionable(sel)
                active_fmts = sel.export_formats or ([sel.deliverables.output_format] if sel.deliverables else ["pdf"])

                aules_href = is_safe_external_href(sel.url)
                actions = (
                    f'<a href="{_esc(aules_href)}" target="_blank" rel="noreferrer" class="btn btn-sm">Ver en Aules</a>'
                    f'<form method="post" action="/tasks/solve">'
                    f'<input type="hidden" name="task_id" value="{_esc(sel.id)}" />'
                    f'<button type="submit" class="btn btn-sm">'
                    f'{"Regenerar" if sel.deliverables else ("Generar borrador" if not sel_act else "Resolver ahora")}'
                    f"</button></form>"
                )
                if sel_act:
                    actions += (
                        f'<form method="post" action="/tasks/sync">'
                        f'<input type="hidden" name="task_id" value="{_esc(sel.id)}" />'
                        f'<button type="submit" class="btn btn-primary btn-sm" {"disabled" if not has_drive else ""}>Sincronizar Drive</button></form>'
                    )

                drive_link_html = ""
                if sel.drive_folder_link:
                    dl_href = is_safe_external_href(sel.drive_folder_link)
                    drive_link_html = f'<div style="margin-top:8px;font-size:12px;">Carpeta en Drive: <a href="{_esc(dl_href)}" target="_blank" rel="noreferrer">Abrir carpeta en Google Drive</a></div>'

                err_box = (
                    f'<div class="banner banner-error" style="margin-top:10px;">{_esc(sel.error_message)}</div>'
                    if sel.status == "error" and sel.error_message
                    else ""
                )

                notice_band = ""
                if sel_nosub:
                    notice_band = (
                        '<div class="section-band" style="background-color:#f8fafc;">'
                        '<strong style="font-size:12px;">Actividad sin entrega en línea (nota o registro presencial)</strong>'
                        '<p style="margin:4px 0 0;font-size:12px;color:var(--text-secondary);">'
                        'Aules indica que esta actividad no requiere enviar archivos ni texto en línea; el agente la omite automáticamente.</p></div>'
                    )
                elif sel_done:
                    sub_txt = (
                        f'<pre class="pre-code">{_esc(sel.submitted_work_text)}</pre>'
                        if sel.submitted_work_text
                        else ""
                    )
                    notice_band = (
                        '<div class="section-band" style="background-color:#f8fafc;">'
                        '<strong style="font-size:12px;">Tarea ya entregada en Aules · Descargada como ejemplo de tu estilo</strong>'
                        f'<p style="margin:4px 0 0;font-size:12px;color:var(--text-secondary);">El agente aprende tu tono y formato de esta entrega para aplicarlo en las pendientes de {_esc(sel.course_name)}.</p>{sub_txt}</div>'
                    )

                format_band = ""
                if sel_act:
                    fmt_checks = "".join(
                        f'<label style="display:inline-flex;align-items:center;gap:4px;font-size:12px;font-family:var(--font-mono);">'
                        f'<input type="checkbox" name="formats" value="{fmt}" {"checked" if fmt in active_fmts else ""} /> {fmt.upper()}</label>'
                        for fmt in ("html", "pdf", "docx")
                    )
                    dl_links = ""
                    if sel.deliverables:
                        dl_links = '<div class="inline-form"><span style="font-size:12px;color:var(--text-muted);">Descargar:</span>' + "".join(
                            f'<a href="/tasks/{urllib.parse.quote(sel.id)}/export/{fmt}" class="btn btn-sm mono">{fmt.upper()}</a>'
                            for fmt in ("html", "pdf", "docx", "md")
                        ) + "</div>"
                    format_band = (
                        '<div class="section-band" style="background-color:#f8fafc;display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:12px;">'
                        f'<form method="post" action="/tasks/formats" class="inline-form">'
                        f'<input type="hidden" name="task_id" value="{_esc(sel.id)}" />'
                        f'<span style="font-size:12px;font-weight:600;">Formatos Drive:</span>{fmt_checks}'
                        '<button type="submit" class="btn btn-sm">Guardar</button></form>'
                        f'{dl_links}</div>'
                    )

                tab_base = (
                    f"/tasks?filter={urllib.parse.quote(filter_mode)}&course={urllib.parse.quote(course_filter)}"
                    f"&q={urllib.parse.quote(search_q)}&task={urllib.parse.quote(sel.id)}"
                )
                sub_tabs = "".join(
                    f'<a href="{tab_base}&tab={tid}" class="seg-item {"active" if active_tab == tid else ""}">{_esc(tlabel)}</a>'
                    for tid, tlabel in (
                        ("homework", "Deberes resueltos"),
                        ("notes", "Apuntes de estudio"),
                        ("analysis", "Análisis"),
                        ("attachments", f"Documentación ({len(sel.attachments)})"),
                    )
                )

                if active_tab == "attachments":
                    att_items = ""
                    for a in sel.attachments:
                        src_lbl = {
                            "user_attachment": "Adjuntado por ti",
                            "student_submission": "Tu entrega en Aules",
                            "course_resource": "Recurso del curso",
                        }.get(a.source_type, "Enunciado Aules")
                        del_btn = (
                            f'<form method="post" action="/tasks/attachments/delete">'
                            f'<input type="hidden" name="task_id" value="{_esc(sel.id)}" />'
                            f'<input type="hidden" name="att_id" value="{_esc(a.id)}" />'
                            f'<button type="submit" class="btn btn-sm btn-danger">Quitar</button></form>'
                            if a.source_type == "user_attachment"
                            else ""
                        )
                        preview = f'<pre class="pre-code">{_esc(a.extracted_text)}</pre>' if a.extracted_text else ""
                        kb_size = f"{max(1, round(a.byte_size / 1024))} KB" if a.byte_size > 0 else "Pendiente"
                        att_items += (
                            f'<div style="padding:12px 0;border-bottom:1px solid var(--bg-subtle);">'
                            f'<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;">'
                            f'<div><strong>{_esc(a.name)}</strong> <span style="font-size:12px;color:var(--text-muted);">· {_esc(src_lbl)}</span></div>'
                            f'<div class="inline-form"><span class="mono" style="font-size:12px;color:var(--text-muted);">{kb_size}</span>{del_btn}</div></div>{preview}</div>'
                        )
                    tab_body = (
                        f'<form method="post" action="/tasks/attachments/upload" enctype="multipart/form-data" '
                        f'style="padding:14px;border:1px dashed var(--border-strong);border-radius:8px;background:#f8fafc;margin-bottom:16px;display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:12px;">'
                        f'<input type="hidden" name="task_id" value="{_esc(sel.id)}" />'
                        f'<div><strong style="font-size:12px;">Adjuntar HTML, PDF, DOCX o texto para Groq</strong></div>'
                        f'<div class="inline-form"><input type="file" name="file" accept=".html,.htm,.pdf,.docx,.txt,.md,.csv" required style="font-size:12px;" />'
                        f'<button type="submit" class="btn btn-sm btn-primary">Subir archivo</button></div></form>'
                        + (att_items or '<p style="font-size:13px;color:var(--text-muted);">Sin adjuntos aún en esta tarea.</p>')
                    )
                elif not sel.deliverables:
                    tab_body = '<div class="empty-box"><p>Esta tarea aún no tiene entregables generados. Pulsa "Resolver ahora" para generarla con Groq.</p></div>'
                else:
                    ctx_line = (
                        f'<span>·</span><span>Contexto usado: {_esc(", ".join(sel.deliverables.context_sources_used))}</span>'
                        if sel.deliverables.context_sources_used
                        else ""
                    )
                    md_body = (
                        sel.deliverables.homework_solution_md
                        if active_tab == "homework"
                        else (sel.deliverables.study_notes_md if active_tab == "notes" else sel.deliverables.requirement_analysis_md)
                    )
                    tab_body = (
                        f'<div class="meta-line" style="margin-top:0;margin-bottom:12px;">'
                        f'<span>Modelo: {_esc(sel.deliverables.model_used)}</span><span>·</span>'
                        f'<span>Formato: {_esc(sel.deliverables.output_format.upper())}</span>{ctx_line}</div>'
                        f'<pre class="pre-prose">{_esc(md_body)}</pre>'
                    )

                due_badge = f'<span>·</span><span>Entrega: {_esc(sel.due_date)}</span>' if sel.due_date else ""
                inspector_html = (
                    f'<div class="section-band">'
                    f'<div class="meta-line" style="margin-top:0;"><span>{_esc(sel.course_name)}</span><span>·</span>'
                    f'<span>{_esc(sel.submission_status)}</span>{due_badge}</div>'
                    f'<div style="margin-top:8px;display:flex;flex-wrap:wrap;justify-content:space-between;align-items:flex-start;gap:12px;">'
                    f'<h2 class="card-title">{_esc(sel.title)}</h2><div class="inline-form">{actions}</div></div>'
                    f'{drive_link_html}{err_box}</div>'
                    f'{notice_band}{format_band}'
                    f'<div class="section-band" style="background:#f8fafc;">'
                    f'<strong style="font-size:12px;">Enunciado extraído de Aules</strong>'
                    f'<p style="margin:6px 0 0;font-size:13px;max-height:110px;overflow-y:auto;white-space:pre-line;">{_esc(sel.description_text)}</p></div>'
                    f'<div class="section-band"><div class="segmented">{sub_tabs}</div></div>'
                    f'<div style="padding:20px 24px;max-height:460px;overflow-y:auto;">{tab_body}</div>'
                )

            body_html = (
                '<div class="split-12">'
                f'<section class="card col-5"><div class="card-header" style="padding:12px 20px;">'
                f'<span class="mono" style="font-size:12px;color:var(--text-muted);">Mostrando {len(filtered)} de {len(tasks)} tareas</span></div>'
                f'<div class="list-scroll">{rows_html}</div></section>'
                f'<section class="card col-7">{inspector_html}</section></div>'
            )

        content = _render_template(
            _load_template("tasks.html"),
            {
                "FILTER_TABS_HTML": filter_tabs_html,
                "ACTIVE_FILTER": _esc(filter_mode),
                "COURSES_COUNT": str(len(store.courses)),
                "COURSE_OPTIONS_HTML": course_options_html,
                "SEARCH_QUERY": _esc(search_q),
                "TASKS_BODY_HTML": body_html,
            },
        )
        return self._render_shell(
            section="tasks",
            title="Asignaturas y Tareas",
            breadcrumb="Asignaturas y Tareas",
            content_html=content,
            store=store,
            aules_connected=aules_connected,
            has_drive=has_drive,
            flash_error=err,
            flash_notice=ok,
            topbar_cta='<a href="/" class="btn btn-primary">Ir a Proceso en Vivo</a>',
        )

    def _render_knowledge_page(self, store: Any, qs: dict[str, list[str]], aules_connected: bool, has_drive: bool, err: str, ok: str) -> bytes:
        subjects = list(store.knowledge.values())
        if not subjects:
            body_html = (
                '<div class="card empty-box"><h2>La Base de Aprendizaje está vacía</h2>'
                '<p>Cada vez que el agente analiza tus asignaturas de Aules, guarda aquí tu estilo, conceptos clave y criterios.</p>'
                '<div style="margin-top:20px;"><a href="/" class="btn btn-primary">Ejecutar primer análisis</a></div></div>'
            )
        else:
            sel_cid = (qs.get("course") or [subjects[0].course_id])[0]
            active = store.knowledge.get(sel_cid) or subjects[0]
            sub_rows = "".join(
                f'<a href="/knowledge?course={urllib.parse.quote(s.course_id)}" class="list-row {"active" if s.course_id == active.course_id else ""}">'
                f'<div class="list-row-title">{_esc(s.course_name)}</div>'
                f'<div class="meta-line"><span class="mono">{len(s.learned_task_ids)} tareas</span><span>·</span>'
                f'<span class="mono">{len(s.key_concepts)} conceptos</span></div></a>'
                for s in subjects
            )
            concepts_li = "".join(f"<li>{_esc(c)}</li>" for c in active.key_concepts) or "<li>Sin conceptos aún.</li>"
            criteria_li = "".join(f"<li>{_esc(c)}</li>" for c in active.evaluation_criteria) or "<li>Sin criterios detectados aún.</li>"
            tips_li = "".join(f"<li>{_esc(t)}</li>" for t in active.study_tips)
            drive_btn = (
                f'<a href="{_esc(is_safe_external_href(active.drive_web_view_link))}" target="_blank" rel="noreferrer" class="btn btn-sm">Abrir memoria en Drive</a>'
                if active.drive_web_view_link
                else ""
            )
            body_html = (
                '<div class="split-12">'
                f'<section class="card col-4"><div class="card-header"><h2 class="card-title">Asignaturas ({len(subjects)})</h2></div>'
                f'<div class="list-scroll">{sub_rows}</div></section>'
                f'<section class="card card-pad col-8" style="display:flex;flex-direction:column;gap:18px;">'
                f'<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;border-bottom:1px solid var(--border-hairline);padding-bottom:14px;">'
                f'<div><div class="meta-line" style="margin-top:0;"><span class="mono">{len(active.learned_task_ids)} tareas aprendidas</span>'
                f'<span>·</span><span>{_esc(active.updated_at[:10])}</span></div><h2 class="card-title" style="margin-top:4px;font-size:20px;">{_esc(active.course_name)}</h2></div>'
                f'{drive_btn}</div>'
                f'<div><h3 class="card-title" style="font-size:14px;">Resumen de enfoque y temario</h3><p style="margin:6px 0 0;">{_esc(active.summary)}</p></div>'
                f'<div style="padding:14px;border:1px solid var(--border-hairline);border-radius:8px;background:#f8fafc;">'
                f'<strong style="font-size:13px;">Cómo trabajas en esta asignatura</strong>'
                f'<p style="margin:6px 0 0;font-size:13px;">{_esc(active.student_work_style)}</p></div>'
                f'<div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px;">'
                f'<div><h3 class="card-title" style="font-size:14px;">Conceptos clave</h3><ol style="padding-left:18px;font-size:14px;">{concepts_li}</ol></div>'
                f'<div><h3 class="card-title" style="font-size:14px;">Criterios de evaluación</h3><ol style="padding-left:18px;font-size:14px;">{criteria_li}</ol></div></div>'
                + (f'<div><h3 class="card-title" style="font-size:14px;">Recomendaciones</h3><ul style="padding-left:18px;font-size:14px;">{tips_li}</ul></div>' if tips_li else "")
                + "</section></div>"
            )

        content = _render_template(_load_template("knowledge.html"), {"KNOWLEDGE_BODY_HTML": body_html})
        return self._render_shell(
            section="knowledge",
            title="Base de Aprendizaje",
            breadcrumb="Base de Aprendizaje",
            content_html=content,
            store=store,
            aules_connected=aules_connected,
            has_drive=has_drive,
            flash_error=err,
            flash_notice=ok,
            topbar_cta='<a href="/" class="btn btn-primary">Ir a Proceso en Vivo</a>',
        )

    def _render_drive_page(self, store: Any, aules_connected: bool, has_drive: bool, err: str, ok: str) -> bytes:
        token = get_valid_drive_access_token(DEFAULT_UID)
        if not token:
            cta = (
                '<a href="/auth/google" class="btn btn-primary">Conectar con Google Drive</a>'
                if is_google_oauth_configured()
                else '<a href="/connections" class="btn btn-primary">Configurar Google OAuth</a>'
            )
            body_html = (
                '<div class="card empty-box"><h2>Conecta Google Drive para explorar tus carpetas</h2>'
                '<p>Autoriza Google Drive OAuth en Conexiones para visualizar la carpeta raíz Aules Sync y sus entregas.</p>'
                f'<div style="margin-top:20px;">{cta}</div></div>'
            )
        else:
            try:
                root_id, root_link = ensure_drive_folder(token, "Aules Sync")
                store.drive_root_folder_id = root_id
                store.drive_root_folder_link = root_link
                write_user_store(store)
                courses_items = [
                    c
                    for c in list_drive_folder_children(token, root_id)
                    if c.get("mimeType") == "application/vnd.google-apps.folder"
                ]
                cards_html = ""
                for cf in courses_items:
                    subs = list_drive_folder_children(token, cf["id"])
                    sub_html = ""
                    for sub in subs:
                        files = list_drive_folder_children(token, sub["id"]) if sub.get("mimeType") == "application/vnd.google-apps.folder" else []
                        files_li = "".join(
                            f'<li><a href="{_esc(is_safe_external_href(f.get("webViewLink")))}" target="_blank" rel="noreferrer">{_esc(f["name"])}</a></li>'
                            for f in files
                        )
                        files_ul = (
                            f'<ul style="margin:6px 0 0;padding-left:20px;font-size:13px;">{files_li}</ul>'
                            if files_li
                            else ""
                        )
                        sub_html += (
                            f'<div style="padding:10px 0;border-bottom:1px solid var(--bg-subtle);">'
                            f'<strong>{_esc(sub["name"])}</strong> <span class="mono" style="font-size:12px;color:var(--text-muted);">({len(files)})</span>'
                            f'{files_ul}</div>'
                        )
                    cf_link = is_safe_external_href(cf.get("webViewLink"))
                    cards_html += (
                        f'<div style="padding:20px 24px;border-bottom:1px solid var(--border-hairline);">'
                        f'<div style="display:flex;justify-content:space-between;align-items:center;">'
                        f'<h3 class="card-title">{_esc(cf["name"])}</h3>'
                        f'<a href="{_esc(cf_link)}" target="_blank" rel="noreferrer" class="btn btn-sm">Abrir asignatura</a></div>'
                        f'<div style="margin-top:10px;">{sub_html}</div></div>'
                    )
                empty_drive_html = '<div class="empty-box"><p>La carpeta Aules Sync todavía no contiene asignaturas.</p></div>'
                body_html = (
                    f'<div class="card card-header"><div><h2 class="card-title">Estructura en Google Drive (Aules Sync)</h2>'
                    f'<p class="card-subtitle">Subcarpetas por asignatura, memoria de aprendizaje y cada tarea</p></div>'
                    f'<div class="inline-form"><a href="/drive" class="btn btn-sm">Actualizar</a>'
                    f'<a href="{_esc(is_safe_external_href(root_link))}" target="_blank" rel="noreferrer" class="btn btn-primary btn-sm">Abrir Aules Sync</a></div></div>'
                    f'<div class="card">{cards_html or empty_drive_html}</div>'
                )
            except Exception as exc:
                body_html = f'<div class="banner banner-error">Error al leer Google Drive: {_esc(exc)}</div>'

        content = _render_template(_load_template("drive.html"), {"DRIVE_BODY_HTML": body_html})
        return self._render_shell(
            section="drive",
            title="Google Drive",
            breadcrumb="Google Drive",
            content_html=content,
            store=store,
            aules_connected=aules_connected,
            has_drive=has_drive,
            flash_error=err,
            flash_notice=ok,
        )

    def _render_connections_page(self, store: Any, aules_connected: bool, has_drive: bool, err: str, ok: str) -> bytes:
        aules_active_card = ""
        if aules_connected and store.aules_profile:
            aules_active_card = (
                f'<div class="banner banner-success" style="margin-bottom:16px;display:flex;justify-content:space-between;align-items:center;gap:12px;">'
                f'<div><strong>{_esc(store.aules_profile.full_name)}</strong><div style="font-size:12px;">{_esc(store.aules_profile.username)} · {_esc(store.aules_profile.base_url)}</div></div>'
                f'<form method="post" action="/connections/aules/disconnect"><button type="submit" class="btn btn-sm">Desconectar Aules</button></form></div>'
            )

        if has_drive:
            drive_card_body = (
                '<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;">'
                '<span style="font-size:13px;">Token de Google Drive activo y renovable automáticamente.</span>'
                '<form method="post" action="/connections/google/disconnect"><button type="submit" class="btn btn-sm">Desconectar</button></form></div>'
            )
            drive_status_txt, drive_status_cls = "Activa", "tone-success"
        elif is_google_oauth_configured():
            drive_card_body = '<a href="/auth/google" class="btn btn-primary">Conectar con Google Drive (OAuth)</a>'
            drive_status_txt, drive_status_cls = "Pendiente", "tone-warning"
        else:
            drive_card_body = (
                '<div class="banner banner-info">Define <span class="mono">GOOGLE_CLIENT_ID</span> y '
                '<span class="mono">GOOGLE_CLIENT_SECRET</span> en <span class="mono">.env</span> para autorizar Google Drive desde el servidor Python.</div>'
            )
            drive_status_txt, drive_status_cls = "OAuth sin configurar", "tone-muted"

        groq_ok = is_groq_configured()
        groq_warn = (
            '<div class="banner banner-error" style="margin-bottom:14px;">Configura <span class="mono">GROQ_API_KEY</span> en las variables de entorno antes de ejecutar el agente.</div>'
            if not groq_ok
            else ""
        )
        models = list_groq_models()
        model_opts = "".join(
            f'<option value="{_esc(m["id"])}" {"selected" if m["id"] == store.selected_model else ""}>{_esc(m["name"])}</option>'
            for m in models
        )
        interval_opts = "".join(
            f'<option value="{mins}" {"selected" if store.auto_sync_interval_minutes == mins else ""}>Cada {mins} minutos</option>'
            for mins in (15, 30, 60, 120)
        )

        content = _render_template(
            _load_template("connections.html"),
            {
                "AULES_STATUS_CLASS": "tone-success" if aules_connected else "tone-warning",
                "AULES_STATUS_TEXT": "Conectado" if aules_connected else "Desconectado",
                "AULES_ACTIVE_CARD": aules_active_card,
                "AULES_URL": _esc(store.aules_profile.base_url if store.aules_profile else "https://aules.edu.gva.es/fp"),
                "AULES_USERNAME": _esc(store.aules_profile.username if store.aules_profile else ""),
                "AULES_SUBMIT_LABEL": "Renovar sesión de Aules" if aules_connected else "Conectar con Aules",
                "DRIVE_STATUS_CLASS": drive_status_cls,
                "DRIVE_STATUS_TEXT": drive_status_txt,
                "DRIVE_CARD_BODY": drive_card_body,
                "GROQ_STATUS_CLASS": "tone-success" if groq_ok else "tone-error",
                "GROQ_STATUS_TEXT": "Lista" if groq_ok else "Sin configurar",
                "GROQ_WARNING_BANNER": groq_warn,
                "MODEL_OPTIONS_HTML": model_opts,
                "INTERVAL_OPTIONS_HTML": interval_opts,
                "AUTO_SYNC_CHECKED": "checked" if store.auto_sync_enabled else "",
            },
        )
        return self._render_shell(
            section="connections",
            title="Conexiones",
            breadcrumb="Conexiones",
            content_html=content,
            store=store,
            aules_connected=aules_connected,
            has_drive=has_drive,
            flash_error=err,
            flash_notice=ok,
        )

    def do_GET(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        qs = urllib.parse.parse_qs(parsed.query)

        if path == "/health":
            self._send_bytes(200, "application/json", json.dumps({"ok": True, "groqConfigured": is_groq_configured()}).encode("utf-8"))
            return

        if path == "/static/styles.css":
            css_bytes = resolve_confined_path(STATIC_DIR, "styles.css").read_bytes()
            self._send_bytes(200, "text/css; charset=utf-8", css_bytes)
            return

        if path == "/login":
            if self._is_authenticated():
                self._redirect("/")
                return
            err = (qs.get("err") or [""])[0]
            self._send_bytes(200, "text/html; charset=utf-8", self._render_login_page(err))
            return

        uid = self._is_authenticated()
        if not uid:
            self._redirect("/login")
            return

        err = (qs.get("err") or [""])[0]
        ok = (qs.get("ok") or [""])[0]

        if path == "/auth/google":
            if not is_google_oauth_configured():
                self._redirect("/connections?err=" + urllib.parse.quote("Faltan GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET."))
                return
            state = secrets.token_urlsafe(24)
            _OAUTH_STATES[state] = time.time() + 600
            redirect_uri = os.environ.get("GOOGLE_REDIRECT_URI", "").strip() or f"http://{self.headers.get('Host', 'localhost:3000')}/auth/google/callback"
            self._redirect(build_google_auth_url(redirect_uri, state))
            return

        if path == "/auth/google/callback":
            state = (qs.get("state") or [""])[0]
            code = (qs.get("code") or [""])[0]
            exp = _OAUTH_STATES.pop(state, 0)
            if not code or exp < time.time():
                self._redirect("/connections?err=" + urllib.parse.quote("Autorización de Google inválida o caducada."))
                return
            try:
                redirect_uri = os.environ.get("GOOGLE_REDIRECT_URI", "").strip() or f"http://{self.headers.get('Host', 'localhost:3000')}/auth/google/callback"
                exchange_google_code(code, redirect_uri, uid)
                self._redirect("/connections?ok=" + urllib.parse.quote("Google Drive autorizado correctamente."))
            except Exception as exc:
                self._redirect("/connections?err=" + urllib.parse.quote(str(exc)))
            return

        # Export deliverable endpoint: /tasks/<task_id>/export/<fmt>
        if path.startswith("/tasks/") and "/export/" in path:
            parts = path.strip("/").split("/")
            if len(parts) == 4 and parts[0] == "tasks" and parts[2] == "export":
                task_id = urllib.parse.unquote(parts[1])
                fmt = parts[3].lower()
                if fmt not in ("html", "pdf", "docx", "md"):
                    self._send_bytes(400, "text/plain; charset=utf-8", b"Formato no soportado.")
                    return
                store = read_user_store(uid)
                task = next((t for t in store.tasks if t.id == task_id), None)
                if not task or not task.deliverables:
                    self._send_bytes(404, "text/plain; charset=utf-8", b"La tarea no tiene entregables generados.")
                    return
                fname, mime, raw_bytes = build_deliverable_file(fmt, task, task.deliverables)
                self._send_bytes(
                    200,
                    mime,
                    raw_bytes,
                    {"Content-Disposition": f'attachment; filename="{sanitize_file_name(fname)}"'},
                )
                return

        store = _normalize_store_tasks(uid)
        aules_sess = get_or_restore_aules_session(uid)
        if aules_sess:
            try:
                age = time.time() - datetime.fromisoformat(aules_sess.connected_at.replace("Z", "+00:00")).timestamp()
                if age > 300:
                    if not verify_aules_session_alive(aules_sess):
                        clear_aules_session(uid)
                        aules_sess = None
                    else:
                        aules_sess.connected_at = datetime.now(timezone.utc).isoformat()
                        set_aules_session(uid, aules_sess)
            except Exception:
                pass

        aules_connected = aules_sess is not None
        has_drive = get_valid_drive_access_token(uid) is not None

        if path == "/":
            self._send_bytes(200, "text/html; charset=utf-8", self._render_process_page(store, aules_connected, has_drive, err, ok))
        elif path == "/tasks":
            self._send_bytes(200, "text/html; charset=utf-8", self._render_tasks_page(store, qs, aules_connected, has_drive, err, ok))
        elif path == "/knowledge":
            self._send_bytes(200, "text/html; charset=utf-8", self._render_knowledge_page(store, qs, aules_connected, has_drive, err, ok))
        elif path == "/drive":
            self._send_bytes(200, "text/html; charset=utf-8", self._render_drive_page(store, aules_connected, has_drive, err, ok))
        elif path == "/connections":
            self._send_bytes(200, "text/html; charset=utf-8", self._render_connections_page(store, aules_connected, has_drive, err, ok))
        else:
            self._send_bytes(404, "text/plain; charset=utf-8", b"Ruta no encontrada")

    def do_POST(self) -> None:
        path = urllib.parse.urlparse(self.path).path
        if not self._verify_same_origin_post():
            self._send_bytes(403, "text/plain; charset=utf-8", b"Origen no autorizado.")
            return

        if path == "/auth/setup":
            env_pass = os.environ.get("AULES_APP_PASSCODE", "").strip()
            if env_pass or has_claimed_admin_passcode():
                self._redirect("/login?err=" + urllib.parse.quote("La contraseña maestra ya está configurada."))
                return
            form = self._read_form_urlencoded()
            p1 = form.get("passcode", "")
            p2 = form.get("passcode_confirm", "")
            if len(p1) < 4 or p1 != p2:
                self._redirect("/login?err=" + urllib.parse.quote("Las contraseñas deben coincidir y tener al menos 4 caracteres."))
                return
            if claim_admin_passcode(p1):
                token = create_signed_session_cookie(DEFAULT_UID)
                self._redirect("/", {"Set-Cookie": self._cookie_header(token)})
            else:
                self._redirect("/login?err=" + urllib.parse.quote("La contraseña ya fue reclamada."))
            return

        if path == "/auth/login":
            form = self._read_form_urlencoded()
            pwd = form.get("passcode", "")
            env_pass = os.environ.get("AULES_APP_PASSCODE", "").strip()
            valid = hmac.compare_digest(pwd, env_pass) if env_pass else verify_claimed_admin_passcode(pwd)
            if not valid:
                self._redirect("/login?err=" + urllib.parse.quote("Contraseña incorrecta."))
                return
            token = create_signed_session_cookie(DEFAULT_UID)
            self._redirect("/", {"Set-Cookie": self._cookie_header(token)})
            return

        if path == "/auth/logout":
            self._redirect("/login", {"Set-Cookie": self._cookie_header("", clear=True)})
            return

        uid = self._is_authenticated()
        if not uid:
            self._redirect("/login")
            return

        if path == "/connections/aules":
            form = self._read_form_urlencoded()
            try:
                sess = connect_aules(form.get("base_url", ""), form.get("username", ""), form.get("password", ""))
                set_aules_session(uid, sess)
                store = read_user_store(uid)
                store.aules_profile = AulesProfile(
                    base_url=sess.base_url,
                    username=sess.username,
                    full_name=sess.full_name,
                    last_connected_at=sess.connected_at,
                )
                write_user_store(store)
                self._redirect("/connections?ok=" + urllib.parse.quote("Sesión web iniciada en Aules."))
            except Exception as exc:
                self._redirect("/connections?err=" + urllib.parse.quote(str(exc)))
            return

        if path == "/connections/aules/disconnect":
            clear_aules_session(uid)
            self._redirect("/connections?ok=" + urllib.parse.quote("Sesión de Aules desconectada."))
            return

        if path == "/connections/google/disconnect":
            clear_drive_oauth_tokens(uid)
            self._redirect("/connections?ok=" + urllib.parse.quote("Google Drive desconectado."))
            return

        if path == "/connections/settings":
            form = self._read_form_urlencoded()
            store = read_user_store(uid)
            store.selected_model = normalize_groq_model(form.get("selected_model"))
            store.auto_sync_enabled = form.get("auto_sync_enabled") == "1"
            try:
                mins = int(form.get("auto_sync_interval_minutes", "30"))
                store.auto_sync_interval_minutes = max(5, min(240, mins))
            except ValueError:
                pass
            write_user_store(store)
            self._redirect("/connections?ok=" + urllib.parse.quote("Preferencias guardadas."))
            return

        if path == "/agent/run":
            form = self._read_form_urlencoded()
            mode = "pending_only" if form.get("mode") == "pending_only" else "full"
            force_regen = form.get("force_regenerate") == "1"
            if not is_groq_configured():
                self._redirect("/?err=" + urllib.parse.quote("Configura GROQ_API_KEY en el entorno del servidor."))
                return
            store = read_user_store(uid)
            if (mode != "pending_only" or not store.tasks) and not get_or_restore_aules_session(uid):
                self._redirect("/connections?err=" + urllib.parse.quote("Conecta tus credenciales de Aules primero."))
                return
            start_background_run(uid, mode=mode, force_regenerate=force_regen)
            self._redirect("/")
            return

        if path == "/agent/cancel":
            form = self._read_form_urlencoded()
            run_id = form.get("run_id", "")
            if run_id:
                mark_run_cancelled(run_id)
            self._redirect("/?ok=" + urllib.parse.quote("Cancelación solicitada."))
            return

        if path == "/tasks/solve":
            form = self._read_form_urlencoded()
            task_id = form.get("task_id", "")
            if not is_groq_configured():
                self._redirect(f"/tasks?task={urllib.parse.quote(task_id)}&err=" + urllib.parse.quote("Falta GROQ_API_KEY."))
                return
            store = read_user_store(uid)
            task = next((t for t in store.tasks if t.id == task_id), None)
            if not task:
                self._redirect("/tasks?err=" + urllib.parse.quote("Tarea no encontrada."))
                return
            try:
                course_docs = store.course_resources.get(task.course_id, [])
                if not course_docs and needs_extra_course_context(task):
                    sess = get_or_restore_aules_session(uid)
                    course = next((c for c in store.courses if c.id == task.course_id), None)
                    if sess and course:
                        discovered = discover_course_resources_for_course(sess, course.id, course.url)
                        dl_docs: list[AttachmentRecord] = []
                        for item in discovered[:6]:
                            try:
                                raw_b, fname, mime, bsize, txt = download_and_extract_attachment(sess, item)
                                item.name = fname
                                item.mime_type = mime
                                item.byte_size = bsize
                                item.extracted_text = txt
                                item.downloaded = True
                                item.local_cache_key = save_attachment_cache(uid, item.id, raw_b)
                                dl_docs.append(item)
                            except Exception:
                                pass
                        if dl_docs:
                            store.course_resources[task.course_id] = dl_docs
                            course_docs = dl_docs

                refs = get_course_reference_examples(store.tasks, task.course_id, task.id)
                deliv = solve_and_analyze_task(
                    store.selected_model, task, store.knowledge.get(task.course_id), course_docs, refs
                )
                task.deliverables = deliv
                if not task.export_formats:
                    task.export_formats = [deliv.output_format or "pdf"]
                task.status = "solved"
                task.error_message = None
                task.updated_at = datetime.now(timezone.utc).isoformat()
                write_user_store(store)
                self._redirect(
                    f"/tasks?filter=all&task={urllib.parse.quote(task.id)}&ok="
                    + urllib.parse.quote(f"Tarea '{task.title}' resuelta correctamente.")
                )
            except Exception as exc:
                self._redirect(f"/tasks?filter=all&task={urllib.parse.quote(task.id)}&err=" + urllib.parse.quote(str(exc)))
            return

        if path == "/tasks/sync":
            form = self._read_form_urlencoded()
            task_id = form.get("task_id", "")
            token = get_valid_drive_access_token(uid)
            if not token:
                self._redirect(f"/tasks?filter=all&task={urllib.parse.quote(task_id)}&err=" + urllib.parse.quote("Autoriza Google Drive en Conexiones."))
                return
            store = read_user_store(uid)
            task = next((t for t in store.tasks if t.id == task_id), None)
            if not task:
                self._redirect("/tasks?err=" + urllib.parse.quote("Tarea no encontrada."))
                return
            try:
                root_id, root_link = ensure_drive_folder(token, "Aules Sync")
                store.drive_root_folder_id = root_id
                store.drive_root_folder_link = root_link
                c_id, _ = ensure_drive_folder(token, task.course_name, root_id)
                t_id, t_link = ensure_drive_folder(token, sanitize_file_name(task.title), c_id)
                task.drive_folder_id = t_id
                task.drive_folder_link = t_link

                synced: list[dict[str, str]] = []
                for att in task.attachments:
                    raw_b = read_attachment_cache(att.local_cache_key) if att.local_cache_key else (att.extracted_text.encode("utf-8") if att.extracted_text else None)
                    if raw_b:
                        fid, flink, rname = sync_file_to_drive(token, t_id, att.name, att.mime_type, raw_b)
                        synced.append({"name": rname, "fileId": fid, "webViewLink": flink, "updatedAt": datetime.now(timezone.utc).isoformat()})

                if task.deliverables:
                    docs = [
                        ("01_analisis_requisitos.md", "text/markdown", task.deliverables.requirement_analysis_md.encode("utf-8")),
                        ("02_apuntes_estudio.md", "text/markdown", task.deliverables.study_notes_md.encode("utf-8")),
                        ("03_deberes_resueltos.md", "text/markdown", task.deliverables.homework_solution_md.encode("utf-8")),
                    ]
                    fmts = list(dict.fromkeys(f for f in (task.export_formats or [task.deliverables.output_format or "pdf"]) if f != "md"))
                    for fmt in fmts:
                        docs.append(build_deliverable_file(fmt, task, task.deliverables))
                    for fname, mime, raw_b in docs:
                        fid, flink, rname = sync_file_to_drive(token, t_id, fname, mime, raw_b)
                        synced.append({"name": rname, "fileId": fid, "webViewLink": flink, "updatedAt": datetime.now(timezone.utc).isoformat()})

                task.drive_files = synced
                task.status = "synced"
                task.updated_at = datetime.now(timezone.utc).isoformat()
                write_user_store(store)
                self._redirect(f"/tasks?filter=all&task={urllib.parse.quote(task.id)}&ok=" + urllib.parse.quote("Sincronizada en Google Drive."))
            except Exception as exc:
                self._redirect(f"/tasks?filter=all&task={urllib.parse.quote(task.id)}&err=" + urllib.parse.quote(str(exc)))
            return

        if path == "/tasks/formats":
            raw = self._read_body(64 * 1024).decode("utf-8", errors="ignore")
            qs_form = urllib.parse.parse_qs(raw)
            task_id = (qs_form.get("task_id") or [""])[0]
            fmts = [f for f in qs_form.get("formats", []) if f in ("html", "pdf", "docx", "md")]
            store = read_user_store(uid)
            task = next((t for t in store.tasks if t.id == task_id), None)
            if task and fmts:
                task.export_formats = list(dict.fromkeys(fmts))
                write_user_store(store)
            self._redirect(f"/tasks?filter=all&task={urllib.parse.quote(task_id)}&ok=" + urllib.parse.quote("Formatos actualizados."))
            return

        if path == "/tasks/attachments/upload":
            fields, files = self._read_multipart()
            task_id = fields.get("task_id", "")
            if not files:
                self._redirect(f"/tasks?filter=all&task={urllib.parse.quote(task_id)}&tab=attachments&err=" + urllib.parse.quote("Selecciona un archivo."))
                return
            _, filename, mime, raw_bytes = files[0]
            safe_name = sanitize_file_name(filename)
            if not any(safe_name.lower().endswith(ext) for ext in (".html", ".htm", ".pdf", ".docx", ".txt", ".md", ".csv")):
                self._redirect(f"/tasks?filter=all&task={urllib.parse.quote(task_id)}&tab=attachments&err=" + urllib.parse.quote("Solo HTML, PDF, DOCX, TXT, MD o CSV."))
                return
            if not (1 <= len(raw_bytes) <= 12 * 1024 * 1024):
                self._redirect(f"/tasks?filter=all&task={urllib.parse.quote(task_id)}&tab=attachments&err=" + urllib.parse.quote("Tamaño entre 1 byte y 12 MB."))
                return
            store = read_user_store(uid)
            task = next((t for t in store.tasks if t.id == task_id), None)
            if not task:
                self._redirect("/tasks?err=" + urllib.parse.quote("Tarea no encontrada."))
                return
            att_id = f"usr_{secrets.token_hex(6)}"
            cache_key = save_attachment_cache(uid, att_id, raw_bytes)
            extracted = extract_text_from_bytes(safe_name, mime, raw_bytes)
            task.attachments.append(
                AttachmentRecord(
                    id=att_id,
                    name=safe_name,
                    source_url=f"local://user_attachment/{att_id}",
                    mime_type=mime or "application/octet-stream",
                    byte_size=len(raw_bytes),
                    downloaded=True,
                    local_cache_key=cache_key,
                    extracted_text=extracted,
                    source_type="user_attachment",
                )
            )
            write_user_store(store)
            self._redirect(f"/tasks?filter=all&task={urllib.parse.quote(task_id)}&tab=attachments&ok=" + urllib.parse.quote(f"Adjuntado {safe_name}."))
            return

        if path == "/tasks/attachments/delete":
            form = self._read_form_urlencoded()
            task_id = form.get("task_id", "")
            att_id = form.get("att_id", "")
            store = read_user_store(uid)
            task = next((t for t in store.tasks if t.id == task_id), None)
            if task:
                task.attachments = [a for a in task.attachments if not (a.id == att_id and a.source_type == "user_attachment")]
                write_user_store(store)
            self._redirect(f"/tasks?filter=all&task={urllib.parse.quote(task_id)}&tab=attachments&ok=" + urllib.parse.quote("Adjunto eliminado."))
            return

        self._send_bytes(404, "text/plain; charset=utf-8", b"Accion no encontrada")


def main() -> None:
    _load_dotenv()
    _start_auto_sync_scheduler()
    port = int(os.environ.get("PORT", "3000"))
    server = ThreadingHTTPServer(("0.0.0.0", port), AulesRequestHandler)
    print(f"Aules Sync Agent (Python) escuchando en http://0.0.0.0:{port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.shutdown()


if __name__ == "__main__":
    main()
