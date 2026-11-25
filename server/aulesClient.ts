import * as cheerio from 'cheerio';
import mammoth from 'mammoth';
import { extractText } from 'unpdf';
import { isSubmissionNotRequiredStatus } from './contextEngine.ts';
import { assertSameOriginAulesUrl, sanitizeFileName, validateAulesBaseUrl } from './security.ts';
import type { AttachmentRecord, AulesSession, CourseRecord, TaskRecord } from './types.ts';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;
const MAX_EXTRACTED_CHARS = 24000;

function mergeCookies(jar: Record<string, string>, setCookieHeaders: string[]): void {
  for (const raw of setCookieHeaders) {
    const firstPart = raw.split(';')[0];
    const eqIndex = firstPart.indexOf('=');
    if (eqIndex <= 0) continue;
    const name = firstPart.slice(0, eqIndex).trim();
    const value = firstPart.slice(eqIndex + 1).trim();
    if (value === 'deleted' || value === '') {
      delete jar[name];
    } else {
      jar[name] = value;
    }
  }
}

function serializeCookieHeader(jar: Record<string, string>): string {
  return Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

function getSetCookieArray(headers: Headers): string[] {
  const anyHeaders = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof anyHeaders.getSetCookie === 'function') {
    return anyHeaders.getSetCookie();
  }
  const single = headers.get('set-cookie');
  return single ? [single] : [];
}

async function fetchWithCookies(
  url: string,
  baseUrl: string,
  cookies: Record<string, string>,
  init: RequestInit = {},
  maxRedirects = 8
): Promise<{ response: Response; finalUrl: string }> {
  let currentUrl = assertSameOriginAulesUrl(url, baseUrl).toString();

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const headers = new Headers(init.headers);
    headers.set('User-Agent', USER_AGENT);
    const cookieStr = serializeCookieHeader(cookies);
    if (cookieStr) {
      headers.set('Cookie', cookieStr);
    }

    const res = await fetch(currentUrl, {
      ...init,
      headers,
      redirect: 'manual',
    });

    mergeCookies(cookies, getSetCookieArray(res.headers));

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) {
        return { response: res, finalUrl: currentUrl };
      }

      let nextUrl: URL;
      try {
        nextUrl = assertSameOriginAulesUrl(location, baseUrl);
      } catch {
        throw new Error(
          `El portal redirigió a un dominio externo (${location}). Asegúrate de usar la URL directa de tu centro en Aules.`
        );
      }

      currentUrl = nextUrl.toString();
      if (res.status !== 307 && res.status !== 308) {
        init = { method: 'GET' };
      }
      continue;
    }

    return { response: res, finalUrl: currentUrl };
  }

  throw new Error('Demasiadas redirecciones al conectar con Aules');
}

function extractSesskey(html: string): string | null {
  const cfgMatch = html.match(/"sesskey"\s*:\s*"([a-zA-Z0-9]+)"/);
  if (cfgMatch) return cfgMatch[1];
  const linkMatch = html.match(/sesskey=([a-zA-Z0-9]+)/);
  if (linkMatch) return linkMatch[1];
  return null;
}

function extractUserFullName($: cheerio.CheerioAPI): string {
  const candidates = [
    $('.usertext').first().text().trim(),
    $('.usermenu .login').first().text().trim(),
    $('#user-menu-toggle').attr('title')?.trim() || '',
    $('.logininfo a').first().text().trim(),
    $('[data-region="user-menu"] span').first().text().trim(),
    $('.userbutton .usertext').first().text().trim(),
  ];
  for (const c of candidates) {
    if (c && !c.toLowerCase().includes('iniciar sesión') && !c.toLowerCase().includes('log in')) {
      return c.replace(/\s+/g, ' ').trim();
    }
  }
  return 'Estudiante de Aules';
}

