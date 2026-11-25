from __future__ import annotations

import base64
import html
import http.cookiejar
import json
import re
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from html.parser import HTMLParser
from typing import Callable

from .context_engine import is_submission_not_required_status
from .document_builder import extract_text_from_bytes
from .models import AttachmentRecord, AulesSession, CourseRecord, TaskRecord
from .security import assert_same_origin_aules_url, sanitize_file_name, validate_aules_base_url

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)
MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024
MAX_EXTRACTED_CHARS = 24000


class _SafeRedirectHandler(urllib.request.HTTPRedirectHandler):
    def __init__(self, base_url: str) -> None:
        super().__init__()
        self.base_url = base_url

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        safe_url = assert_same_origin_aules_url(newurl, self.base_url)
        return super().redirect_request(req, fp, code, msg, headers, safe_url)


def _build_opener(base_url: str, cookies: dict[str, str]) -> tuple[urllib.request.OpenerDirector, http.cookiejar.CookieJar]:
    jar = http.cookiejar.CookieJar()
    parsed = urllib.parse.urlparse(base_url)
    for name, val in cookies.items():
        cookie = http.cookiejar.Cookie(
            version=0,
            name=name,
            value=val,
            port=None,
            port_specified=False,
            domain=parsed.hostname or "",
            domain_specified=True,
            domain_initial_dot=False,
            path="/",
            path_specified=True,
            secure=True,
            expires=None,
            discard=True,
            comment=None,
            comment_url=None,
            rest={},
        )
        jar.set_cookie(cookie)
    opener = urllib.request.build_opener(
        urllib.request.HTTPCookieProcessor(jar),
        _SafeRedirectHandler(base_url),
    )
    return opener, jar


def _sync_jar_to_dict(jar: http.cookiejar.CookieJar, cookies: dict[str, str]) -> None:
    for c in jar:
        if c.value:
            cookies[c.name] = c.value


def _fetch_with_cookies(
    url: str,
    base_url: str,
    cookies: dict[str, str],
    method: str = "GET",
    headers: dict[str, str] | None = None,
    body: bytes | None = None,
    timeout: int = 20,
) -> tuple[int, dict[str, str], bytes, str]:
    safe_url = assert_same_origin_aules_url(url, base_url)
    opener, jar = _build_opener(base_url, cookies)
    req_headers = {"User-Agent": USER_AGENT}
    if headers:
        req_headers.update(headers)
    req = urllib.request.Request(safe_url, data=body, headers=req_headers, method=method)
    try:
        with opener.open(req, timeout=timeout) as resp:
            _sync_jar_to_dict(jar, cookies)
            resp_headers = {k.lower(): v for k, v in resp.headers.items()}
            data = resp.read(MAX_ATTACHMENT_BYTES + 1)
            return resp.status, resp_headers, data, resp.geturl()
    except urllib.error.HTTPError as err:
        _sync_jar_to_dict(jar, cookies)
        resp_headers = {k.lower(): v for k, v in err.headers.items()} if err.headers else {}
        return err.code, resp_headers, err.read(), str(err.geturl() or safe_url)


def _strip_html(raw: str) -> str:
    txt = re.sub(r"<(script|style)[^>]*>[\s\S]*?</\1>", " ", raw, flags=re.IGNORECASE)
    txt = re.sub(r"<(br|p|div|li|tr|h[1-6])[^>]*>", "\n", txt, flags=re.IGNORECASE)
    txt = re.sub(r"<[^>]+>", " ", txt)
    txt = html.unescape(txt)
    txt = re.sub(r"[ \t]+", " ", txt)
    txt = re.sub(r"\n{3,}", "\n\n", txt)
    return txt.strip()


class _LinkParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.links: list[tuple[str, str]] = []
        self._href: str | None = None
        self._buf: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.lower() == "a":
            attr_map = dict(attrs)
            href = attr_map.get("href")
            if href:
                self._href = href
                self._buf = []

    def handle_data(self, data: str) -> None:
        if self._href is not None:
            self._buf.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() == "a" and self._href is not None:
            label = re.sub(r"\s+", " ", "".join(self._buf)).strip()
            self.links.append((self._href, label))
            self._href = None
            self._buf = []


