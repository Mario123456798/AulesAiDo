from __future__ import annotations

import secrets
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

from .aules_client import (
    discover_course_resources_for_course,
    discover_courses_and_tasks,
    download_and_extract_attachment,
)
from .context_engine import (
    is_task_actionable,
    is_task_no_submission,
    is_task_submitted_in_aules,
)
from .document_builder import build_deliverable_file
from .drive_sync import ensure_drive_folder, get_valid_drive_access_token, sync_file_to_drive
from .groq_client import (
    learn_from_course_materials,
    normalize_groq_model,
    solve_and_analyze_task,
)
from .models import (
    AttachmentRecord,
    PipelineLogEntry,
    PipelineRun,
    PipelineStageState,
    SubjectKnowledge,
    TaskRecord,
)
from .security import sanitize_file_name
from .store import (
    get_or_restore_aules_session,
    is_run_cancelled,
    read_attachment_cache,
    read_user_store,
    register_run,
    save_attachment_cache,
    write_user_store,
)


def build_initial_stages() -> list[PipelineStageState]:
    return [
        PipelineStageState(1, "Autenticación en Aules", "Validando sesión activa o tareas ya guardadas."),
        PipelineStageState(2, "Detección de Cursos y Tareas", "Escaneando asignaturas, entregas reales y avisos sin entrega en línea."),
        PipelineStageState(3, "Descarga e Indexación Local", "Descargando adjuntos y recursos de asignatura para contexto bajo demanda."),
        PipelineStageState(4, "Aprendizaje Local y Estilo del Alumno", "Indexando temario localmente y sintetizando tu estilo con entregas previas."),
        PipelineStageState(5, "Resolución Secuencial de Tareas Sin Hacer", "Resolviendo tareas pendientes en cola controlada por TPM y contexto relevante."),
        PipelineStageState(6, "Sincronización Directa con Google Drive", "Subiendo y actualizando automáticamente carpetas y entregables en Drive."),
    ]


def create_pipeline_run(uid: str = "local") -> PipelineRun:
    run = PipelineRun(
        id=f"run_{int(time.time() * 1000)}_{secrets.token_hex(4)}",
        uid=uid,
        status="running",
        current_stage=1,
        overall_progress=0,
        current_item_label="Iniciando agente...",
        started_at=datetime.now(timezone.utc).isoformat(),
        stages=build_initial_stages(),
    )
    register_run(run)
    return run


def _add_log(run: PipelineRun, stage: int, level: str, message: str, detail: str | None = None) -> None:
    entry = PipelineLogEntry(
        id=secrets.token_hex(6),
        timestamp=datetime.now(timezone.utc).isoformat(),
        stage=stage,
        level=level,
        message=message,
        detail=detail,
    )
    run.logs = [*run.logs[-149:], entry]


def _set_stage(run: PipelineRun, stage_idx: int, **patch: object) -> None:
    run.current_stage = stage_idx
    for st in run.stages:
        if st.index == stage_idx:
            for k, v in patch.items():
                setattr(st, k, v)
    score = 0.0
    for st in run.stages:
        if st.status == "completed":
            score += 1.0
        elif st.status in ("active", "paused"):
            frac = st.completed_items / st.total_items if st.total_items > 0 else 0.2
            score += min(0.95, max(0.1, frac))
    run.overall_progress = round((score / max(1, len(run.stages))) * 100)


def _persist_run(uid: str, run: PipelineRun) -> None:
    store = read_user_store(uid)
    idx = next((i for i, r in enumerate(store.runs) if r.id == run.id), -1)
    if idx >= 0:
        store.runs[idx] = run
    else:
        store.runs = [run, *store.runs][:15]
    write_user_store(store)


