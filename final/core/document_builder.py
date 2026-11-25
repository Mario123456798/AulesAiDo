from __future__ import annotations

import html
import io
import re
import shutil
import subprocess
import textwrap
import xml.etree.ElementTree as ET
import zipfile
import zlib
from html.parser import HTMLParser
from xml.sax.saxutils import escape as xml_escape

from .models import TaskDeliverables, TaskRecord
from .security import sanitize_file_name

MAX_EXTRACTED_CHARS = 24000


class _HtmlTextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self._skip_depth = 0
        self._parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        t = tag.lower()
        if t in {"script", "style", "noscript", "nav"}:
            self._skip_depth += 1
        elif t in {"p", "br", "div", "li", "tr", "h1", "h2", "h3", "h4"} and self._skip_depth == 0:
            self._parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        t = tag.lower()
        if t in {"script", "style", "noscript", "nav"} and self._skip_depth > 0:
            self._skip_depth -= 1

    def handle_data(self, data: str) -> None:
        if self._skip_depth == 0:
            self._parts.append(data)

    def get_text(self) -> str:
        raw = "".join(self._parts)
        raw = re.sub(r"[ \t]+", " ", raw)
        raw = re.sub(r"\n{3,}", "\n\n", raw)
        return raw.strip()


def _format_inline_html(text: str) -> str:
    escaped = html.escape(text, quote=True)
    escaped = re.sub(r"`([^`]+)`", r"<code>\1</code>", escaped)
    escaped = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", escaped)
    escaped = re.sub(r"\*([^*]+)\*", r"<em>\1</em>", escaped)
    return escaped


def markdown_to_semantic_html(md: str) -> str:
    lines = md.replace("\r\n", "\n").split("\n")
    out: list[str] = []
    in_code = False
    in_list: str | None = None

    def close_list() -> None:
        nonlocal in_list
        if in_list:
            out.append(f"</{in_list}>")
            in_list = None

    for line in lines:
        if line.strip().startswith("```"):
            close_list()
            if not in_code:
                in_code = True
                out.append("<pre><code>")
            else:
                in_code = False
                out.append("</code></pre>")
            continue
        if in_code:
            out.append(html.escape(line) + "\n")
            continue

        trimmed = line.strip()
        if not trimmed:
            close_list()
            continue

        if m := re.match(r"^###\s+(.+)$", trimmed):
            close_list()
            out.append(f"<h3>{_format_inline_html(m.group(1))}</h3>")
        elif m := re.match(r"^##\s+(.+)$", trimmed):
            close_list()
            out.append(f"<h2>{_format_inline_html(m.group(1))}</h2>")
        elif m := re.match(r"^#\s+(.+)$", trimmed):
            close_list()
            out.append(f"<h1>{_format_inline_html(m.group(1))}</h1>")
        elif m := re.match(r"^[-*+]\s+(.+)$", trimmed):
            if in_list != "ul":
                close_list()
                in_list = "ul"
                out.append("<ul>")
            out.append(f"<li>{_format_inline_html(m.group(1))}</li>")
        elif m := re.match(r"^\d+[.)]\s+(.+)$", trimmed):
            if in_list != "ol":
                close_list()
                in_list = "ol"
                out.append("<ol>")
            out.append(f"<li>{_format_inline_html(m.group(1))}</li>")
        else:
            close_list()
            out.append(f"<p>{_format_inline_html(trimmed)}</p>")

    close_list()
    if in_code:
        out.append("</code></pre>")
    return "\n".join(out)