def _extract_links(html_doc: str) -> list[tuple[str, str]]:
    parser = _LinkParser()
    parser.feed(html_doc)
    return parser.links


VOID_HTML_TAGS = {
    "area", "base", "br", "col", "embed", "hr", "img", "input",
    "link", "meta", "param", "source", "track", "wbr",
}


class _ContainerExtractor(HTMLParser):
    def __init__(self, target_ids: set[str], target_classes: set[str]) -> None:
        super().__init__(convert_charrefs=True)
        self.target_ids = target_ids
        self.target_classes = target_classes
        self._capture_depth = 0
        self._skip_depth = 0
        self._buf: list[str] = []
        self.blocks: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        t = tag.lower()
        attr_map = {k.lower(): (v or "") for k, v in attrs}
        if self._capture_depth > 0:
            if t == "br" and self._skip_depth == 0:
                self._buf.append("\n")
            if t in VOID_HTML_TAGS:
                return
            self._capture_depth += 1
            if t in {"script", "style"}:
                self._skip_depth += 1
            elif t in {"p", "div", "li", "tr", "h1", "h2", "h3", "h4"} and self._skip_depth == 0:
                self._buf.append("\n")
            return

        if t in VOID_HTML_TAGS:
            return
        el_id = attr_map.get("id", "").strip().lower()
        classes = set(attr_map.get("class", "").lower().split())
        if (el_id and el_id in self.target_ids) or (classes & self.target_classes):
            self._capture_depth = 1
            self._buf = []

    def handle_data(self, data: str) -> None:
        if self._capture_depth > 0 and self._skip_depth == 0:
            self._buf.append(data)

    def handle_endtag(self, tag: str) -> None:
        t = tag.lower()
        if self._capture_depth == 0 or t in VOID_HTML_TAGS:
            return
        if t in {"script", "style"} and self._skip_depth > 0:
            self._skip_depth -= 1
        self._capture_depth -= 1
        if self._capture_depth == 0:
            raw = re.sub(r"[ \t]+", " ", "".join(self._buf))
            raw = re.sub(r"\n{3,}", "\n\n", raw).strip()
            if raw:
                self.blocks.append(raw)


def _extract_container_text(html_doc: str, *, ids: set[str] | None = None, classes: set[str] | None = None) -> str:
    parser = _ContainerExtractor(ids or set(), classes or set())
    parser.feed(html_doc)
    return "\n\n".join(parser.blocks).strip()


def _extract_sesskey(html_doc: str) -> str | None:
    m = re.search(r'"sesskey"\s*:\s*"([a-zA-Z0-9]+)"', html_doc)
    if m:
        return m.group(1)
    m2 = re.search(r"sesskey=([a-zA-Z0-9]+)", html_doc)
    return m2.group(1) if m2 else None


def _guess_mime(name: str) -> str:
    lower = name.lower()
    if lower.endswith(".pdf"):
        return "application/pdf"
    if lower.endswith(".docx"):
        return "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    if lower.endswith(".doc"):
        return "application/msword"
    if lower.endswith(".txt"):
        return "text/plain"
    if lower.endswith(".md"):
        return "text/markdown"
    if lower.endswith(".csv"):
        return "text/csv"
    if lower.endswith(".json"):
        return "application/json"
    if lower.endswith((".html", ".htm")):
        return "text/html"
    return "application/octet-stream"


def _filename_from_disposition(header_val: str | None, fallback_url: str) -> str:
    if header_val:
        m_utf8 = re.search(r"filename\*=UTF-8''([^;]+)", header_val, flags=re.IGNORECASE)
        if m_utf8:
            return sanitize_file_name(urllib.parse.unquote(m_utf8.group(1)))
        m_std = re.search(r'filename="?([^";]+)"?', header_val, flags=re.IGNORECASE)
        if m_std:
            return sanitize_file_name(m_std.group(1))
    seg = urllib.parse.urlparse(fallback_url).path.rstrip("/").split("/")[-1]
    return sanitize_file_name(urllib.parse.unquote(seg)) if seg else "documento_aules"


