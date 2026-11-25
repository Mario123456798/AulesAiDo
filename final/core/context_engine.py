from __future__ import annotations

import math
import re
import unicodedata
from datetime import datetime, timezone

from .models import AttachmentRecord, SubjectKnowledge, TaskRecord

STOPWORDS = {
    "para", "como", "este", "esta", "estos", "estas", "pero", "porque", "sobre", "entre",
    "desde", "hasta", "donde", "cuando", "quien", "cual", "todos", "todas", "todo", "toda",
    "cada", "otro", "otra", "otros", "otras", "unos", "unas", "tiene", "tienen", "hacer",
    "debe", "deben", "puede", "pueden", "sera", "aqui", "entrega", "entregar",
    "tarea", "tasca", "actividad", "activitat", "practica", "ejercicio", "ejercicios",
    "realizar", "subir", "aules", "moodle", "documento", "archivo", "fichero", "pdf", "docx",
    "html", "amb", "per", "que", "dels", "les", "els", "una", "uns", "unes", "seva", "seu",
    "with", "from", "that", "this", "your", "have", "will", "into", "the", "and", "for",
}


def normalize_text(text: str) -> str:
    nfkd = unicodedata.normalize("NFD", text.lower())
    return "".join(ch for ch in nfkd if unicodedata.category(ch) != "Mn")


def tokenize(text: str) -> list[str]:
    cleaned = re.sub(r"[^a-z0-9_]+", " ", normalize_text(text))
    return [w for w in cleaned.split() if len(w) >= 2 and w not in STOPWORDS]


def is_submission_not_required_status(status_text: str) -> bool:
    s = normalize_text(status_text)
    return any(
        needle in s
        for needle in (
            "no requereix que trameteu res",
            "no requereix cap tramesa",
            "no es requereix cap tramesa",
            "no requereix lliurament",
            "no requiere que envie",
            "no se requiere entrega",
            "no requiere entrega en linea",
            "no online submissions are required",
            "no submission required",
            "nothing is required to be submitted",
        )
    )


def is_task_no_submission(task: TaskRecord) -> bool:
    if task.requires_online_submission is False or task.status == "no_submission":
        return True
    return is_submission_not_required_status(task.submission_status or "")


def is_task_submitted_in_aules(task: TaskRecord) -> bool:
    if is_task_no_submission(task):
        return False
    if isinstance(task.is_submitted_in_aules, bool):
        return task.is_submitted_in_aules
    if task.status == "reference":
        return True

    s = normalize_text(task.submission_status or "")
    not_submitted = any(
        needle in s
        for needle in (
            "sin entrega",
            "no entregado",
            "no enviado",
            "sense lliuraments",
            "sense tramesa",
            "encara no s'ha fet cap tramesa",
            "no submission",
            "nothing has been submitted",
            "not submitted",
            "borrador",
            "esborrany",
            "draft",
        )
    ) or s == "pendiente"
    if not_submitted:
        return False

    submitted = any(
        needle in s
        for needle in (
            "enviado",
            "enviada",
            "entregado",
            "entregada",
            "tramesa per a qualificar",
            "tramesa realitzada",
            "s'ha trames per a qualificar",
            "lliurat",
            "submitted",
            "calificado",
            "qualificat",
            "graded",
        )
    )
    return (
        submitted
        or bool(task.submitted_work_text and len(task.submitted_work_text) > 20)
        or any(a.source_type == "student_submission" for a in task.attachments)
    )


def is_task_actionable(task: TaskRecord) -> bool:
    return not is_task_no_submission(task) and not is_task_submitted_in_aules(task)


def needs_extra_course_context(task: TaskRecord) -> bool:
    desc_len = len((task.description_text or "").strip())
    has_att_text = any(
        a.source_type != "student_submission" and len((a.extracted_text or "").strip()) > 180
        for a in task.attachments
    )
    if desc_len < 550 or not has_att_text:
        return True
    return bool(
        re.search(
            r"\b(ud\s*\d|tema\s*\d|unidad|apuntes|manual|guia|guía|enunciado|adjunto|pr[aá]ctica)\b",
            f"{task.title} {task.description_text}",
            re.IGNORECASE,
        )
    )