def build_html_bytes(task: TaskRecord, deliverables: TaskDeliverables) -> bytes:
    custom_html = (deliverables.deliverable_html or "").strip()
    if len(custom_html) >= 120 and re.search(
        r"<(html|body|div|section|main|h1|p|table)", custom_html, re.IGNORECASE
    ):
        if re.search(r"<!doctype\s+html", custom_html, re.IGNORECASE):
            return custom_html.encode("utf-8")
        wrapped = (
            "<!doctype html>\n<html lang=\"es\">\n<head>\n"
            "  <meta charset=\"UTF-8\" />\n"
            "  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\" />\n"
            f"  <title>{html.escape(task.title)}</title>\n"
            "</head>\n<body>\n"
            f"{custom_html}\n</body>\n</html>"
        )
        return wrapped.encode("utf-8")

    body_html = markdown_to_semantic_html(deliverables.homework_solution_md)
    due_meta = f" · Entrega: {html.escape(task.due_date)}" if task.due_date else ""
    doc_html = f"""<!doctype html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>{html.escape(task.title)} — {html.escape(task.course_name)}</title>
  <style>
    :root {{ color-scheme: light; }}
    body {{
      font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
      color: #0f172a;
      background: #ffffff;
      line-height: 1.65;
      max-width: 820px;
      margin: 40px auto;
      padding: 0 24px;
    }}
    header {{
      border-bottom: 1px solid #cbd5e1;
      padding-bottom: 16px;
      margin-bottom: 28px;
    }}
    .meta {{ font-size: 13px; color: #475569; margin-bottom: 6px; }}
    h1 {{ font-size: 24px; margin: 0 0 8px; line-height: 1.25; }}
    h2 {{ font-size: 19px; margin-top: 28px; margin-bottom: 10px; border-bottom: 1px solid #e2e8f0; padding-bottom: 4px; }}
    h3 {{ font-size: 16px; margin-top: 20px; margin-bottom: 8px; }}
    p {{ margin: 10px 0; }}
    ul, ol {{ margin: 10px 0; padding-left: 24px; }}
    li {{ margin: 5px 0; }}
    code {{
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 0.9em;
      background: #f1f5f9;
      padding: 2px 5px;
      border-radius: 4px;
    }}
    pre {{
      background: #f8fafc;
      border: 1px solid #e2e8f0;
      border-radius: 8px;
      padding: 14px 16px;
      overflow-x: auto;
      font-size: 13px;
      line-height: 1.5;
    }}
    pre code {{ background: transparent; padding: 0; }}
    @media print {{ body {{ margin: 0; max-width: none; }} }}
  </style>
</head>
<body>
  <header>
    <div class="meta">{html.escape(task.course_name)}{due_meta}</div>
    <h1>{html.escape(task.title)}</h1>
  </header>
  <main>
    {body_html}
  </main>
</body>
</html>"""
    return doc_html.encode("utf-8")


def _docx_runs_xml(text: str, is_code: bool = False, default_sz: int = 22) -> str:
    if is_code:
        return (
            f'<w:r><w:rPr><w:rFonts w:ascii="Courier New" w:hAnsi="Courier New"/>'
            f'<w:sz w:val="20"/></w:rPr><w:t xml:space="preserve">{xml_escape(text)}</w:t></w:r>'
        )
    parts: list[str] = []
    pos = 0
    for m in re.finditer(r"(\*\*[^*]+\*\*|`[^`]+`)", text):
        if m.start() > pos:
            parts.append(
                f'<w:r><w:rPr><w:sz w:val="{default_sz}"/></w:rPr>'
                f'<w:t xml:space="preserve">{xml_escape(text[pos:m.start()])}</w:t></w:r>'
            )
        tok = m.group(0)
        if tok.startswith("**") and tok.endswith("**"):
            parts.append(
                f'<w:r><w:rPr><w:b/><w:sz w:val="{default_sz}"/></w:rPr>'
                f'<w:t xml:space="preserve">{xml_escape(tok[2:-2])}</w:t></w:r>'
            )
        else:
            parts.append(
                f'<w:r><w:rPr><w:rFonts w:ascii="Courier New" w:hAnsi="Courier New"/>'
                f'<w:sz w:val="20"/></w:rPr><w:t xml:space="preserve">{xml_escape(tok[1:-1])}</w:t></w:r>'
            )
        pos = m.end()
    if pos < len(text):
        parts.append(
            f'<w:r><w:rPr><w:sz w:val="{default_sz}"/></w:rPr>'
            f'<w:t xml:space="preserve">{xml_escape(text[pos:])}</w:t></w:r>'
        )
    if not parts:
        parts.append(f'<w:r><w:t xml:space="preserve">{xml_escape(text)}</w:t></w:r>')
    return "".join(parts)