def connect_aules(raw_url: str, username: str, password: str) -> AulesSession:
    base_url = validate_aules_base_url(raw_url)
    cookies: dict[str, str] = {}

    status, _, raw_login, login_final_url = _fetch_with_cookies(
        f"{base_url}/login/index.php", base_url, cookies, method="GET"
    )
    if status >= 400:
        raise RuntimeError(f"No se pudo abrir la página de acceso de Aules (HTTP {status}).")

    login_html = raw_login.decode("utf-8", errors="ignore")
    token_m = re.search(r'name="logintoken"\s+value="([^"]*)"', login_html, flags=re.IGNORECASE)
    if not token_m:
        token_m = re.search(r'value="([^"]*)"\s+name="logintoken"', login_html, flags=re.IGNORECASE)
    logintoken = token_m.group(1) if token_m else ""

    action_m = re.search(r'<form[^>]+id="login"[^>]+action="([^"]+)"', login_html, flags=re.IGNORECASE)
    post_target = assert_same_origin_aules_url(html.unescape(action_m.group(1)), base_url) if action_m else login_final_url

    params: dict[str, str] = {"anchor": "", "username": username.strip(), "password": password}
    if logintoken:
        params["logintoken"] = logintoken

    _, _, after_raw, after_url = _fetch_with_cookies(
        post_target,
        base_url,
        cookies,
        method="POST",
        headers={"Content-Type": "application/x-www-form-urlencoded", "Referer": login_final_url},
        body=urllib.parse.urlencode(params).encode("utf-8"),
    )
    after_html = after_raw.decode("utf-8", errors="ignore")
    if "/login/index.php" in after_url and ('id="login"' in after_html or "loginerrors" in after_html):
        err_m = re.search(r'id="loginerrormessage"[^>]*>([^<]+)<', after_html, flags=re.IGNORECASE)
        raise RuntimeError(
            err_m.group(1).strip() if err_m else "Credenciales incorrectas o verificación requerida en Aules."
        )

    _, _, my_raw, my_final_url = _fetch_with_cookies(f"{base_url}/my/", base_url, cookies, method="GET")
    my_html = my_raw.decode("utf-8", errors="ignore")
    if "/login/" in my_final_url and 'id="login"' in my_html:
        raise RuntimeError("La sesión de Aules no se mantuvo activa tras el inicio de sesión.")

    sesskey = _extract_sesskey(my_html) or _extract_sesskey(after_html)
    name_m = re.search(r'class="[^"]*usertext[^"]*"[^>]*>([^<]+)<', my_html, flags=re.IGNORECASE)
    full_name = _strip_html(name_m.group(1)) if name_m else username.strip()

    return AulesSession(
        base_url=base_url,
        username=username.strip(),
        full_name=full_name or username.strip(),
        cookies=cookies,
        sesskey=sesskey,
        connected_at=datetime.now(timezone.utc).isoformat(),
    )


def verify_aules_session_alive(session: AulesSession) -> bool:
    try:
        status, _, raw, final_url = _fetch_with_cookies(
            f"{session.base_url}/my/", session.base_url, session.cookies, method="GET"
        )
        if status >= 400 or "/login/" in final_url:
            return False
        html_doc = raw.decode("utf-8", errors="ignore")
        if 'id="login"' in html_doc:
            return False
        fresh_key = _extract_sesskey(html_doc)
        if fresh_key:
            session.sesskey = fresh_key
        return True
    except Exception:
        return False


def _call_moodle_ajax(session: AulesSession, methodname: str, args: dict) -> object | None:
    if not session.sesskey:
        return None
    endpoint = (
        f"{session.base_url}/lib/ajax/service.php?"
        f"sesskey={urllib.parse.quote(session.sesskey)}&info={urllib.parse.quote(methodname)}"
    )
    try:
        payload = json.dumps([{"index": 0, "methodname": methodname, "args": args}]).encode("utf-8")
        status, _, raw, _ = _fetch_with_cookies(
            endpoint,
            session.base_url,
            session.cookies,
            method="POST",
            headers={"Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest"},
            body=payload,
        )
        if status >= 400:
            return None
        data = json.loads(raw.decode("utf-8", errors="ignore"))
        if isinstance(data, list) and data and not data[0].get("error"):
            return data[0].get("data")
    except Exception:
        return None
    return None