def _split_into_chunks(doc_name: str, text: str, chunk_size: int = 580) -> list[dict]:
    clean = re.sub(r"\n{3,}", "\n\n", text.replace("\r\n", "\n")).strip()
    if not clean:
        return []
    title_tokens = tokenize(doc_name)
    paragraphs = clean.split("\n\n")
    chunks: list[dict] = []
    buf = ""

    def push(val: str) -> None:
        trimmed = val.strip()
        if len(trimmed) < 40:
            return
        chunks.append(
            {
                "doc_name": doc_name,
                "text": trimmed[: chunk_size + 120],
                "tokens": tokenize(trimmed),
                "title_tokens": title_tokens,
            }
        )

    for para in paragraphs:
        if len(buf) + len(para) + 2 > chunk_size:
            if buf:
                push(buf)
            if len(para) > chunk_size:
                for i in range(0, len(para), chunk_size):
                    push(para[i : i + chunk_size])
                buf = ""
            else:
                buf = para
        else:
            buf = f"{buf}\n\n{para}" if buf else para
    if buf:
        push(buf)
    return chunks


def select_relevant_course_chunks(
    task: TaskRecord,
    course_docs: list[AttachmentRecord],
    max_total_chars: int = 1900,
) -> tuple[str, list[str]]:
    usable_docs = [d for d in course_docs if len((d.extracted_text or "").strip()) > 40]
    if not usable_docs:
        return "", []

    query_terms = list(
        dict.fromkeys(
            tokenize(task.title)
            + tokenize(task.description_text)
            + [t for a in task.attachments for t in tokenize(a.name)]
        )
    )

    all_chunks: list[dict] = []
    for doc in usable_docs:
        all_chunks.extend(_split_into_chunks(doc.name, doc.extracted_text))

    if not all_chunks:
        return "", []

    df: dict[str, int] = {}
    for ch in all_chunks:
        for tok in set(ch["tokens"]):
            df[tok] = df.get(tok, 0) + 1

    total_docs = len(all_chunks)
    scored: list[tuple[float, dict]] = []
    for ch in all_chunks:
        tf: dict[str, int] = {}
        for tok in ch["tokens"]:
            tf[tok] = tf.get(tok, 0) + 1
        title_set = set(ch["title_tokens"])
        score = 0.0
        for q in query_terms:
            cnt = tf.get(q, 0)
            if cnt > 0:
                idf = math.log(1.0 + total_docs / (1.0 + df.get(q, 1)))
                score += min(3, cnt) * idf
            if q in title_set:
                score += 2.2
        scored.append((score, ch))

    scored.sort(key=lambda item: item[0], reverse=True)

    selected: list[dict] = []
    doc_hits: dict[str, int] = {}
    used_chars = 0
    for _, ch in scored:
        if len(selected) >= 4:
            break
        hits = doc_hits.get(ch["doc_name"], 0)
        if hits >= 2:
            continue
        entry_len = len(ch["doc_name"]) + len(ch["text"]) + 24
        if used_chars + entry_len > max_total_chars and selected:
            continue
        selected.append(ch)
        doc_hits[ch["doc_name"]] = hits + 1
        used_chars += entry_len

    if not selected:
        first = usable_docs[0]
        return f"[{first.name}]: {first.extracted_text[: min(800, max_total_chars)]}", [first.name]

    source_names = list(dict.fromkeys(c["doc_name"] for c in selected))
    digest = "\n\n".join(f"[{c['doc_name']}]:\n{c['text']}" for c in selected)
    return digest[:max_total_chars], source_names


def infer_preferred_formats_locally(
    tasks: list[TaskRecord], existing: list[str] | None = None
) -> list[str]:
    counts: dict[str, int] = {}
    for t in tasks:
        for a in t.attachments:
            if a.source_type == "student_submission":
                lower = a.name.lower()
                if lower.endswith(".pdf"):
                    counts["pdf"] = counts.get("pdf", 0) + 2
                elif lower.endswith(".docx") or lower.endswith(".doc"):
                    counts["docx"] = counts.get("docx", 0) + 2
                elif lower.endswith(".html") or lower.endswith(".htm"):
                    counts["html"] = counts.get("html", 0) + 2
        prompt = f"{t.title} {t.description_text}".lower()
        if re.search(r"\b(html|css|web)\b", prompt):
            counts["html"] = counts.get("html", 0) + 1
        if re.search(r"\b(word|docx)\b", prompt):
            counts["docx"] = counts.get("docx", 0) + 1
        if re.search(r"\bpdf\b", prompt):
            counts["pdf"] = counts.get("pdf", 0) + 1
    ranked = [fmt for fmt, _ in sorted(counts.items(), key=lambda x: x[1], reverse=True)]
    if ranked:
        return ranked
    return existing if existing else ["pdf"]


