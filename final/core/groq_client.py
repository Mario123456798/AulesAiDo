from __future__ import annotations

import json
import math
import os
import re
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from typing import Any, Callable

from .context_engine import (
    build_local_requirement_analysis,
    build_local_subject_knowledge,
    select_relevant_course_chunks,
)
from .models import AttachmentRecord, SubjectKnowledge, TaskDeliverables, TaskRecord

GROQ_BASE_URL = "https://api.groq.com/openai/v1"
DEFAULT_GROQ_MODEL = "llama-3.3-70b-versatile"

MODEL_BUDGETS: dict[str, dict[str, int]] = {
    "llama-3.3-70b-versatile": {"tpm": 12000, "max_chars": 14000, "max_out": 2500},
    "openai/gpt-oss-120b": {"tpm": 8000, "max_chars": 9600, "max_out": 2000},
    "openai/gpt-oss-20b": {"tpm": 8000, "max_chars": 9600, "max_out": 2000},
    "llama-3.1-8b-instant": {"tpm": 6000, "max_chars": 7500, "max_out": 1600},
}

FALLBACK_CHAIN = [
    "llama-3.3-70b-versatile",
    "openai/gpt-oss-20b",
    "llama-3.1-8b-instant",
]

FALLBACK_GROQ_MODELS = [
    {"id": "llama-3.3-70b-versatile", "name": "Llama 3.3 70B Versatile (Recomendado · 12K TPM)"},
    {"id": "openai/gpt-oss-120b", "name": "GPT-OSS 120B (Razonamiento · 8K TPM)"},
    {"id": "openai/gpt-oss-20b", "name": "GPT-OSS 20B (Rápido y eficiente · 8K TPM)"},
    {"id": "llama-3.1-8b-instant", "name": "Llama 3.1 8B Instant (Ultra rápido · 6K TPM)"},
]

_GROQ_LOCK = threading.Lock()
_RATE_STATE: dict[str, dict[str, Any]] = {}


def is_groq_configured() -> bool:
    return len(os.environ.get("GROQ_API_KEY", "").strip()) > 8


def normalize_groq_model(model: str | None) -> str:
    trimmed = (model or "").strip()
    if (
        not trimmed
        or trimmed.lower().startswith("grok")
        or trimmed.startswith("openrouter/")
        or ":free" in trimmed
    ):
        return DEFAULT_GROQ_MODEL
    return trimmed


def list_groq_models() -> list[dict[str, str]]:
    if not is_groq_configured():
        return FALLBACK_GROQ_MODELS
    try:
        req = urllib.request.Request(
            f"{GROQ_BASE_URL}/models",
            headers={"Authorization": f"Bearer {os.environ.get('GROQ_API_KEY', '').strip()}"},
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode("utf-8", errors="ignore"))
        raw_models = data.get("data") or []
        label_map = {m["id"]: m["name"] for m in FALLBACK_GROQ_MODELS}
        filtered = [
            {"id": m["id"], "name": label_map.get(m["id"], m["id"])}
            for m in raw_models
            if isinstance(m.get("id"), str)
            and m.get("active", True) is not False
            and not re.search(
                r"whisper|orpheus|tts|guard|safeguard|moderation|embed|compound-audio",
                m["id"],
                re.IGNORECASE,
            )
        ]
        if not filtered:
            return FALLBACK_GROQ_MODELS
        prio = {m["id"]: i for i, m in enumerate(FALLBACK_GROQ_MODELS)}
        filtered.sort(key=lambda m: (0, prio[m["id"]]) if m["id"] in prio else (1, m["id"]))
        return filtered
    except Exception:
        return FALLBACK_GROQ_MODELS


def _parse_duration_ms(raw: str | None) -> int:
    if not raw:
        return 0
    total = 0.0
    if m := re.search(r"(\d+(?:\.\d+)?)m(?!s)", raw, re.IGNORECASE):
        total += float(m.group(1)) * 60_000
    if m := re.search(r"(\d+(?:\.\d+)?)s", raw, re.IGNORECASE):
        total += float(m.group(1)) * 1000
    if m := re.search(r"(\d+(?:\.\d+)?)ms", raw, re.IGNORECASE):
        total += float(m.group(1))
    return round(total)


def _get_rate_state(model: str) -> dict[str, Any]:
    state = _RATE_STATE.setdefault(model, {"remaining": None, "reset_at": 0.0, "history": []})
    cutoff = time.time() - 62.0
    state["history"] = [h for h in state["history"] if h[0] >= cutoff]
    return state