def _discover_enrolled_courses(session: AulesSession) -> list[CourseRecord]:
    course_map: dict[str, CourseRecord] = {}
    now = datetime.now(timezone.utc).isoformat()

    def add_course(cid: str, name: str, shortname: str = "", url: str = "") -> None:
        clean_id = cid.strip()
        clean_name = re.sub(r"\s+", " ", name).strip()
        if not clean_id or clean_id == "1" or len(clean_name) < 2:
            return
        if clean_id not in course_map:
            course_map[clean_id] = CourseRecord(
                id=clean_id,
                name=clean_name,
                shortname=(shortname or clean_name).strip()[:40],
                url=url or f"{session.base_url}/course/view.php?id={clean_id}",
                last_scanned_at=now,
            )

    try:
        st, _, raw, _ = _fetch_with_cookies(
            f"{session.base_url}/my/courses.php", session.base_url, session.cookies
        )
        if st < 400:
            fresh = _extract_sesskey(raw.decode("utf-8", errors="ignore"))
            if fresh:
                session.sesskey = fresh
    except Exception:
        pass

    for classification in ("inprogress", "all", "future", "past"):
        data = _call_moodle_ajax(
            session,
            "core_course_get_enrolled_courses_by_classification",
            {"offset": 0, "limit": 0, "classification": classification, "sort": "fullname"},
        )
        if isinstance(data, dict):
            for c in data.get("courses") or []:
                add_course(str(c.get("id", "")), c.get("fullname", ""), c.get("shortname", ""), c.get("viewurl", ""))

    for suffix in ("/user/profile.php", "/grade/report/overview/index.php", "/my/courses.php", "/my/"):
        if course_map and suffix in ("/my/courses.php", "/my/"):
            break
        try:
            st, _, raw, _ = _fetch_with_cookies(f"{session.base_url}{suffix}", session.base_url, session.cookies)
            if st >= 400:
                continue
            doc = raw.decode("utf-8", errors="ignore")
            main_m = re.search(r'id="region-main"[\s\S]*$', doc)
            scope = main_m.group(0) if main_m else doc
            for href, label in _extract_links(scope):
                if "course/view.php" in href or "course=" in href:
                    try:
                        abs_url = assert_same_origin_aules_url(href, session.base_url)
                        qs = urllib.parse.parse_qs(urllib.parse.urlparse(abs_url).query)
                        cid = (qs.get("course") or qs.get("id") or [""])[0]
                        if cid:
                            add_course(cid, label)
                    except Exception:
                        pass
        except Exception:
            pass

    if len(course_map) > 1 and "582" in course_map and "manual" in course_map["582"].name.lower():
        course_map.pop("582", None)

    return list(course_map.values())