def build_local_subject_knowledge(
    course_id: str,
    course_name: str,
    existing: SubjectKnowledge | None,
    tasks: list[TaskRecord],
    course_docs: list[AttachmentRecord],
) -> SubjectKnowledge:
    preferred_formats = infer_preferred_formats_locally(
        tasks, existing.student_preferred_formats if existing else None
    )
    submitted_tasks = [t for t in tasks if is_task_submitted_in_aules(t)]
    student_files = [
        a for t in submitted_tasks for a in t.attachments if a.source_type == "student_submission"
    ]

    concept_freq: dict[str, int] = {}
    for t in tasks:
        for tok in tokenize(t.title):
            concept_freq[tok] = concept_freq.get(tok, 0) + 2
    for d in course_docs:
        for tok in tokenize(d.name):
            concept_freq[tok] = concept_freq.get(tok, 0) + 2
    top_concepts = [
        word.upper()
        for word, _ in sorted(concept_freq.items(), key=lambda x: x[1], reverse=True)[:10]
    ]

    criteria: list[str] = list(existing.evaluation_criteria if existing else [])
    seen_criteria = set(criteria)
    for t in tasks:
        for sentence in re.split(r"[.!\n]+", t.description_text or ""):
            clean = sentence.strip()
            if (
                18 <= len(clean) <= 180
                and clean not in seen_criteria
                and re.search(
                    r"\b(rubrica|rúbrica|criterio|obligatori|debe|formato|puntu|valorar|entrega|pdf|docx|html)\b",
                    clean,
                    re.IGNORECASE,
                )
            ):
                criteria.append(clean)
                seen_criteria.add(clean)
            if len(criteria) >= 8:
                break

    if student_files:
        names = ", ".join(f.name for f in student_files[:4])
        fmts = "/".join(f.upper() for f in preferred_formats)
        style_fallback = f"En {course_name} sueles entregar en {fmts} (ejemplos analizados: {names})."
    elif existing and existing.student_work_style:
        style_fallback = existing.student_work_style
    else:
        fmts = ", ".join(f.upper() for f in preferred_formats)
        style_fallback = f"Formato recomendado por los enunciados: {fmts}."

    merged_task_ids = list(
        dict.fromkeys((existing.learned_task_ids if existing else []) + [t.id for t in tasks])
    )
    actionable_count = sum(1 for t in tasks if is_task_actionable(t))

    if existing and len(existing.summary) > 40:
        summary = existing.summary
    else:
        summary = (
            f"{course_name}: {len(tasks)} actividades detectadas "
            f"({len(submitted_tasks)} entregas previas de referencia, {actionable_count} pendientes de entrega) "
            f"y {len(course_docs)} recursos de apoyo indexados."
        )

    student_work_style = (
        existing.student_work_style
        if existing and existing.student_work_style and not existing.student_work_style.startswith("Aún no se han detectado")
        else style_fallback
    )

    return SubjectKnowledge(
        course_id=course_id,
        course_name=course_name,
        summary=summary,
        student_work_style=student_work_style,
        student_preferred_formats=preferred_formats,
        key_concepts=existing.key_concepts if existing and existing.key_concepts else top_concepts,
        evaluation_criteria=criteria[:8],
        study_tips=(
            existing.study_tips
            if existing and existing.study_tips
            else [
                f"Revisar los {len(course_docs)} documentos indexados del curso antes de entregar.",
                f"Utilizar el formato habitual ({(preferred_formats[0] if preferred_formats else 'pdf').upper()}) salvo que el enunciado exija otro.",
            ]
        ),
        glossary=existing.glossary if existing else [],
        learned_task_ids=merged_task_ids,
        updated_at=datetime.now(timezone.utc).isoformat(),
        drive_file_id=existing.drive_file_id if existing else None,
        drive_web_view_link=existing.drive_web_view_link if existing else None,
    )


def build_local_requirement_analysis(
    task: TaskRecord, context_sources: list[str], recommended_format: str
) -> str:
    att_lines = [
        f"- {a.name} ({'Adjuntado por ti' if a.source_type == 'user_attachment' else 'Aules'})"
        for a in task.attachments
        if a.source_type != "student_submission"
    ]
    att_text = "\n".join(att_lines) if att_lines else "- Sin adjuntos en la tarea"
    ctx_text = "\n".join(f"- {s}" for s in context_sources) if context_sources else "- Enunciado directo"

    return (
        f"# Análisis de Requisitos — {task.title}\n\n"
        f"- **Asignatura**: {task.course_name}\n"
        f"- **Estado en Aules**: {task.submission_status}\n"
        f"- **Fecha límite**: {task.due_date or 'No especificada'}\n"
        f"- **Formato óptimo detectado**: {recommended_format.upper()}\n\n"
        f"## Enunciado\n{task.description_text}\n\n"
        f"## Adjuntos de la Tarea\n{att_text}\n\n"
        f"## Contexto del Curso Utilizado\n{ctx_text}\n"
    )