def _format_knowledge_md(kb: SubjectKnowledge) -> str:
    concepts = "\n".join(f"- {c}" for c in kb.key_concepts) or "- Sin conceptos."
    criteria = "\n".join(f"- {c}" for c in kb.evaluation_criteria) or "- Sin criterios."
    tips = "\n".join(f"- {c}" for c in kb.study_tips) or "- Sin recomendaciones."
    return (
        f"# Base de Aprendizaje — {kb.course_name}\n\n"
        f"Actualizado: {kb.updated_at}\n"
        f"Tareas integradas: {len(kb.learned_task_ids)}\n\n"
        f"## Resumen\n{kb.summary}\n\n"
        f"## Estilo del Estudiante\n{kb.student_work_style}\n"
        f"Formatos habituales: {', '.join(kb.student_preferred_formats)}\n\n"
        f"## Conceptos Clave\n{concepts}\n\n"
        f"## Criterios de Evaluación\n{criteria}\n\n"
        f"## Recomendaciones\n{tips}\n"
    )


def get_course_reference_examples(
    all_tasks: list[TaskRecord], course_id: str, exclude_task_id: str | None = None
) -> list[dict]:
    out = []
    for t in all_tasks:
        if t.course_id != course_id or t.id == exclude_task_id or not is_task_submitted_in_aules(t):
            continue
        sub_files = [a for a in t.attachments if a.source_type == "student_submission"]
        files_txt = "\n".join(f"[{a.name}]: {a.extracted_text[:700]}" for a in sub_files)
        combined = "\n".join(x for x in (t.submitted_work_text or "", files_txt) if x).strip()
        out.append(
            {
                "task_title": t.title,
                "submission_summary": combined
                or f"Entrega en Aules ({t.submission_status}) sobre: {t.description_text[:350]}",
                "file_names": [f.name for f in sub_files],
            }
        )
        if len(out) >= 3:
            break
    return out


def _is_task_incomplete(task: TaskRecord) -> bool:
    if not is_task_actionable(task):
        return False
    if not task.deliverables:
        return True
    sol = (task.deliverables.homework_solution_md or "").strip()
    return len(sol) < 100 or "No se generó solución" in sol