def _collect_links_from_course_html(
    html_doc: str,
    base_url: str,
    assign_map: dict[str, dict],
    resource_links: list[dict],
    seen_res: set[str],
) -> None:
    main_m = re.search(r'id="region-main"[\s\S]*$', html_doc)
    scope = main_m.group(0) if main_m else html_doc
    for href, raw_label in _extract_links(scope):
        try:
            abs_url = assert_same_origin_aules_url(href, base_url)
        except Exception:
            continue
        parsed = urllib.parse.urlparse(abs_url)
        qs = urllib.parse.parse_qs(parsed.query)
        label = re.sub(
            r"(Tarea|Tasca|Archivo|Fitxer|Carpeta|Página|Pàgina|Libro|Llibre)$",
            "",
            raw_label,
            flags=re.IGNORECASE,
        ).strip() or "Elemento"

        cmid = (qs.get("id") or [""])[0]
        if "/mod/assign/view.php" in parsed.path and cmid and cmid not in assign_map:
            assign_map[cmid] = {"title": label, "url": abs_url}
        elif "/mod/resource/view.php" in parsed.path and cmid and abs_url not in seen_res:
            seen_res.add(abs_url)
            resource_links.append({"id": f"res_{cmid}", "title": label, "url": abs_url, "kind": "resource"})
        elif "/mod/folder/view.php" in parsed.path and cmid and abs_url not in seen_res:
            seen_res.add(abs_url)
            resource_links.append({"id": f"fld_{cmid}", "title": label, "url": abs_url, "kind": "folder"})
        elif "/mod/page/view.php" in parsed.path and cmid and abs_url not in seen_res:
            seen_res.add(abs_url)
            resource_links.append({"id": f"pag_{cmid}", "title": label, "url": abs_url, "kind": "page"})
        elif "/mod/book/view.php" in parsed.path and cmid and abs_url not in seen_res:
            seen_res.add(abs_url)
            resource_links.append({"id": f"bok_{cmid}", "title": label, "url": abs_url, "kind": "book"})
        elif "/pluginfile.php/" in parsed.path and abs_url not in seen_res:
            seen_res.add(abs_url)
            pf_id = base64.urlsafe_b64encode(parsed.path.encode("utf-8")).decode("ascii")[:16]
            fname = _filename_from_disposition(None, abs_url)
            resource_links.append({"id": f"pf_{pf_id}", "title": fname, "url": abs_url, "kind": "file"})


def _resolve_resource_links(session: AulesSession, resource_links: list[dict], limit: int = 25) -> list[AttachmentRecord]:
    docs: list[AttachmentRecord] = []
    seen_urls: set[str] = set()

    def resolve_one(r: dict) -> list[AttachmentRecord]:
        out: list[AttachmentRecord] = []
        if r["kind"] == "file":
            out.append(
                AttachmentRecord(
                    id=r["id"],
                    name=r["title"],
                    source_url=r["url"],
                    mime_type=_guess_mime(r["title"]),
                    byte_size=0,
                    downloaded=False,
                    source_type="course_resource",
                )
            )
            return out
        try:
            st, headers, raw, final_url = _fetch_with_cookies(r["url"], session.base_url, session.cookies)
            if st >= 400:
                return out
            ct = headers.get("content-type", "")
            if "text/html" not in ct:
                fname = _filename_from_disposition(headers.get("content-disposition"), final_url)
                out.append(
                    AttachmentRecord(
                        id=r["id"],
                        name=fname,
                        source_url=final_url,
                        mime_type=ct.split(";")[0].strip() or _guess_mime(fname),
                        byte_size=0,
                        downloaded=False,
                        source_type="course_resource",
                    )
                )
            else:
                html_doc = raw.decode("utf-8", errors="ignore")
                main_m = re.search(r'id="region-main"[\s\S]*$', html_doc)
                scope = main_m.group(0) if main_m else html_doc
                if r["kind"] in ("page", "book"):
                    txt = _strip_html(scope)
                    if len(txt) > 35:
                        out.append(
                            AttachmentRecord(
                                id=r["id"],
                                name=f"{sanitize_file_name(r['title'])}.txt",
                                source_url=final_url,
                                mime_type="text/plain",
                                byte_size=len(txt.encode("utf-8")),
                                downloaded=True,
                                extracted_text=txt[:MAX_EXTRACTED_CHARS],
                                source_type="course_resource",
                            )
                        )
                for idx, (href, label) in enumerate(_extract_links(scope)):
                    if "pluginfile.php" not in href:
                        continue
                    try:
                        abs_url = assert_same_origin_aules_url(href, session.base_url)
                        fname = sanitize_file_name(label) or _filename_from_disposition(None, abs_url)
                        out.append(
                            AttachmentRecord(
                                id=f"{r['id']}_{idx}",
                                name=fname,
                                source_url=abs_url,
                                mime_type=_guess_mime(fname),
                                byte_size=0,
                                downloaded=False,
                                source_type="course_resource",
                            )
                        )
                    except Exception:
                        pass
        except Exception:
            pass
        return out

    with ThreadPoolExecutor(max_workers=4) as pool:
        for items in pool.map(resolve_one, resource_links[:limit]):
            for item in items:
                if item.source_url not in seen_urls:
                    seen_urls.add(item.source_url)
                    docs.append(item)
    return docs