export async function connectAules(
  rawUrl: string,
  username: string,
  password: string
): Promise<AulesSession> {
  const baseUrl = validateAulesBaseUrl(rawUrl);
  const cookies: Record<string, string> = {};

  const loginPageUrl = `${baseUrl}/login/index.php`;
  const { response: loginGetRes, finalUrl: loginPageFinalUrl } = await fetchWithCookies(
    loginPageUrl,
    baseUrl,
    cookies,
    { method: 'GET' }
  );

  if (!loginGetRes.ok) {
    throw new Error(`No se pudo abrir la página de acceso de Aules (HTTP ${loginGetRes.status})`);
  }

  const loginHtml = await loginGetRes.text();
  const $login = cheerio.load(loginHtml);
  const logintoken = $login('input[name="logintoken"]').attr('value') ?? '';
  const formAction = $login('form#login').attr('action') || loginPageFinalUrl;
  const postTarget = assertSameOriginAulesUrl(formAction, baseUrl).toString();

  const bodyParams = new URLSearchParams();
  bodyParams.set('anchor', '');
  if (logintoken) {
    bodyParams.set('logintoken', logintoken);
  }
  bodyParams.set('username', username.trim());
  bodyParams.set('password', password);

  const { response: postRes, finalUrl: afterLoginUrl } = await fetchWithCookies(
    postTarget,
    baseUrl,
    cookies,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Referer: loginPageFinalUrl,
      },
      body: bodyParams.toString(),
    }
  );

  const afterHtml = await postRes.text();
  const $after = cheerio.load(afterHtml);

  const loginErrorText =
    $after('.loginerrors .alert').text().trim() ||
    $after('#loginerrormessage').text().trim() ||
    $after('.alert-danger').first().text().trim();

  if (afterLoginUrl.includes('/login/index.php') && ($after('form#login').length > 0 || loginErrorText)) {
    throw new Error(
      loginErrorText || 'Credenciales incorrectas o el portal requiere verificación adicional en Aules'
    );
  }

  const { response: myRes, finalUrl: myFinalUrl } = await fetchWithCookies(
    `${baseUrl}/my/`,
    baseUrl,
    cookies,
    { method: 'GET' }
  );
  const myHtml = await myRes.text();
  const $my = cheerio.load(myHtml);

  if ($my('form#login').length > 0 && myFinalUrl.includes('/login/')) {
    throw new Error('La sesión de Aules no se mantuvo activa tras el inicio de sesión');
  }

  const sesskey = extractSesskey(myHtml) || extractSesskey(afterHtml);
  const fullName = extractUserFullName($my) || username.trim();

  return {
    baseUrl,
    username: username.trim(),
    fullName,
    cookies,
    sesskey,
    connectedAt: new Date().toISOString(),
  };
}

interface MoodleAjaxCourse {
  id: number;
  fullname: string;
  shortname?: string;
  viewurl?: string;
}

async function callMoodleAjax<T>(
  session: AulesSession,
  methodname: string,
  args: Record<string, unknown>
): Promise<T | null> {
  if (!session.sesskey) return null;
  const endpoint = `${session.baseUrl}/lib/ajax/service.php?sesskey=${encodeURIComponent(
    session.sesskey
  )}&info=${encodeURIComponent(methodname)}`;

  try {
    const { response } = await fetchWithCookies(endpoint, session.baseUrl, session.cookies, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: JSON.stringify([{ index: 0, methodname, args }]),
    });

    if (!response.ok) return null;
    const json = (await response.json()) as Array<{
      error?: boolean;
      data?: T;
    }>;

    const first = json?.[0];
    if (!first || first.error || !first.data) return null;
    return first.data;
  } catch {
    return null;
  }
}