def execute_pipeline_run(
    run: PipelineRun,
    *,
    uid: str = "local",
    mode: str = "full",
    force_regenerate: bool = False,
) -> None:
    try:
        store = read_user_store(uid)
        session = get_or_restore_aules_session(uid)
        use_existing = mode == "pending_only" and len(store.tasks) > 0

        # Stage 1: Session / Store verification
        _set_stage(run, 1, status="active", completed_items=0, total_items=1)
        if use_existing:
            run.current_item_label = "Cargando tareas detectadas y recursos indexados"
            _set_stage(run, 1, status="completed", completed_items=1)
            _add_log(run, 1, "success", f"Modo pendientes: {len(store.tasks)} tareas cargadas.")
        else:
            if not session:
                raise RuntimeError("No hay una sesión activa de Aules. Conecta tus credenciales en Conexiones.")
            _set_stage(run, 1, status="completed", completed_items=1)
            _add_log(run, 1, "success", f"Sesión verificada para {session.full_name} ({session.base_url})")

        if is_run_cancelled(run.id):
            raise RuntimeError("Proceso cancelado por el usuario.")

        # Stage 2: Discovery or normalization
        _set_stage(run, 2, status="active", completed_items=0, total_items=1)
        course_resources = dict(store.course_resources)
        if use_existing:
            for t in store.tasks:
                if is_task_no_submission(t):
                    t.requires_online_submission = False
                    t.is_submitted_in_aules = False
                    t.deliverables = None
                    t.status = "no_submission"
                elif is_task_submitted_in_aules(t):
                    t.is_submitted_in_aules = True
                    t.status = "synced" if t.status == "synced" else "reference"
                elif t.status == "awaiting_drive_confirm" and t.deliverables:
                    t.status = "solved"
                elif t.status == "error":
                    t.status = "detected"
                    t.error_message = None
            write_user_store(store)
            _set_stage(run, 2, status="completed", completed_items=1)
            _add_log(
                run,
                2,
                "info",
                f"Clasificadas {sum(1 for t in store.tasks if is_task_actionable(t))} tareas accionables.",
            )
        else:
            assert session is not None
            run.current_item_label = "Escaneando cursos, entregas y recursos en Aules"
            _add_log(run, 2, "info", "Explorando asignaturas, tareas y temario en Aules...")
            courses, discovered_tasks, discovered_res = discover_courses_and_tasks(
                session, lambda msg: setattr(run, "current_item_label", msg)
            )
            prev_by_id = {t.id: t for t in store.tasks}
            merged_tasks: list[TaskRecord] = []
            for dt in discovered_tasks:
                prev = prev_by_id.get(dt.id)
                if prev:
                    user_atts = [a for a in prev.attachments if a.source_type == "user_attachment"]
                    prev_by_url = {a.source_url: a for a in prev.attachments}
                    for a in dt.attachments:
                        pa = prev_by_url.get(a.source_url)
                        if pa and pa.downloaded:
                            a.downloaded = True
                            a.local_cache_key = pa.local_cache_key
                            a.extracted_text = pa.extracted_text
                            a.byte_size = pa.byte_size
                            a.drive_file_id = pa.drive_file_id
                            a.drive_web_view_link = pa.drive_web_view_link
                    dt.attachments = [*dt.attachments, *user_atts]
                    dt.export_formats = prev.export_formats
                    if prev.deliverables and dt.requires_online_submission is not False and not dt.is_submitted_in_aules:
                        dt.deliverables = prev.deliverables
                        dt.drive_folder_id = prev.drive_folder_id
                        dt.drive_folder_link = prev.drive_folder_link
                        dt.drive_files = prev.drive_files
                        dt.status = "synced" if prev.status == "synced" else "solved"
                merged_tasks.append(dt)
            store.courses = courses
            store.tasks = merged_tasks

            for cid, new_docs in discovered_res.items():
                prev_docs = {d.source_url: d for d in course_resources.get(cid, [])}
                for d in new_docs:
                    pd = prev_docs.get(d.source_url)
                    if pd and pd.downloaded:
                        d.downloaded = True
                        d.local_cache_key = pd.local_cache_key
                        d.extracted_text = pd.extracted_text
                        d.byte_size = pd.byte_size
                course_resources[cid] = new_docs
            store.course_resources = course_resources
            write_user_store(store)
            _set_stage(run, 2, status="completed", completed_items=1)
            _add_log(run, 2, "success", f"Detectadas {len(courses)} asignaturas y {len(merged_tasks)} tareas.")

        if is_run_cancelled(run.id):
            raise RuntimeError("Proceso cancelado por el usuario.")

        # On-demand course resource discovery if missing in pending_only mode
        if session:
            for c in store.courses:
                if not course_resources.get(c.id):
                    try:
                        course_resources[c.id] = discover_course_resources_for_course(session, c.id, c.url)
                    except Exception:
                        pass
            store.course_resources = course_resources
            write_user_store(store)

        # Stage 3: Download course resources & task attachments
        pending_course_docs = [
            d
            for docs in course_resources.values()
            for d in docs[:15]
            if not d.downloaded or not d.local_cache_key
        ]
        pending_task_atts = [
            att
            for t in store.tasks
            for att in t.attachments
            if not att.downloaded or not att.local_cache_key
        ]
        total_dl = len(pending_course_docs) + len(pending_task_atts)
        _set_stage(run, 3, status="active", completed_items=0, total_items=max(1, total_dl))
        if not session or total_dl == 0:
            _set_stage(run, 3, status="completed", completed_items=max(1, total_dl))
            _add_log(run, 3, "info", "Documentación ya indexada localmente en disco.")
        else:
            _add_log(run, 3, "info", f"Descargando {total_dl} documento(s) de apoyo y adjuntos...")
            dl_done = 0

            def _dl_doc(att: AttachmentRecord) -> None:
                nonlocal dl_done
                try:
                    raw, fname, mime, bsize, txt = download_and_extract_attachment(session, att)
                    att.name = fname
                    att.mime_type = mime
                    att.byte_size = bsize
                    att.extracted_text = txt
                    att.downloaded = True
                    att.local_cache_key = save_attachment_cache(uid, att.id, raw)
                except Exception:
                    pass
                dl_done += 1
                _set_stage(run, 3, completed_items=dl_done)

            with ThreadPoolExecutor(max_workers=4) as pool:
                list(pool.map(_dl_doc, pending_course_docs + pending_task_atts))
            write_user_store(store)
            _set_stage(run, 3, status="completed", completed_items=max(1, total_dl))
            _add_log(run, 3, "success", "Descarga e indexación local completadas.")

        if is_run_cancelled(run.id):
            raise RuntimeError("Proceso cancelado por el usuario.")

        # Stage 4: Local Knowledge + Style synthesis (0 AI calls unless new rich submissions)
        active_model = normalize_groq_model(store.selected_model)
        _set_stage(run, 4, status="active", completed_items=0, total_items=max(1, len(store.courses)))
        for idx, c in enumerate(store.courses, start=1):
            if is_run_cancelled(run.id):
                break
            c_tasks = [t for t in store.tasks if t.course_id == c.id]
            c_docs = course_resources.get(c.id, [])
            kb = learn_from_course_materials(
                active_model,
                c.id,
                c.name,
                store.knowledge.get(c.id),
                c_tasks,
                c_docs,
                lambda s, m: setattr(run, "current_item_label", f"Pausa TPM ({s}s · {m}) analizando {c.name}"),
            )
            store.knowledge[c.id] = kb
            _set_stage(run, 4, completed_items=idx)
        write_user_store(store)
        _set_stage(run, 4, status="completed", completed_items=max(1, len(store.courses)))
        _add_log(run, 4, "success", "Base de aprendizaje local y estilo consolidados.")

        # Stage 5: Sequential TPM-governed solving of actionable pending tasks
        tasks_to_solve = [
            t
            for t in store.tasks
            if is_task_actionable(t) and (force_regenerate or _is_task_incomplete(t))
        ]
        _set_stage(run, 5, status="active", completed_items=0, total_items=max(1, len(tasks_to_solve)))
        _add_log(run, 5, "info", f"Resolviendo {len(tasks_to_solve)} tarea(s) sin hacer con {active_model}...")

        for idx, t in enumerate(tasks_to_solve, start=1):
            if is_run_cancelled(run.id):
                raise RuntimeError("Proceso cancelado por el usuario.")
            run.current_item_label = f"Resolviendo ({idx}/{len(tasks_to_solve)}): {t.title}"
            try:
                refs = get_course_reference_examples(store.tasks, t.course_id, t.id)
                deliv = solve_and_analyze_task(
                    active_model,
                    t,
                    store.knowledge.get(t.course_id),
                    course_resources.get(t.course_id, []),
                    refs,
                    lambda s, m, title=t.title: setattr(
                        run, "current_item_label", f"Pausa TPM ({s}s · {m}) antes de {title}"
                    ),
                )
                t.deliverables = deliv
                if not t.export_formats:
                    t.export_formats = [deliv.output_format or "pdf"]
                t.status = "solved"
                t.error_message = None
                t.updated_at = datetime.now(timezone.utc).isoformat()
                write_user_store(store)
                ctx_note = (
                    f"Contexto: {', '.join(deliv.context_sources_used)}"
                    if deliv.context_sources_used
                    else None
                )
                _add_log(run, 5, "success", f"Resuelta ({idx}/{len(tasks_to_solve)}): {t.title}", ctx_note)
            except Exception as err:
                t.status = "error"
                t.error_message = str(err)
                write_user_store(store)
                _add_log(run, 5, "error", f"Error en {t.title}", str(err))
            _set_stage(run, 5, completed_items=idx)
            _persist_run(uid, run)

        _set_stage(run, 5, status="completed", completed_items=max(1, len(tasks_to_solve)))

        # Stage 6: Direct Drive sync (auto_overwrite=True)
        drive_token = get_valid_drive_access_token(uid)
        tasks_to_sync = [t for t in store.tasks if is_task_actionable(t) and t.deliverables is not None]
        _set_stage(run, 6, status="active", completed_items=0, total_items=max(1, len(tasks_to_sync)))
        if not drive_token:
            _add_log(
                run,
                6,
                "warning",
                "Tareas resueltas localmente. Conecta Google Drive OAuth en Conexiones para subirlas.",
            )
            _set_stage(run, 6, status="completed", completed_items=max(1, len(tasks_to_sync)))
        else:
            root_id, root_link = ensure_drive_folder(drive_token, "Aules Sync")
            store.drive_root_folder_id = root_id
            store.drive_root_folder_link = root_link
            course_folders: dict[str, str] = {}

            for cid, kb in store.knowledge.items():
                cf_id, _ = ensure_drive_folder(drive_token, kb.course_name, root_id)
                course_folders[cid] = cf_id
                kb_id, _ = ensure_drive_folder(drive_token, "_Base_de_Aprendizaje", cf_id)
                f_id, f_link, _ = sync_file_to_drive(
                    drive_token, kb_id, "memoria_asignatura.md", "text/markdown", _format_knowledge_md(kb).encode("utf-8")
                )
                kb.drive_file_id = f_id
                kb.drive_web_view_link = f_link

            for idx, t in enumerate(tasks_to_sync, start=1):
                if is_run_cancelled(run.id):
                    break
                cf_id = course_folders.get(t.course_id)
                if not cf_id:
                    cf_id, _ = ensure_drive_folder(drive_token, t.course_name, root_id)
                    course_folders[t.course_id] = cf_id
                tf_id, tf_link = ensure_drive_folder(drive_token, sanitize_file_name(t.title), cf_id)
                t.drive_folder_id = tf_id
                t.drive_folder_link = tf_link

                for att in t.attachments:
                    raw_b = (
                        read_attachment_cache(att.local_cache_key)
                        if att.local_cache_key
                        else (att.extracted_text.encode("utf-8") if att.extracted_text else None)
                    )
                    if raw_b:
                        sync_file_to_drive(drive_token, tf_id, att.name, att.mime_type, raw_b)

                assert t.deliverables is not None
                docs_to_up = [
                    ("01_analisis_requisitos.md", "text/markdown", t.deliverables.requirement_analysis_md.encode("utf-8")),
                    ("02_apuntes_estudio.md", "text/markdown", t.deliverables.study_notes_md.encode("utf-8")),
                    ("03_deberes_resueltos.md", "text/markdown", t.deliverables.homework_solution_md.encode("utf-8")),
                ]
                fmts = list(dict.fromkeys(f for f in (t.export_formats or [t.deliverables.output_format or "pdf"]) if f != "md"))
                for fmt in fmts:
                    docs_to_up.append(build_deliverable_file(fmt, t, t.deliverables))

                synced_list: list[dict[str, str]] = []
                for fname, mime, raw_b in docs_to_up:
                    fid, flink, rname = sync_file_to_drive(drive_token, tf_id, fname, mime, raw_b)
                    synced_list.append(
                        {"name": rname, "fileId": fid, "webViewLink": flink, "updatedAt": datetime.now(timezone.utc).isoformat()}
                    )
                t.drive_files = synced_list
                t.status = "synced"
                t.updated_at = datetime.now(timezone.utc).isoformat()
                _set_stage(run, 6, completed_items=idx)
                _add_log(run, 6, "success", f"Subida a Drive ({idx}/{len(tasks_to_sync)}): {t.title}")
            write_user_store(store)
            _set_stage(run, 6, status="completed", completed_items=max(1, len(tasks_to_sync)))

        run.status = "completed"
        run.finished_at = datetime.now(timezone.utc).isoformat()
        run.overall_progress = 100
        run.current_item_label = "Proceso completado"
        _persist_run(uid, run)
    except Exception as exc:
        cancelled = is_run_cancelled(run.id)
        run.status = "cancelled" if cancelled else "error"
        run.error_message = str(exc)
        run.finished_at = datetime.now(timezone.utc).isoformat()
        run.current_item_label = "Proceso cancelado" if cancelled else f"Error: {exc}"
        _set_stage(run, run.current_stage, status="error")
        _add_log(run, run.current_stage, "warning" if cancelled else "error", str(exc))
        _persist_run(uid, run)


def start_background_run(uid: str = "local", mode: str = "full", force_regenerate: bool = False) -> PipelineRun:
    run = create_pipeline_run(uid)
    _persist_run(uid, run)
    th = threading.Thread(
        target=execute_pipeline_run,
        args=(run,),
        kwargs={"uid": uid, "mode": mode, "force_regenerate": force_regenerate},
        daemon=True,
    )
    th.start()
    return run