def discover_course_resources_for_course(
    session: AulesSession, course_id: str, course_url: str
) -> list[AttachmentRecord]:
    assign_map: dict[str, dict] = {}
    resource_links: list[dict] = []
    seen_res: set[str] = set()
    for target in (f"{session.base_url}/course/resources.php?id={urllib.parse.quote(course_id)}", course_url):
        try:
            st, _, raw, _ = _fetch_with_cookies(target, session.base_url, session.cookies)
            if st < 400:
                _collect_links_from_course_html(
                    raw.decode("utf-8", errors="ignore"),
                    session.base_url,
                    assign_map,
                    resource_links,
                    seen_res,
                )
        except Exception:
            pass
    return _resolve_resource_links(session, resource_links, limit=20)


def _parse_assignment_page(
    session: AulesSession, course: CourseRecord, cmid: str, info: dict, now: str
) -> TaskRecord | None:
    try:
        st, _, raw, _ = _fetch_with_cookies(info["url"], session.base_url, session.cookies)
        if st >= 400:
            return None
        doc = raw.decode("utf-8", errors="ignore")

        h1_m = re.search(r'<h1[^>]*>([\s\S]*?)</h1>', doc, flags=re.IGNORECASE)
        title = _strip_html(h1_m.group(1)) if h1_m else info["title"]
        title = re.sub(r"\s+", " ", title).strip() or info["title"]

        description_text = _extract_container_text(
            doc,
            ids={"intro"},
            classes={"activity-description", "assign-intro"},
        )
        if not description_text:
            description_text = "Sin descripción textual en el enunciado."

        due_date: str | None = None
        submission_status = "Pendiente"
        for tr in re.findall(r"<tr[^>]*>([\s\S]*?)</tr>", doc, flags=re.IGNORECASE):
            cells = re.findall(r"<t[hd][^>]*>([\s\S]*?)</t[hd]>", tr, flags=re.IGNORECASE)
            if len(cells) < 2:
                continue
            hdr = _strip_html(cells[0]).lower()
            val = _strip_html(cells[-1])
            if any(k in hdr for k in ("entrega", "due", "termini", "vence", "data límit")) and not any(
                k in hdr for k in ("estado", "estat", "status")
            ):
                due_date = val or due_date
            if any(k in hdr for k in ("estado de la entrega", "estat de la tramesa", "submission status")):
                submission_status = val or submission_status

        attachments: list[AttachmentRecord] = []
        seen_files: set[str] = set()
        main_m = re.search(r'id="region-main"[\s\S]*$', doc)
        scope = main_m.group(0) if main_m else doc
        for idx, (href, label) in enumerate(_extract_links(scope)):
            if "pluginfile.php" not in href:
                continue
            try:
                abs_url = assert_same_origin_aules_url(href, session.base_url)
                if abs_url in seen_files:
                    continue
                seen_files.add(abs_url)
                is_sub = "assignsubmission_file" in abs_url
                fname = sanitize_file_name(label) or _filename_from_disposition(None, abs_url)
                attachments.append(
                    AttachmentRecord(
                        id=f"att_{cmid}_{idx}",
                        name=fname,
                        source_url=abs_url,
                        mime_type=_guess_mime(fname),
                        byte_size=0,
                        downloaded=False,
                        source_type="student_submission" if is_sub else "assignment",
                    )
                )
            except Exception:
                pass

        online_block = _extract_container_text(doc, classes={"assignsubmission_onlinetext"})
        submitted_work_text = online_block[:MAX_EXTRACTED_CHARS] if online_block else ""

        has_student_files = any(a.source_type == "student_submission" for a in attachments)
        no_online = is_submission_not_required_status(submission_status)
        ns = submission_status.lower()
        explicit_not = no_online or any(
            k in ns
            for k in (
                "sin entrega", "no entregado", "no enviado", "sense lliuraments",
                "sense tramesa", "no submission", "nothing has been submitted",
                "not submitted", "borrador", "esborrany", "draft",
            )
        ) or ns == "pendiente"
        explicit_yes = not explicit_not and any(
            k in ns
            for k in (
                "enviado", "enviada", "entregado", "entregada", "tramesa per a qualificar",
                "tramesa realitzada", "lliurat", "submitted", "calificado", "qualificat", "graded",
            )
        )
        is_sub_in_aules = not no_online and (
            explicit_yes or (not explicit_not and (has_student_files or len(submitted_work_text) > 20))
        )

        status = "no_submission" if no_online else ("reference" if is_sub_in_aules else "detected")
        return TaskRecord(
            id=f"assign_{course.id}_{cmid}",
            course_id=course.id,
            course_name=course.name,
            title=title,
            url=info["url"],
            due_date=due_date,
            submission_status=submission_status,
            is_submitted_in_aules=is_sub_in_aules,
            requires_online_submission=not no_online,
            submitted_work_text=submitted_work_text or None,
            description_text=description_text,
            attachments=attachments,
            status=status,
            updated_at=now,
        )
    except Exception:
        return None