async function discoverEnrolledCourses(session: AulesSession): Promise<CourseRecord[]> {
  const courseMap = new Map<string, CourseRecord>();
  const now = new Date().toISOString();

  const addCourse = (id: string, name: string, shortname?: string, url?: string) => {
    const cleanId = id.trim();
    const cleanName = name.replace(/\s+/g, ' ').trim();
    if (!cleanId || cleanId === '1' || !cleanName || cleanName.length < 2) return;
    if (!courseMap.has(cleanId)) {
      courseMap.set(cleanId, {
        id: cleanId,
        name: cleanName,
        shortname: (shortname || cleanName).trim().slice(0, 40),
        url: url || `${session.baseUrl}/course/view.php?id=${cleanId}`,
        resourceCount: 0,
        taskCount: 0,
        lastScannedAt: now,
      });
    }
  };

  // Ensure fresh sesskey from /my/courses.php if needed
  try {
    const { response } = await fetchWithCookies(
      `${session.baseUrl}/my/courses.php`,
      session.baseUrl,
      session.cookies,
      { method: 'GET' }
    );
    if (response.ok) {
      const html = await response.text();
      const freshKey = extractSesskey(html);
      if (freshKey) session.sesskey = freshKey;
    }
  } catch {
    // Non-fatal
  }

  // Strategy 1: Moodle 4.x/5.x AJAX APIs (try multiple classifications without extra optional args)
  for (const classification of ['inprogress', 'all', 'future', 'past']) {
    const data = await callMoodleAjax<{ courses?: MoodleAjaxCourse[] }>(
      session,
      'core_course_get_enrolled_courses_by_classification',
      {
        offset: 0,
        limit: 0,
        classification,
        sort: 'fullname',
      }
    );
    if (data?.courses) {
      for (const c of data.courses) {
        addCourse(String(c.id), c.fullname, c.shortname, c.viewurl);
      }
    }
  }

  // Strategy 1b: Recent courses AJAX
  const recent = await callMoodleAjax<MoodleAjaxCourse[]>(
    session,
    'core_course_get_recent_courses',
    { userid: 0, limit: 50 }
  );
  if (Array.isArray(recent)) {
    for (const c of recent) {
      addCourse(String(c.id), c.fullname, c.shortname, c.viewurl);
    }
  }

  // Strategy 2: User Profile page (/user/profile.php) ALWAYS renders enrolled courses in server HTML
  try {
    const { response } = await fetchWithCookies(
      `${session.baseUrl}/user/profile.php`,
      session.baseUrl,
      session.cookies,
      { method: 'GET' }
    );
    if (response.ok) {
      const html = await response.text();
      const $ = cheerio.load(html);
      $('#region-main a[href*="course="], #region-main a[href*="course/view.php?id="]').each(
        (_, el) => {
          const href = $(el).attr('href');
          const text = $(el).text().replace(/\s+/g, ' ').trim();
          if (!href || !text) return;
          try {
            const parsed = assertSameOriginAulesUrl(href, session.baseUrl);
            const cid = parsed.searchParams.get('course') || parsed.searchParams.get('id');
            if (cid) {
              addCourse(cid, text);
            }
          } catch {
            // Ignore
          }
        }
      );
    }
  } catch {
    // Non-fatal
  }

  // Strategy 3: Grades Overview (/grade/report/overview/index.php) ALWAYS renders enrolled courses table
  try {
    const { response } = await fetchWithCookies(
      `${session.baseUrl}/grade/report/overview/index.php`,
      session.baseUrl,
      session.cookies,
      { method: 'GET' }
    );
    if (response.ok) {
      const html = await response.text();
      const $ = cheerio.load(html);
      $('#overview-grade a[href*="id="], #region-main table.generaltable a[href*="id="]').each(
        (_, el) => {
          const href = $(el).attr('href');
          const text = $(el).text().replace(/\s+/g, ' ').trim();
          if (!href || !text) return;
          try {
            const parsed = assertSameOriginAulesUrl(href, session.baseUrl);
            const cid = parsed.searchParams.get('id');
            if (cid) {
              addCourse(cid, text);
            }
          } catch {
            // Ignore
          }
        }
      );
    }
  } catch {
    // Non-fatal
  }

  // Strategy 4: Fallback HTML scraping on /my/courses.php and /my/ inside #region-main (avoid navbar noise)
  if (courseMap.size === 0) {
    for (const pathSuffix of ['/my/courses.php', '/my/', '/course/index.php?mycourses=1']) {
      try {
        const { response } = await fetchWithCookies(
          `${session.baseUrl}${pathSuffix}`,
          session.baseUrl,
          session.cookies,
          { method: 'GET' }
        );
        if (!response.ok) continue;
        const html = await response.text();
        const $ = cheerio.load(html);

        $('#region-main a[href*="course/view.php?id="], [data-region="drawer"] a[href*="course/view.php?id="]').each(
          (_, el) => {
            const href = $(el).attr('href');
            const text = $(el).text().replace(/\s+/g, ' ').trim();
            if (!href || !text) return;
            try {
              const parsed = assertSameOriginAulesUrl(href, session.baseUrl);
              const cid = parsed.searchParams.get('id');
              if (cid) addCourse(cid, text);
            } catch {
              // Ignore
            }
          }
        );
      } catch {
        // Continue
      }
    }
  }

  // Filter out Aules general student manual (course id 582) if real courses were found
  if (courseMap.size > 1 && courseMap.has('582')) {
    const manual = courseMap.get('582');
    if (manual && manual.name.toLowerCase().includes('manual')) {
      courseMap.delete('582');
    }
  }

  return Array.from(courseMap.values());
}

function guessMimeFromName(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith('.pdf')) return 'application/pdf';
  if (lower.endsWith('.docx'))
    return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (lower.endsWith('.doc')) return 'application/msword';
  if (lower.endsWith('.txt')) return 'text/plain';
  if (lower.endsWith('.md')) return 'text/markdown';
  if (lower.endsWith('.csv')) return 'text/csv';
  if (lower.endsWith('.json')) return 'application/json';
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'text/html';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  return 'application/octet-stream';
}

function extractFileNameFromDisposition(headerVal: string | null, fallbackUrl: string): string {
  if (headerVal) {
    const utf8Match = headerVal.match(/filename\*=UTF-8''([^;]+)/i);
    if (utf8Match) {
      try {
        return sanitizeFileName(decodeURIComponent(utf8Match[1]));
      } catch {
        // Fallback below
      }
    }
    const stdMatch = headerVal.match(/filename="?([^";]+)"?/i);
    if (stdMatch) {
      return sanitizeFileName(stdMatch[1]);
    }
  }

  try {
    const u = new URL(fallbackUrl);
    const seg = u.pathname.split('/').filter(Boolean).pop();
    if (seg) return sanitizeFileName(decodeURIComponent(seg));
  } catch {
    // Ignore
  }
  return 'documento_aules';
}

async function runPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>
): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      await worker(items[i], i);
    }
  });
  await Promise.all(runners);
}

export async function verifyAulesSessionAlive(session: AulesSession): Promise<boolean> {
  try {
    const { response, finalUrl } = await fetchWithCookies(
      `${session.baseUrl}/my/`,
      session.baseUrl,
      session.cookies,
      { method: 'GET' }
    );
    if (!response.ok) return false;
    if (finalUrl.includes('/login/')) return false;
    const html = await response.text();
    const $ = cheerio.load(html);
    if ($('form#login').length > 0) return false;
    const freshKey = extractSesskey(html);
    if (freshKey) session.sesskey = freshKey;
    return true;
  } catch {
    return false;
  }
}