def build_docx_bytes(task: TaskRecord, deliverables: TaskDeliverables) -> bytes:
    """Genera un archivo OOXML (.docx) válido en Python estándar sin dependencias externas."""
    paragraphs: list[str] = [
        f'<w:p><w:r><w:rPr><w:color w:val="475569"/><w:sz w:val="20"/></w:rPr>'
        f'<w:t>{xml_escape(task.course_name)}</w:t></w:r></w:p>',
        f'<w:p><w:r><w:rPr><w:b/><w:sz w:val="36"/><w:color w:val="0F172A"/></w:rPr>'
        f'<w:t>{xml_escape(task.title)}</w:t></w:r></w:p>',
    ]
    if task.due_date:
        paragraphs.append(
            f'<w:p><w:r><w:rPr><w:color w:val="64748B"/><w:sz w:val="20"/></w:rPr>'
            f'<w:t>{xml_escape(f"Fecha límite: {task.due_date}")}</w:t></w:r></w:p>'
        )

    in_code = False
    for raw_line in deliverables.homework_solution_md.replace("\r\n", "\n").split("\n"):
        trimmed = raw_line.strip()
        if trimmed.startswith("```"):
            in_code = not in_code
            continue
        if in_code:
            paragraphs.append(
                f'<w:p><w:pPr><w:ind w:left="360"/></w:pPr>{_docx_runs_xml(raw_line, is_code=True)}</w:p>'
            )
            continue
        if not trimmed:
            paragraphs.append("<w:p/>")
            continue
        if m := re.match(r"^###\s+(.+)$", trimmed):
            txt = m.group(1).replace("**", "")
            paragraphs.append(
                f'<w:p><w:pPr><w:spacing w:before="180" w:after="80"/></w:pPr>'
                f'<w:r><w:rPr><w:b/><w:sz w:val="24"/></w:rPr><w:t>{xml_escape(txt)}</w:t></w:r></w:p>'
            )
        elif m := re.match(r"^##\s+(.+)$", trimmed):
            txt = m.group(1).replace("**", "")
            paragraphs.append(
                f'<w:p><w:pPr><w:spacing w:before="240" w:after="100"/></w:pPr>'
                f'<w:r><w:rPr><w:b/><w:sz w:val="28"/></w:rPr><w:t>{xml_escape(txt)}</w:t></w:r></w:p>'
            )
        elif m := re.match(r"^#\s+(.+)$", trimmed):
            txt = m.group(1).replace("**", "")
            paragraphs.append(
                f'<w:p><w:pPr><w:spacing w:before="260" w:after="120"/></w:pPr>'
                f'<w:r><w:rPr><w:b/><w:sz w:val="32"/></w:rPr><w:t>{xml_escape(txt)}</w:t></w:r></w:p>'
            )
        elif m := re.match(r"^[-*+]\s+(.+)$", trimmed):
            paragraphs.append(
                f'<w:p><w:pPr><w:ind w:left="320"/><w:spacing w:after="80"/></w:pPr>'
                f'<w:r><w:t xml:space="preserve">•  </w:t></w:r>{_docx_runs_xml(m.group(1))}</w:p>'
            )
        else:
            paragraphs.append(
                f'<w:p><w:pPr><w:spacing w:after="120"/></w:pPr>{_docx_runs_xml(trimmed)}</w:p>'
            )

    document_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        f"<w:body>{''.join(paragraphs)}<w:sectPr/></w:body></w:document>"
    )
    content_types_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/word/document.xml" '
        'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
        "</Types>"
    )
    rels_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" '
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
        'Target="word/document.xml"/>'
        "</Relationships>"
    )

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("[Content_Types].xml", content_types_xml.encode("utf-8"))
        zf.writestr("_rels/.rels", rels_xml.encode("utf-8"))
        zf.writestr("word/document.xml", document_xml.encode("utf-8"))
    return buf.getvalue()


def _pdf_winansi_escape(text: str) -> str:
    raw = text.encode("cp1252", errors="replace").decode("cp1252")
    out: list[str] = []
    for ch in raw:
        if ch in ("\\", "(", ")"):
            out.append("\\" + ch)
        else:
            out.append(ch)
    return "".join(out)