def _wait_for_tpm_budget(
    model: str, needed_tokens: int, on_wait: Callable[[int, str], None] | None
) -> None:
    state = _get_rate_state(model)
    budget = MODEL_BUDGETS.get(model, {"tpm": 8000, "max_chars": 9600, "max_out": 2000})
    now = time.time()
    if (
        isinstance(state["remaining"], (int, float))
        and state["reset_at"] > now
        and state["remaining"] < needed_tokens
    ):
        wait_s = min(62.0, state["reset_at"] - now + 0.35)
        if wait_s > 0.4:
            if on_wait:
                on_wait(math.ceil(wait_s), model)
            time.sleep(wait_s)
        return

    used = sum(tok for _, tok in state["history"])
    if used + needed_tokens > budget["tpm"] * 0.9 and state["history"]:
        oldest = state["history"][0][0]
        wait_s = min(62.0, max(1.2, oldest + 61.0 - now))
        if on_wait:
            on_wait(math.ceil(wait_s), model)
        time.sleep(wait_s)


def _call_groq_raw(
    model: str,
    system_prompt: str,
    user_prompt: str,
    *,
    use_json: bool = False,
    max_tokens: int = 2400,
    on_wait: Callable[[int, str], None] | None = None,
) -> tuple[str, str]:
    api_key = os.environ.get("GROQ_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("Falta configurar GROQ_API_KEY en el entorno del servidor.")

    with _GROQ_LOCK:
        initial = normalize_groq_model(model)
        candidates = list(dict.fromkeys([initial, *FALLBACK_CHAIN]))
        allow_json = use_json
        active_prompt = user_prompt

        for active_model in candidates:
            budget = MODEL_BUDGETS.get(active_model, {"tpm": 8000, "max_chars": 9600, "max_out": 2000})
            max_in_chars = max(3000, budget["max_chars"] - len(system_prompt))
            if len(active_prompt) > max_in_chars:
                active_prompt = active_prompt[: max_in_chars - 24] + "\n[...compactado...]"

            input_est = math.ceil((len(system_prompt) + len(active_prompt)) / 3.2)
            safe_max = max(700, min(max_tokens, budget["max_out"], int(budget["tpm"] * 0.92) - input_est))

            for attempt in range(3):
                _wait_for_tpm_budget(active_model, input_est + safe_max, on_wait)
                payload: dict[str, Any] = {
                    "model": active_model,
                    "temperature": 0.22,
                    "max_tokens": safe_max,
                    "messages": [
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": active_prompt},
                    ],
                }
                if allow_json:
                    payload["response_format"] = {"type": "json_object"}

                req = urllib.request.Request(
                    f"{GROQ_BASE_URL}/chat/completions",
                    data=json.dumps(payload).encode("utf-8"),
                    headers={
                        "Authorization": f"Bearer {api_key}",
                        "Content-Type": "application/json",
                    },
                    method="POST",
                )
                try:
                    with urllib.request.urlopen(req, timeout=60) as resp:
                        hdrs = {k.lower(): v for k, v in resp.headers.items()}
                        body = json.loads(resp.read().decode("utf-8", errors="ignore"))
                except urllib.error.HTTPError as err:
                    hdrs = {k.lower(): v for k, v in err.headers.items()} if err.headers else {}
                    err_text = err.read().decode("utf-8", errors="ignore")
                    st = _get_rate_state(active_model)
                    st["history"].append((time.time(), input_est + safe_max))

                    if err.code == 400 and allow_json:
                        allow_json = False
                        continue
                    if err.code == 413:
                        active_prompt = active_prompt[: int(len(active_prompt) * 0.65)]
                        break
                    if err.code in (429, 502, 503, 504):
                        header_wait = _parse_duration_ms(hdrs.get("x-ratelimit-reset-tokens"))
                        retry_after = int(float(hdrs.get("retry-after", "0") or 0) * 1000)
                        bm = re.search(r"try again in\s+([0-9hms.]+)", err_text, re.IGNORECASE)
                        body_wait = _parse_duration_ms(bm.group(1)) if bm else 0
                        wait_ms = max(retry_after, header_wait, body_wait, 2000 * (2**attempt))
                        if wait_ms > 28_000:
                            break
                        if on_wait:
                            on_wait(math.ceil(wait_ms / 1000), active_model)
                        time.sleep(wait_ms / 1000.0 + 0.3)
                        continue
                    if attempt == 0 and len(candidates) > 1:
                        break
                    raise RuntimeError(f"Error en Groq API (HTTP {err.code}): {err_text[:220]}")

                st = _get_rate_state(active_model)
                rem = hdrs.get("x-ratelimit-remaining-tokens")
                if rem is not None:
                    try:
                        st["remaining"] = float(rem)
                    except ValueError:
                        pass
                reset_ms = _parse_duration_ms(hdrs.get("x-ratelimit-reset-tokens"))
                if reset_ms > 0:
                    st["reset_at"] = time.time() + reset_ms / 1000.0
                total_tok = (body.get("usage") or {}).get("total_tokens") or (input_est + safe_max)
                st["history"].append((time.time(), int(total_tok)))

                raw_text = (((body.get("choices") or [{}])[0].get("message") or {}).get("content") or "")
                cleaned = re.sub(r"<think>[\s\S]*?</think>", "", raw_text, flags=re.IGNORECASE).strip()
                if cleaned:
                    return cleaned, active_model
                if attempt < 1:
                    time.sleep(1.0)

        raise RuntimeError(
            "Groq API alcanzó temporalmente los límites de cuota en los modelos disponibles."
        )


def learn_from_course_materials(
    model: str,
    course_id: str,
    course_name: str,
    existing: SubjectKnowledge | None,
    tasks: list[TaskRecord],
    course_docs: list[AttachmentRecord],
    on_wait: Callable[[int, str], None] | None = None,
) -> SubjectKnowledge:
    local_kb = build_local_subject_knowledge(course_id, course_name, existing, tasks, course_docs)
    submitted_tasks = [t for t in tasks if t.is_submitted_in_aules]
    has_rich = any(
        (t.submitted_work_text and len(t.submitted_work_text) > 40)
        or any(a.source_type == "student_submission" and len(a.extracted_text) > 60 for a in t.attachments)
        for t in submitted_tasks
    )
    already_done = (
        existing is not None
        and bool(existing.student_work_style)
        and not existing.student_work_style.startswith("Aún no se han detectado")
        and all(t.id in existing.learned_task_ids for t in submitted_tasks)
    )
    if not has_rich or already_done:
        return local_kb

    digest_parts: list[str] = []
    for t in submitted_tasks[:3]:
        files_txt = "\n".join(
            f"{a.name}: {a.extracted_text[:750]}"
            for a in t.attachments
            if a.source_type == "student_submission"
        )
        online = f"Texto: {t.submitted_work_text[:650]}" if t.submitted_work_text else ""
        digest_parts.append(f"### {t.title}\n{online}\n{files_txt}")
    student_digest = "\n\n".join(digest_parts)[:2800]

    sys_p = (
        f'Analiza brevemente el estilo real de trabajo de un estudiante en "{course_name}" y responde SOLO JSON válido:\n'
        '{"summary":"resumen conciso","studentWorkStyle":"tono y estructura","studentPreferredFormats":["pdf","docx","html"],"keyConcepts":["..."],"evaluationCriteria":["..."]}'
    )
    usr_p = f"Entregas reales del alumno:\n{student_digest}\n\nConceptos locales: {', '.join(local_kb.key_concepts)}"

    try:
        raw, _ = _call_groq_raw(model, sys_p, usr_p, use_json=True, max_tokens=900, on_wait=on_wait)
        cleaned = re.sub(r"^```(?:json)?|```$", "", raw.strip(), flags=re.IGNORECASE | re.MULTILINE).strip()
        parsed = json.loads(cleaned[cleaned.find("{") : cleaned.rfind("}") + 1])
        local_kb.summary = parsed.get("summary") or local_kb.summary
        local_kb.student_work_style = parsed.get("studentWorkStyle") or local_kb.student_work_style
        if parsed.get("studentPreferredFormats"):
            local_kb.student_preferred_formats = [str(f).lower() for f in parsed["studentPreferredFormats"]]
        if parsed.get("keyConcepts"):
            local_kb.key_concepts = [str(c) for c in parsed["keyConcepts"]]
        if parsed.get("evaluationCriteria"):
            local_kb.evaluation_criteria = [str(c) for c in parsed["evaluationCriteria"]]
        local_kb.updated_at = datetime.now(timezone.utc).isoformat()
    except Exception:
        pass
    return local_kb


def _extract_section(text: str, marker: str, next_markers: list[str]) -> str:
    start = text.find(marker)
    if start < 0:
        return ""
    cstart = start + len(marker)
    end = len(text)
    for nxt in next_markers:
        idx = text.find(nxt, cstart)
        if idx >= 0 and idx < end:
            end = idx
    return text[cstart:end].strip()


def _normalize_output_format(
    raw_fmt: str, task: TaskRecord, preferred_formats: list[str] | None
) -> str:
    clean = raw_fmt.strip().lower()
    if "html" in clean:
        return "html"
    if "docx" in clean or "word" in clean:
        return "docx"
    if "pdf" in clean:
        return "pdf"
    if "md" in clean or "markdown" in clean:
        return "md"
    prompt = f"{task.title} {task.description_text}".lower()
    if re.search(r"\b(html|página web|web|css|etiquetas|formulario)\b", prompt):
        return "html"
    if re.search(r"\b(docx|word|\.doc)\b", prompt):
        return "docx"
    if re.search(r"\bpdf\b", prompt):
        return "pdf"
    if preferred_formats and preferred_formats[0].lower() in ("html", "pdf", "docx", "md"):
        return preferred_formats[0].lower()
    return "pdf"


def solve_and_analyze_task(
    model: str,
    task: TaskRecord,
    knowledge: SubjectKnowledge | None,
    course_docs: list[AttachmentRecord],
    reference_examples: list[dict[str, Any]] | None = None,
    on_wait: Callable[[int, str], None] | None = None,
) -> TaskDeliverables:
    safe_model = normalize_groq_model(model)

    user_att_digest = "\n\n".join(
        f"[Adjunto alumno {a.name}]:\n{a.extracted_text[:1800]}"
        for a in task.attachments
        if a.source_type == "user_attachment" and a.extracted_text.strip()
    )[:2400]

    task_att_digest = "\n\n".join(
        f"[Adjunto Aules {a.name}]:\n{a.extracted_text[:1400]}"
        for a in task.attachments
        if a.source_type not in ("user_attachment", "student_submission") and a.extracted_text.strip()
    )[:2200]

    context_digest, source_names = select_relevant_course_chunks(task, course_docs, max_total_chars=1800)

    ref_digest = ""
    if reference_examples:
        ex = reference_examples[0]
        ref_digest = (
            f"Ejemplo ({ex['task_title']} · {', '.join(ex.get('file_names') or ['texto'])}): "
            f"{str(ex['submission_summary'])[:800]}"
        )

    style_line = (
        f"{knowledge.student_work_style[:320]} | Formatos: {', '.join(knowledge.student_preferred_formats)}"
        if knowledge and knowledge.student_work_style
        else "Claro, estructurado, directo y técnico."
    )

    system_prompt = (
        "Resuelve COMPLETAMENTE una tarea pendiente de Aules adaptándote al estilo real del estudiante.\n"
        "Responde en español usando exactamente estas etiquetas:\n\n"
        "<<<FORMATO>>>\n(html, pdf o docx según pida web, Word o informe estándar)\n\n"
        "<<<APUNTES>>>\n(Resumen breve de conceptos clave para defender la entrega)\n\n"
        "<<<DEBERES>>>\n(Resolución COMPLETA lista para entregar de todos los ejercicios/apartados pedidos)\n\n"
        "<<<HTML_ENTREGABLE>>>\n(SOLO si <<<FORMATO>>> es html, documento <!doctype html> completo)"
    )

    user_prompt = (
        f"Asignatura: {task.course_name}\n"
        f"Tarea: {task.title}{f' | Entrega: {task.due_date}' if task.due_date else ''}\n"
        f"Estilo alumno: {style_line}\n"
        + (f"\n{ref_digest}\n" if ref_digest else "")
        + f"\nEnunciado:\n{task.description_text[:2000]}\n"
        + (f"\nArchivos del alumno:\n{user_att_digest}\n" if user_att_digest else "")
        + (f"\nAdjuntos enunciado:\n{task_att_digest}\n" if task_att_digest else "")
        + (f"\nFragmentos relevantes del temario:\n{context_digest}\n" if context_digest else "")
    )

    raw, model_used = _call_groq_raw(
        safe_model, system_prompt, user_prompt, use_json=False, max_tokens=2400, on_wait=on_wait
    )

    raw_fmt = _extract_section(raw, "<<<FORMATO>>>", ["<<<APUNTES>>>", "<<<DEBERES>>>", "<<<HTML_ENTREGABLE>>>"])
    notes = _extract_section(raw, "<<<APUNTES>>>", ["<<<DEBERES>>>", "<<<HTML_ENTREGABLE>>>"])
    homework = _extract_section(raw, "<<<DEBERES>>>", ["<<<HTML_ENTREGABLE>>>"])
    html_deliv = _extract_section(raw, "<<<HTML_ENTREGABLE>>>", [])
    html_deliv = re.sub(r"^```(?:html)?|```$", "", html_deliv.strip(), flags=re.IGNORECASE).strip()

    if not homework and len(raw.strip()) > 60:
        homework = re.sub(r"<<<(FORMATO|APUNTES)>>>[\s\S]*?(?=<<<|$)", "", raw).strip()

    output_format = _normalize_output_format(
        raw_fmt, task, knowledge.student_preferred_formats if knowledge else None
    )
    analysis = build_local_requirement_analysis(task, source_names, output_format)
    if not notes:
        notes = f"# Apuntes de Estudio — {task.title}\n\n{knowledge.summary if knowledge else ''}"

    return TaskDeliverables(
        requirement_analysis_md=analysis,
        study_notes_md=notes,
        homework_solution_md=homework or raw.strip(),
        output_format=output_format,
        deliverable_html=html_deliv if len(html_deliv) > 80 else None,
        context_sources_used=source_names,
        generated_at=datetime.now(timezone.utc).isoformat(),
        model_used=model_used,
    )