export async function discoverCoursesAndTasks(
  session: AulesSession,
  onProgress?: (message: string) => void
): Promise<{
  courses: CourseRecord[];
  tasks: TaskRecord[];
  courseResources: Record<string, AttachmentRecord[]>;
}> {
  const courses = await discoverEnrolledCourses(session);
  const tasks: TaskRecord[] = [];
  const courseResources: Record<string, AttachmentRecord[]> = {};
  const now = new Date().toISOString();
  let scannedCount = 0;

  await runPool(courses, 4, async (course) => {
    const assignMap = new Map<string, { title: string; url: string; dueDateHint?: string }>();
    const resourceLinks: Array<{
      id: string;
      title: string;
      url: string;
      kind: 'resource' | 'folder' | 'page' | 'book' | 'file';
    }> = [];
    const seenResourceHref = new Set<string>();

    const collectLinksFromHtml = (html: string) => {
      const $doc = cheerio.load(html);
      $doc('#region-main a[href], .course-content a[href], table.generaltable a[href]').each(
        (_, el) => {
          const href = $doc(el).attr('href');
          if (!href) return;
          let parsed: URL;
          try {
            parsed = assertSameOriginAulesUrl(href, session.baseUrl);
          } catch {
            return;
          }

          const rawLabel = $doc(el).text().replace(/\s+/g, ' ').trim();
          const label =
            rawLabel.replace(/(Tarea|Tasca|Archivo|Fitxer|Carpeta|Página|Pàgina|Libro|Llibre)$/i, '').trim() ||
            'Elemento sin título';

          if (parsed.pathname.includes('/mod/assign/view.php')) {
            const cmid = parsed.searchParams.get('id');
            if (cmid && !assignMap.has(cmid)) {
              assignMap.set(cmid, { title: label, url: parsed.toString() });
            }
          } else if (parsed.pathname.includes('/mod/resource/view.php')) {
            const cmid = parsed.searchParams.get('id');
            if (cmid && !seenResourceHref.has(parsed.toString())) {
              seenResourceHref.add(parsed.toString());
              resourceLinks.push({
                id: `res_${cmid}`,
                title: label,
                url: parsed.toString(),
                kind: 'resource',
              });
            }
          } else if (parsed.pathname.includes('/mod/folder/view.php')) {
            const cmid = parsed.searchParams.get('id');
            if (cmid && !seenResourceHref.has(parsed.toString())) {
              seenResourceHref.add(parsed.toString());
              resourceLinks.push({
                id: `fld_${cmid}`,
                title: label,
                url: parsed.toString(),
                kind: 'folder',
              });
            }
          } else if (parsed.pathname.includes('/mod/page/view.php')) {
            const cmid = parsed.searchParams.get('id');
            if (cmid && !seenResourceHref.has(parsed.toString())) {
              seenResourceHref.add(parsed.toString());
              resourceLinks.push({
                id: `pag_${cmid}`,
                title: label,
                url: parsed.toString(),
                kind: 'page',
              });
            }
          } else if (parsed.pathname.includes('/mod/book/view.php')) {
            const cmid = parsed.searchParams.get('id');
            if (cmid && !seenResourceHref.has(parsed.toString())) {
              seenResourceHref.add(parsed.toString());
              resourceLinks.push({
                id: `bok_${cmid}`,
                title: label,
                url: parsed.toString(),
                kind: 'book',
              });
            }
          } else if (parsed.pathname.includes('/pluginfile.php/')) {
            if (!seenResourceHref.has(parsed.toString())) {
              seenResourceHref.add(parsed.toString());
              const fileName = extractFileNameFromDisposition(null, parsed.toString());
              resourceLinks.push({
                id: `pf_${Buffer.from(parsed.pathname).toString('base64url').slice(0, 16)}`,
                title: fileName,
                url: parsed.toString(),
                kind: 'file',
              });
            }
          }
        }
      );
    };

    const assignIndexUrl = `${session.baseUrl}/mod/assign/index.php?id=${encodeURIComponent(course.id)}`;
    const resourcesIndexUrl = `${session.baseUrl}/course/resources.php?id=${encodeURIComponent(course.id)}`;

    let courseMainHtml = '';
    await Promise.all([
      fetchWithCookies(assignIndexUrl, session.baseUrl, session.cookies, { method: 'GET' })
        .then(async ({ response }) => {
          if (response.ok) collectLinksFromHtml(await response.text());
        })
        .catch(() => {}),
      fetchWithCookies(resourcesIndexUrl, session.baseUrl, session.cookies, { method: 'GET' })
        .then(async ({ response }) => {
          if (response.ok) collectLinksFromHtml(await response.text());
        })
        .catch(() => {}),
      fetchWithCookies(course.url, session.baseUrl, session.cookies, { method: 'GET' })
        .then(async ({ response }) => {
          if (response.ok) {
            courseMainHtml = await response.text();
            collectLinksFromHtml(courseMainHtml);
          }
        })
        .catch(() => {}),
    ]);

    // Only crawl individual section pages if Moodle indexes yielded zero assignments
    if (assignMap.size === 0 && courseMainHtml) {
      const $c = cheerio.load(courseMainHtml);
      const sectionUrls: string[] = [];
      $c('a[href*="course/view.php"][href*="section="], a[href*="course/section.php?id="]').each(
        (_, el) => {
          const href = $c(el).attr('href');
          if (!href) return;
          try {
            const abs = assertSameOriginAulesUrl(href, session.baseUrl).toString();
            if (!sectionUrls.includes(abs)) sectionUrls.push(abs);
          } catch {
            // Ignore
          }
        }
      );

      await runPool(sectionUrls.slice(0, 12), 4, async (secUrl) => {
        try {
          const { response: secRes } = await fetchWithCookies(
            secUrl,
            session.baseUrl,
            session.cookies,
            { method: 'GET' }
          );
          if (secRes.ok) collectLinksFromHtml(await secRes.text());
        } catch {
          // Non-fatal
        }
      });
    }

    // Resolve course resources concurrently (capped at 25 per course)
    const seenResUrls = new Set<string>();
    const resolvedCourseDocs: AttachmentRecord[] = [];
    await runPool(resourceLinks.slice(0, 25), 4, async (r) => {
      if (seenResUrls.has(r.url)) return;
      seenResUrls.add(r.url);

      if (r.kind === 'file') {
        resolvedCourseDocs.push({
          id: r.id,
          name: r.title,
          sourceUrl: r.url,
          mimeType: guessMimeFromName(r.title),
          byteSize: 0,
          downloaded: false,
          extractedText: '',
          sourceType: 'course_resource',
        });
        return;
      }

      try {
        const { response: resPage, finalUrl } = await fetchWithCookies(
          r.url,
          session.baseUrl,
          session.cookies,
          { method: 'GET' }
        );
        const contentType = resPage.headers.get('content-type') || '';
        if (!contentType.includes('text/html')) {
          const fname = extractFileNameFromDisposition(
            resPage.headers.get('content-disposition'),
            finalUrl
          );
          resolvedCourseDocs.push({
            id: r.id,
            name: fname,
            sourceUrl: finalUrl,
            mimeType: contentType.split(';')[0].trim() || guessMimeFromName(fname),
            byteSize: 0,
            downloaded: false,
            extractedText: '',
            sourceType: 'course_resource',
          });
        } else {
          const html = await resPage.text();
          const $res = cheerio.load(html);

          if (r.kind === 'page' || r.kind === 'book') {
            const pageText = $res('#region-main .box.generalbox, #region-main [role="main"]')
              .text()
              .replace(/\s+\n/g, '\n')
              .replace(/\n{3,}/g, '\n\n')
              .trim();
            if (pageText.length > 25) {
              resolvedCourseDocs.push({
                id: r.id,
                name: `${sanitizeFileName(r.title)}.txt`,
                sourceUrl: finalUrl,
                mimeType: 'text/plain',
                byteSize: Buffer.byteLength(pageText, 'utf-8'),
                downloaded: true,
                extractedText: pageText.slice(0, MAX_EXTRACTED_CHARS),
                sourceType: 'course_resource',
              });
            }
          }

          $res('#region-main a[href*="pluginfile.php"], .resourceworkaround a[href]').each(
            (idx, linkEl) => {
              const linkHref = $res(linkEl).attr('href');
              if (!linkHref) return;
              try {
                const abs = assertSameOriginAulesUrl(linkHref, session.baseUrl).toString();
                if (seenResUrls.has(abs)) return;
                seenResUrls.add(abs);
                const fname =
                  sanitizeFileName($res(linkEl).text().trim()) ||
                  extractFileNameFromDisposition(null, abs);
                resolvedCourseDocs.push({
                  id: `${r.id}_${idx}`,
                  name: fname,
                  sourceUrl: abs,
                  mimeType: guessMimeFromName(fname),
                  byteSize: 0,
                  downloaded: false,
                  extractedText: '',
                  sourceType: 'course_resource',
                });
              } catch {
                // Ignore
              }
            }
          );
        }
      } catch {
        // Non-fatal
      }
    });

    courseResources[course.id] = resolvedCourseDocs;
    course.resourceCount = resolvedCourseDocs.length;

    // Fetch assignment detail pages concurrently
    const assignEntries = Array.from(assignMap.entries());
    await runPool(assignEntries, 4, async ([cmid, info]) => {
      try {
        const { response: assignRes } = await fetchWithCookies(
          info.url,
          session.baseUrl,
          session.cookies,
          { method: 'GET' }
        );
        if (!assignRes.ok) return;

        const assignHtml = await assignRes.text();
        const $assign = cheerio.load(assignHtml);

        const title =
          $assign('.page-header-headings h1').first().text().trim() ||
          $assign('#region-main h2').first().text().trim() ||
          info.title;

        const descriptionText =
          $assign(
            '.activity-description, #intro, .assign-intro, #region-main .box.generalbox .no-overflow'
          )
            .first()
            .text()
            .replace(/[ \t]+/g, ' ')
            .replace(/\n{3,}/g, '\n\n')
            .trim() || 'Sin descripción textual en el enunciado.';

        let dueDate: string | null = info.dueDateHint || null;
        let submissionStatus = 'Pendiente';

        $assign('table.generaltable tr').each((_, row) => {
          const headerCell = $assign(row).find('th, td.c0').first().text().trim().toLowerCase();
          const valCell = $assign(row).find('td.c1, td').last().text().replace(/\s+/g, ' ').trim();
          if (
            headerCell.includes('entrega') ||
            headerCell.includes('due') ||
            headerCell.includes('termini') ||
            headerCell.includes('vence') ||
            headerCell.includes('data límit')
          ) {
            if (
              !headerCell.includes('estado') &&
              !headerCell.includes('estat') &&
              !headerCell.includes('status')
            ) {
              dueDate = valCell || dueDate;
            }
          }
          if (
            headerCell.includes('estado de la entrega') ||
            headerCell.includes('estat de la tramesa') ||
            headerCell.includes('submission status')
          ) {
            submissionStatus = valCell || submissionStatus;
          }
        });

        if (!dueDate) {
          const activityDates = $assign('[data-region="activity-dates"]')
            .text()
            .replace(/\s+/g, ' ')
            .trim();
          if (activityDates) dueDate = activityDates;
        }

        const attachments: AttachmentRecord[] = [];
        const seenAssignFiles = new Set<string>();
        $assign('#region-main a[href*="pluginfile.php"]').each((idx, el) => {
          const href = $assign(el).attr('href');
          if (!href) return;
          try {
            const abs = assertSameOriginAulesUrl(href, session.baseUrl).toString();
            if (seenAssignFiles.has(abs)) return;
            seenAssignFiles.add(abs);
            const isStudentSubmissionFile =
              abs.includes('assignsubmission_file') ||
              $assign(el).closest('.submissionstatustable, .assignsubmission_file').length > 0;
            const name =
              sanitizeFileName($assign(el).text().trim()) ||
              extractFileNameFromDisposition(null, abs);
            attachments.push({
              id: `att_${cmid}_${idx}`,
              name,
              sourceUrl: abs,
              mimeType: guessMimeFromName(name),
              byteSize: 0,
              downloaded: false,
              extractedText: '',
              sourceType: isStudentSubmissionFile ? 'student_submission' : 'assignment',
            });
          } catch {
            // Ignore
          }
        });

        const submittedWorkText = $assign(
          '.submissionstatustable .assignsubmission_onlinetext .no-overflow, .assignsubmission_onlinetext .no-overflow'
        )
          .text()
          .replace(/[ \t]+/g, ' ')
          .replace(/\n{3,}/g, '\n\n')
          .trim()
          .slice(0, MAX_EXTRACTED_CHARS);

        const hasStudentFiles = attachments.some((a) => a.sourceType === 'student_submission');
        const noOnlineSubmissionRequired = isSubmissionNotRequiredStatus(submissionStatus);
        const normalizedStatus = submissionStatus.toLowerCase();
        const explicitlyNotSubmitted =
          noOnlineSubmissionRequired ||
          normalizedStatus.includes('sin entrega') ||
          normalizedStatus.includes('no entregado') ||
          normalizedStatus.includes('no enviado') ||
          normalizedStatus.includes('sense lliuraments') ||
          normalizedStatus.includes('sense tramesa') ||
          normalizedStatus.includes('no submission') ||
          normalizedStatus.includes('nothing has been submitted') ||
          normalizedStatus.includes('not submitted') ||
          normalizedStatus.includes('borrador') ||
          normalizedStatus.includes('esborrany') ||
          normalizedStatus.includes('draft') ||
          normalizedStatus === 'pendiente';
        const explicitlySubmitted =
          !explicitlyNotSubmitted &&
          (normalizedStatus.includes('enviado') ||
            normalizedStatus.includes('enviada') ||
            normalizedStatus.includes('entregado') ||
            normalizedStatus.includes('entregada') ||
            normalizedStatus.includes('tramesa per a qualificar') ||
            normalizedStatus.includes('tramesa realitzada') ||
            normalizedStatus.includes('lliurat') ||
            normalizedStatus.includes('submitted') ||
            normalizedStatus.includes('calificado') ||
            normalizedStatus.includes('qualificat') ||
            normalizedStatus.includes('graded'));
        const isSubmittedInAules =
          !noOnlineSubmissionRequired &&
          (explicitlySubmitted ||
            (!explicitlyNotSubmitted && (hasStudentFiles || submittedWorkText.length > 20)));

        tasks.push({
          id: `assign_${course.id}_${cmid}`,
          courseId: course.id,
          courseName: course.name,
          title: title.replace(/\s+/g, ' ').trim(),
          url: info.url,
          dueDate,
          submissionStatus,
          isSubmittedInAules,
          requiresOnlineSubmission: !noOnlineSubmissionRequired,
          submittedWorkText: submittedWorkText || undefined,
          descriptionText,
          attachments,
          status: noOnlineSubmissionRequired
            ? 'no_submission'
            : isSubmittedInAules
            ? 'reference'
            : 'detected',
          updatedAt: now,
        });
      } catch {
        // Non-fatal
      }
    });

    course.taskCount = tasks.filter((t) => t.courseId === course.id).length;
    scannedCount++;
    onProgress?.(`Escaneadas ${scannedCount}/${courses.length} asignaturas (${tasks.length} tareas)`);
  });

  return { courses, tasks, courseResources };
}