def discover_courses_and_tasks(
    session: AulesSession, on_progress: Callable[[str], None] | None = None
) -> tuple[list[CourseRecord], list[TaskRecord], dict[str, list[AttachmentRecord]]]:
    courses = _discover_enrolled_courses(session)
    tasks: list[TaskRecord] = []
    course_resources: dict[str, list[AttachmentRecord]] = {}
    now = datetime.now(timezone.utc).isoformat()

    for idx, course in enumerate(courses, start=1):
        assign_map: dict[str, dict] = {}
        resource_links: list[dict] = []
        seen_res: set[str] = set()
        for url in (
            f"{session.base_url}/mod/assign/index.php?id={urllib.parse.quote(course.id)}",
            f"{session.base_url}/course/resources.php?id={urllib.parse.quote(course.id)}",
            course.url,
        ):
            try:
                st, _, raw, _ = _fetch_with_cookies(url, session.base_url, session.cookies)
                if st < 400:
                    _collect_links_from_course_html(
                        raw.decode("utf-8", errors="ignore"),
                        session.base_url,
                        assign_map,
                        resource_links,
                        seen_res,
                    )
            except Exception:
                pass

        docs = _resolve_resource_links(session, resource_links, limit=25)
        course_resources[course.id] = docs
        course.resource_count = len(docs)

        with ThreadPoolExecutor(max_workers=4) as pool:
            parsed_tasks = list(
                pool.map(
                    lambda item: _parse_assignment_page(session, course, item[0], item[1], now),
                    assign_map.items(),
                )
            )
        course_tasks = [t for t in parsed_tasks if t is not None]
        course.task_count = len(course_tasks)
        tasks.extend(course_tasks)
        if on_progress:
            on_progress(f"Escaneadas {idx}/{len(courses)} asignaturas ({len(tasks)} tareas)")

    return courses, tasks, course_resources


def download_and_extract_attachment(
    session: AulesSession, attachment: AttachmentRecord
) -> tuple[bytes, str, str, int, str]:
    if attachment.downloaded and attachment.extracted_text and attachment.byte_size > 0:
        buf = attachment.extracted_text.encode("utf-8")
        return buf, attachment.name, attachment.mime_type, len(buf), attachment.extracted_text

    status, headers, raw, final_url = _fetch_with_cookies(
        attachment.source_url, session.base_url, session.cookies, method="GET", timeout=30
    )
    if status >= 400:
        raise RuntimeError(f"Error al descargar {attachment.name} (HTTP {status})")
    if len(raw) > MAX_ATTACHMENT_BYTES:
        raise RuntimeError(f"El archivo {attachment.name} supera el límite de 15 MB.")

    ct = (headers.get("content-type") or "").split(";")[0].strip()
    resolved_name = _filename_from_disposition(headers.get("content-disposition"), final_url)
    final_name = resolved_name or attachment.name
    mime_type = ct or _guess_mime(final_name)
    extracted = extract_text_from_bytes(final_name, mime_type, raw)
    return raw, final_name, mime_type, len(raw), extracted[:MAX_EXTRACTED_CHARS]