def build_pdf_bytes(task: TaskRecord, deliverables: TaskDeliverables) -> bytes:
    """Genera un documento PDF 1.4 multipágina válido con tipografía y acentos en español."""
    page_w, page_h = 595, 842
    margin_x, top_y, bottom_y = 52, 790, 56

    entries: list[tuple[str, int, str, float]] = [
        ("F1", 10, task.course_name, 14),
        ("F2", 18, task.title, 24),
    ]
    if task.due_date:
        entries.append(("F1", 10, f"Fecha límite: {task.due_date}", 16))
    entries.append(("F1", 10, "-" * 72, 16))

    in_code = False
    for raw_line in deliverables.homework_solution_md.replace("\r\n", "\n").split("\n"):
        trimmed = raw_line.strip()
        if trimmed.startswith("```"):
            in_code = not in_code
            entries.append(("F1", 8, "", 8))
            continue
        if in_code:
            for wline in (textwrap.wrap(raw_line, width=82) or [""]):
                entries.append(("F3", 9, f"  {wline}", 12))
            continue
        if not trimmed:
            entries.append(("F1", 8, "", 8))
            continue
        if m := re.match(r"^###\s+(.+)$", trimmed):
            for wline in textwrap.wrap(m.group(1).replace("**", ""), width=72):
                entries.append(("F2", 12, wline, 17))
        elif m := re.match(r"^##\s+(.+)$", trimmed):
            for wline in textwrap.wrap(m.group(1).replace("**", ""), width=64):
                entries.append(("F2", 14, wline, 20))
        elif m := re.match(r"^#\s+(.+)$", trimmed):
            for wline in textwrap.wrap(m.group(1).replace("**", ""), width=56):
                entries.append(("F2", 16, wline, 22))
        else:
            clean = re.sub(r"\*\*([^*]+)\*\*", r"\1", trimmed)
            clean = re.sub(r"`([^`]+)`", r"\1", clean)
            if m := re.match(r"^[-*+]\s+(.+)$", clean):
                clean = f"• {m.group(1)}"
            for wline in (textwrap.wrap(clean, width=84) or [""]):
                entries.append(("F1", 10, wline, 14))

    pages_ops: list[list[str]] = [[]]
    y = float(top_y)
    for font_ref, size, text, step in entries:
        if y - step < bottom_y:
            pages_ops.append([])
            y = float(top_y)
        if text:
            esc = _pdf_winansi_escape(text)
            pages_ops[-1].append(f"BT /{font_ref} {size} Tf {margin_x} {y:.1f} Td ({esc}) Tj ET")
        y -= step

    objects: list[bytes] = []
    # 1: Catalog, 2: Pages, 3: F1 Helvetica, 4: F2 Helvetica-Bold, 5: F3 Courier
    page_obj_nums: list[int] = []
    next_obj = 6
    page_entries_raw: list[tuple[int, int, bytes]] = []
    for ops in pages_ops:
        stream_bytes = "\n".join(ops).encode("cp1252", errors="replace")
        page_num = next_obj
        content_num = next_obj + 1
        next_obj += 2
        page_obj_nums.append(page_num)
        page_entries_raw.append((page_num, content_num, stream_bytes))

    kids_str = " ".join(f"{n} 0 R" for n in page_obj_nums)
    objects.append(b"1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n")
    objects.append(f"2 0 obj\n<< /Type /Pages /Kids [{kids_str}] /Count {len(page_obj_nums)} >>\nendobj\n".encode("ascii"))
    objects.append(b"3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n")
    objects.append(b"4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>\nendobj\n")
    objects.append(b"5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>\nendobj\n")

    for page_num, content_num, stream_bytes in page_entries_raw:
        page_obj = (
            f"{page_num} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {page_w} {page_h}] "
            f"/Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >> >> "
            f"/Contents {content_num} 0 R >>\nendobj\n"
        ).encode("ascii")
        content_obj = (
            f"{content_num} 0 obj\n<< /Length {len(stream_bytes)} >>\nstream\n".encode("ascii")
            + stream_bytes
            + b"\nendstream\nendobj\n"
        )
        objects.append(page_obj)
        objects.append(content_obj)

    pdf_out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets: list[int] = [0]
    for obj in objects:
        offsets.append(len(pdf_out))
        pdf_out.extend(obj)

    xref_pos = len(pdf_out)
    pdf_out.extend(f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode("ascii"))
    for off in offsets[1:]:
        pdf_out.extend(f"{off:010d} 00000 n \n".encode("ascii"))
    pdf_out.extend(
        f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref_pos}\n%%EOF\n".encode("ascii")
    )
    return bytes(pdf_out)