export async function discoverCourseResourcesForCourse(
  session: AulesSession,
  courseId: string,
  courseUrl: string
): Promise<AttachmentRecord[]> {
  const resourceLinks: Array<{
    id: string;
    title: string;
    url: string;
    kind: 'resource' | 'folder' | 'page' | 'book' | 'file';
  }> = [];
  const seenHref = new Set<string>();

  const collect = (html: string) => {
    const $doc = cheerio.load(html);
    $doc('#region-main a[href], .course-content a[href], table.generaltable a[href]').each(
      (_, el) => {
        const href = $doc(el).attr('href');
        if (!href) return;
        let parsed: URL;
        try {
          parsed = assertSameOriginAulesUrl(href, session.baseUrl);
        } catch {
          return;
        }
        const rawLabel = $doc(el).text().replace(/\s+/g, ' ').trim();
        const label =
          rawLabel.replace(/(Archivo|Fitxer|Carpeta|Página|Pàgina|Libro|Llibre)$/i, '').trim() ||
          'Recurso';
        if (parsed.pathname.includes('/mod/resource/view.php')) {
          const cmid = parsed.searchParams.get('id');
          if (cmid && !seenHref.has(parsed.toString())) {
            seenHref.add(parsed.toString());
            resourceLinks.push({ id: `res_${cmid}`, title: label, url: parsed.toString(), kind: 'resource' });
          }
        } else if (parsed.pathname.includes('/mod/folder/view.php')) {
          const cmid = parsed.searchParams.get('id');
          if (cmid && !seenHref.has(parsed.toString())) {
            seenHref.add(parsed.toString());
            resourceLinks.push({ id: `fld_${cmid}`, title: label, url: parsed.toString(), kind: 'folder' });
          }
        } else if (parsed.pathname.includes('/mod/page/view.php')) {
          const cmid = parsed.searchParams.get('id');
          if (cmid && !seenHref.has(parsed.toString())) {
            seenHref.add(parsed.toString());
            resourceLinks.push({ id: `pag_${cmid}`, title: label, url: parsed.toString(), kind: 'page' });
          }
        } else if (parsed.pathname.includes('/mod/book/view.php')) {
          const cmid = parsed.searchParams.get('id');
          if (cmid && !seenHref.has(parsed.toString())) {
            seenHref.add(parsed.toString());
            resourceLinks.push({ id: `bok_${cmid}`, title: label, url: parsed.toString(), kind: 'book' });
          }
        } else if (parsed.pathname.includes('/pluginfile.php/')) {
          if (!seenHref.has(parsed.toString())) {
            seenHref.add(parsed.toString());
            resourceLinks.push({
              id: `pf_${Buffer.from(parsed.pathname).toString('base64url').slice(0, 16)}`,
              title: extractFileNameFromDisposition(null, parsed.toString()),
              url: parsed.toString(),
              kind: 'file',
            });
          }
        }
      }
    );
  };

  await Promise.all([
    fetchWithCookies(`${session.baseUrl}/course/resources.php?id=${encodeURIComponent(courseId)}`, session.baseUrl, session.cookies, { method: 'GET' })
      .then(async ({ response }) => { if (response.ok) collect(await response.text()); })
      .catch(() => {}),
    fetchWithCookies(courseUrl, session.baseUrl, session.cookies, { method: 'GET' })
      .then(async ({ response }) => { if (response.ok) collect(await response.text()); })
      .catch(() => {}),
  ]);

  const docs: AttachmentRecord[] = [];
  const seenUrls = new Set<string>();
  await runPool(resourceLinks.slice(0, 20), 4, async (r) => {
    if (seenUrls.has(r.url)) return;
    seenUrls.add(r.url);
    if (r.kind === 'file') {
      docs.push({
        id: r.id,
        name: r.title,
        sourceUrl: r.url,
        mimeType: guessMimeFromName(r.title),
        byteSize: 0,
        downloaded: false,
        extractedText: '',
        sourceType: 'course_resource',
      });
      return;
    }
    try {
      const { response, finalUrl } = await fetchWithCookies(r.url, session.baseUrl, session.cookies, { method: 'GET' });
      const ct = response.headers.get('content-type') || '';
      if (!ct.includes('text/html')) {
        const fname = extractFileNameFromDisposition(response.headers.get('content-disposition'), finalUrl);
        docs.push({
          id: r.id,
          name: fname,
          sourceUrl: finalUrl,
          mimeType: ct.split(';')[0].trim() || guessMimeFromName(fname),
          byteSize: 0,
          downloaded: false,
          extractedText: '',
          sourceType: 'course_resource',
        });
      } else {
        const html = await response.text();
        const $res = cheerio.load(html);
        if (r.kind === 'page' || r.kind === 'book') {
          const pageText = $res('#region-main .box.generalbox, #region-main [role="main"]')
            .text()
            .replace(/\s+\n/g, '\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
          if (pageText.length > 25) {
            docs.push({
              id: r.id,
              name: `${sanitizeFileName(r.title)}.txt`,
              sourceUrl: finalUrl,
              mimeType: 'text/plain',
              byteSize: Buffer.byteLength(pageText, 'utf-8'),
              downloaded: true,
              extractedText: pageText.slice(0, MAX_EXTRACTED_CHARS),
              sourceType: 'course_resource',
            });
          }
        }
        $res('#region-main a[href*="pluginfile.php"], .resourceworkaround a[href]').each((idx, linkEl) => {
          const href = $res(linkEl).attr('href');
          if (!href) return;
          try {
            const abs = assertSameOriginAulesUrl(href, session.baseUrl).toString();
            if (seenUrls.has(abs)) return;
            seenUrls.add(abs);
            const fname = sanitizeFileName($res(linkEl).text().trim()) || extractFileNameFromDisposition(null, abs);
            docs.push({
              id: `${r.id}_${idx}`,
              name: fname,
              sourceUrl: abs,
              mimeType: guessMimeFromName(fname),
              byteSize: 0,
              downloaded: false,
              extractedText: '',
              sourceType: 'course_resource',
            });
          } catch {
            // Ignore
          }
        });
      }
    } catch {
      // Ignore
    }
  });

  return docs;
}

export async function downloadAndExtractAttachment(
  session: AulesSession,
  attachment: AttachmentRecord
): Promise<{
  buffer: Buffer;
  fileName: string;
  mimeType: string;
  byteSize: number;
  extractedText: string;
}> {
  if (attachment.downloaded && attachment.extractedText && attachment.byteSize > 0) {
    const buf = Buffer.from(attachment.extractedText, 'utf-8');
    return {
      buffer: buf,
      fileName: attachment.name,
      mimeType: attachment.mimeType,
      byteSize: buf.length,
      extractedText: attachment.extractedText,
    };
  }

  const { response, finalUrl } = await fetchWithCookies(
    attachment.sourceUrl,
    session.baseUrl,
    session.cookies,
    { method: 'GET' }
  );

  if (!response.ok) {
    throw new Error(`Error al descargar ${attachment.name} (HTTP ${response.status})`);
  }

  const arrayBuffer = await response.arrayBuffer();
  if (arrayBuffer.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new Error(`El archivo ${attachment.name} supera el límite de 15 MB`);
  }

  const buffer = Buffer.from(arrayBuffer);
  const contentType = response.headers.get('content-type')?.split(';')[0].trim() || '';
  const resolvedName = extractFileNameFromDisposition(
    response.headers.get('content-disposition'),
    finalUrl
  );
  const finalName = resolvedName || attachment.name;
  const mimeType = contentType || guessMimeFromName(finalName);

  let extractedText = '';
  const lowerName = finalName.toLowerCase();

  try {
    if (mimeType === 'application/pdf' || lowerName.endsWith('.pdf')) {
      const parsed = await extractText(new Uint8Array(buffer), { mergePages: true });
      extractedText = typeof parsed.text === 'string' ? parsed.text : '';
    } else if (
      mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      lowerName.endsWith('.docx')
    ) {
      const parsed = await mammoth.extractRawText({ buffer });
      extractedText = parsed.value || '';
    } else if (mimeType === 'text/html' || lowerName.endsWith('.html') || lowerName.endsWith('.htm')) {
      const $doc = cheerio.load(buffer.toString('utf-8'));
      $doc('script, style, nav').remove();
      extractedText = $doc('body').text().replace(/\s+/g, ' ').trim();
    } else if (
      mimeType.startsWith('text/') ||
      mimeType === 'application/json' ||
      /\.(txt|md|csv|json|py|java|js|ts|tsx|sql|xml|yaml|yml)$/i.test(lowerName)
    ) {
      extractedText = buffer.toString('utf-8');
    }
  } catch {
    extractedText = '[Archivo binario adjunto; no fue posible extraer texto plano]';
  }

  return {
    buffer,
    fileName: finalName,
    mimeType,
    byteSize: buffer.length,
    extractedText: extractedText.trim().slice(0, MAX_EXTRACTED_CHARS),
  };
}