def build_deliverable_file(
    fmt: str, task: TaskRecord, deliverables: TaskDeliverables
) -> tuple[str, str, bytes]:
    base_slug = sanitize_file_name(task.title)[:60].replace(" ", "_")
    f = fmt.lower().strip()
    if f == "html":
        return f"{base_slug}_entrega.html", "text/html; charset=utf-8", build_html_bytes(task, deliverables)
    if f == "pdf":
        return f"{base_slug}_entrega.pdf", "application/pdf", build_pdf_bytes(task, deliverables)
    if f == "docx":
        return (
            f"{base_slug}_entrega.docx",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            build_docx_bytes(task, deliverables),
        )
    return (
        "03_deberes_resueltos.md",
        "text/markdown; charset=utf-8",
        deliverables.homework_solution_md.encode("utf-8"),
    )


def _extract_pdf_text_native(data: bytes) -> str:
    """Extrae texto legible de flujos FlateDecode o planos PDF sin dependencias externas."""
    # Optional pypdf / pdftotext if available on host
    try:
        import pypdf  # type: ignore

        reader = pypdf.PdfReader(io.BytesIO(data))
        txt = "\n".join((p.extract_text() or "") for p in reader.pages)
        if txt.strip():
            return txt.strip()[:MAX_EXTRACTED_CHARS]
    except Exception:
        pass

    if shutil.which("pdftotext"):
        try:
            proc = subprocess.run(
                ["pdftotext", "-", "-"],
                input=data,
                capture_output=True,
                timeout=8,
                check=False,
            )
            if proc.returncode == 0 and proc.stdout.strip():
                return proc.stdout.decode("utf-8", errors="ignore").strip()[:MAX_EXTRACTED_CHARS]
        except Exception:
            pass

    chunks: list[str] = []
    for m in re.finditer(rb"stream[\r\n]+(.*?)[\r\n]+endstream", data, flags=re.DOTALL):
        raw_stream = m.group(1)
        decoded = raw_stream
        try:
            decoded = zlib.decompress(raw_stream)
        except Exception:
            pass
        text_str = decoded.decode("latin1", errors="ignore")
        for tj in re.findall(r"\(([^()\\]*(?:\\.[^()\\]*)*)\)\s*Tj", text_str):
            chunks.append(tj.replace("\\(", "(").replace("\\)", ")").replace("\\\\", "\\"))
        for arr in re.findall(r"\[(.*?)\]\s*TJ", text_str, flags=re.DOTALL):
            parts = re.findall(r"\(([^()\\]*(?:\\.[^()\\]*)*)\)", arr)
            if parts:
                chunks.append("".join(parts).replace("\\(", "(").replace("\\)", ")"))
    joined = re.sub(r"\s+", " ", " ".join(chunks)).strip()
    return joined[:MAX_EXTRACTED_CHARS]


def extract_text_from_bytes(file_name: str, mime_type: str, data: bytes) -> str:
    lower = file_name.lower()
    mime = (mime_type or "").lower()
    try:
        if lower.endswith(".pdf") or mime == "application/pdf":
            return _extract_pdf_text_native(data)

        if lower.endswith(".docx") or "wordprocessingml.document" in mime:
            with zipfile.ZipFile(io.BytesIO(data), "r") as zf:
                if "word/document.xml" in zf.namelist():
                    xml_bytes = zf.read("word/document.xml")
                    root = ET.fromstring(xml_bytes)
                    texts = [el.text for el in root.iter() if el.tag.endswith("}t") and el.text]
                    return " ".join(texts).strip()[:MAX_EXTRACTED_CHARS]

        if lower.endswith(".html") or lower.endswith(".htm") or "text/html" in mime:
            parser = _HtmlTextExtractor()
            parser.feed(data.decode("utf-8", errors="ignore"))
            return parser.get_text()[:MAX_EXTRACTED_CHARS]

        if mime.startswith("text/") or re.search(
            r"\.(txt|md|csv|json|py|java|js|ts|sql|xml|yaml|yml)$", lower
        ):
            return data.decode("utf-8", errors="ignore").strip()[:MAX_EXTRACTED_CHARS]
    except Exception:
        pass
    return ""
