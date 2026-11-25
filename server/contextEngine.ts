import type { AttachmentRecord, SubjectKnowledge, TaskRecord } from './types.ts';

const STOPWORDS = new Set([
  'para', 'como', 'este', 'esta', 'estos', 'estas', 'pero', 'porque', 'sobre', 'entre',
  'desde', 'hasta', 'donde', 'cuando', 'quien', 'cual', 'todos', 'todas', 'todo', 'toda',
  'cada', 'otro', 'otra', 'otros', 'otras', 'unos', 'unas', 'tiene', 'tienen', 'hacer',
  'debe', 'deben', 'puede', 'pueden', 'será', 'sera', 'aqui', 'aquí', 'entrega', 'entregar',
  'tarea', 'tasca', 'actividad', 'activitat', 'practica', 'práctica', 'ejercicio', 'ejercicios',
  'realizar', 'subir', 'aules', 'moodle', 'documento', 'archivo', 'fichero', 'pdf', 'docx',
  'html', 'amb', 'per', 'que', 'dels', 'les', 'els', 'una', 'uns', 'unes', 'seva', 'seu',
  'with', 'from', 'that', 'this', 'your', 'have', 'will', 'into', 'the', 'and', 'for',
]);

function normalizeText(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function tokenize(input: string): string[] {
  const clean = normalizeText(input).replace(/[^a-z0-9_]+/g, ' ');
  return clean
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !STOPWORDS.has(w));
}

export function isSubmissionNotRequiredStatus(statusText: string): boolean {
  const s = normalizeText(statusText);
  return (
    s.includes('no requereix que trameteu res') ||
    s.includes('no requereix cap tramesa') ||
    s.includes('no es requereix cap tramesa') ||
    s.includes('no requereix lliurament') ||
    s.includes('no requiere que envie') ||
    s.includes('no se requiere entrega') ||
    s.includes('no requiere entrega en linea') ||
    s.includes('no online submissions are required') ||
    s.includes('no submission required') ||
    s.includes('nothing is required to be submitted')
  );
}

export function isTaskNoSubmission(task: TaskRecord): boolean {
  if (task.requiresOnlineSubmission === false || task.status === 'no_submission') {
    return true;
  }
  return isSubmissionNotRequiredStatus(task.submissionStatus || '');
}

export function isTaskSubmittedInAules(task: TaskRecord): boolean {
  if (isTaskNoSubmission(task)) return false;
  if (typeof task.isSubmittedInAules === 'boolean') {
    return task.isSubmittedInAules;
  }
  if (task.status === 'reference') return true;

  const s = normalizeText(task.submissionStatus || '');
  const notSubmitted =
    s.includes('sin entrega') ||
    s.includes('no entregado') ||
    s.includes('no enviado') ||
    s.includes('sense lliuraments') ||
    s.includes('sense tramesa') ||
    s.includes('encara no s\'ha fet cap tramesa') ||
    s.includes('no submission') ||
    s.includes('nothing has been submitted') ||
    s.includes('not submitted') ||
    s.includes('borrador') ||
    s.includes('esborrany') ||
    s.includes('draft') ||
    s === 'pendiente';
  if (notSubmitted) return false;

  const submitted =
    s.includes('enviado') ||
    s.includes('enviada') ||
    s.includes('entregado') ||
    s.includes('entregada') ||
    s.includes('tramesa per a qualificar') ||
    s.includes('tramesa realitzada') ||
    s.includes('s\'ha trames per a qualificar') ||
    s.includes('lliurat') ||
    s.includes('submitted') ||
    s.includes('calificado') ||
    s.includes('qualificat') ||
    s.includes('graded');

  return (
    submitted ||
    Boolean(task.submittedWorkText && task.submittedWorkText.length > 20) ||
    task.attachments.some((a) => a.sourceType === 'student_submission')
  );
}

export function isTaskActionable(task: TaskRecord): boolean {
  return !isTaskNoSubmission(task) && !isTaskSubmittedInAules(task);
}

export function needsExtraCourseContext(task: TaskRecord): boolean {
  const descLen = (task.descriptionText || '').trim().length;
  const hasAttText = task.attachments.some(
    (a) => a.sourceType !== 'student_submission' && (a.extractedText || '').trim().length > 180
  );
  if (descLen < 550 || !hasAttText) return true;
  return /\b(ud\s*\d|tema\s*\d|unidad|apuntes|manual|guia|guía|enunciado|adjunto|pr[aá]ctica)\b/i.test(
    `${task.title} ${task.descriptionText}`
  );
}

interface TextChunk {
  docName: string;
  text: string;
  tokens: string[];
  titleTokens: string[];
}

function splitIntoChunks(docName: string, text: string, chunkSize = 580): TextChunk[] {
  const clean = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!clean) return [];

  const titleTokens = tokenize(docName);
  const paragraphs = clean.split(/\n{2,}/);
  const chunks: TextChunk[] = [];
  let buffer = '';

  const pushBuffer = (val: string) => {
    const trimmed = val.trim();
    if (trimmed.length < 40) return;
    chunks.push({
      docName,
      text: trimmed.slice(0, chunkSize + 120),
      tokens: tokenize(trimmed),
      titleTokens,
    });
  };

  for (const para of paragraphs) {
    if ((buffer + '\n\n' + para).length > chunkSize) {
      if (buffer) pushBuffer(buffer);
      if (para.length > chunkSize) {
        for (let i = 0; i < para.length; i += chunkSize) {
          pushBuffer(para.slice(i, i + chunkSize));
        }
        buffer = '';
      } else {
        buffer = para;
      }
    } else {
      buffer = buffer ? `${buffer}\n\n${para}` : para;
    }
  }
  if (buffer) pushBuffer(buffer);
  return chunks;
}

export function selectRelevantCourseChunks(
  task: TaskRecord,
  courseDocs: AttachmentRecord[],
  maxTotalChars = 1900
): { contextDigest: string; sourceNames: string[] } {
  const usableDocs = courseDocs.filter((d) => (d.extractedText || '').trim().length > 40);
  if (usableDocs.length === 0) {
    return { contextDigest: '', sourceNames: [] };
  }

  const queryTerms = Array.from(
    new Set([
      ...tokenize(task.title),
      ...tokenize(task.descriptionText),
      ...task.attachments.flatMap((a) => tokenize(a.name)),
    ])
  );

  const allChunks: TextChunk[] = [];
  for (const doc of usableDocs) {
    allChunks.push(...splitIntoChunks(doc.name, doc.extractedText));
  }

  if (allChunks.length === 0) {
    return { contextDigest: '', sourceNames: [] };
  }

  // Simple IDF weighting across chunks
  const df = new Map<string, number>();
  for (const ch of allChunks) {
    const seen = new Set(ch.tokens);
    for (const t of seen) {
      df.set(t, (df.get(t) || 0) + 1);
    }
  }

  const totalDocs = allChunks.length;
  const scored = allChunks.map((ch) => {
    const tf = new Map<string, number>();
    for (const t of ch.tokens) tf.set(t, (tf.get(t) || 0) + 1);
    const titleSet = new Set(ch.titleTokens);

    let score = 0;
    for (const q of queryTerms) {
      const count = tf.get(q) || 0;
      if (count > 0) {
        const idf = Math.log(1 + totalDocs / (1 + (df.get(q) || 1)));
        score += Math.min(3, count) * idf;
      }
      if (titleSet.has(q)) {
        score += 2.2;
      }
    }
    return { chunk: ch, score };
  });

  scored.sort((a, b) => b.score - a.score);

  const selected: TextChunk[] = [];
  const docHits = new Map<string, number>();
  let usedChars = 0;

  for (const item of scored) {
    if (selected.length >= 4) break;
    const perDoc = docHits.get(item.chunk.docName) || 0;
    if (perDoc >= 2) continue;
    const entryLen = item.chunk.docName.length + item.chunk.text.length + 24;
    if (usedChars + entryLen > maxTotalChars && selected.length > 0) continue;

    selected.push(item.chunk);
    docHits.set(item.chunk.docName, perDoc + 1);
    usedChars += entryLen;
  }

  if (selected.length === 0) {
    const first = usableDocs[0];
    return {
      contextDigest: `[${first.name}]: ${first.extractedText.slice(0, Math.min(800, maxTotalChars))}`,
      sourceNames: [first.name],
    };
  }

  const sourceNames = Array.from(new Set(selected.map((c) => c.docName)));
  const contextDigest = selected
    .map((c) => `[${c.docName}]:\n${c.text}`)
    .join('\n\n');

  return { contextDigest: contextDigest.slice(0, maxTotalChars), sourceNames };
}

export function inferPreferredFormatsLocally(
  tasks: TaskRecord[],
  existing?: string[]
): string[] {
  const counts = new Map<string, number>();
  for (const t of tasks) {
    for (const a of t.attachments) {
      if (a.sourceType === 'student_submission') {
        const lower = a.name.toLowerCase();
        if (lower.endsWith('.pdf')) counts.set('pdf', (counts.get('pdf') || 0) + 2);
        else if (lower.endsWith('.docx') || lower.endsWith('.doc')) {
          counts.set('docx', (counts.get('docx') || 0) + 2);
        } else if (lower.endsWith('.html') || lower.endsWith('.htm')) {
          counts.set('html', (counts.get('html') || 0) + 2);
        }
      }
    }
    const prompt = `${t.title} ${t.descriptionText}`.toLowerCase();
    if (/\b(html|css|web)\b/.test(prompt)) counts.set('html', (counts.get('html') || 0) + 1);
    if (/\b(word|docx)\b/.test(prompt)) counts.set('docx', (counts.get('docx') || 0) + 1);
    if (/\bpdf\b/.test(prompt)) counts.set('pdf', (counts.get('pdf') || 0) + 1);
  }
  const ranked = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([fmt]) => fmt);
  if (ranked.length > 0) return ranked;
  return existing && existing.length > 0 ? existing : ['pdf'];
}

export function buildLocalSubjectKnowledge(
  courseId: string,
  courseName: string,
  existing: SubjectKnowledge | undefined,
  tasks: TaskRecord[],
  courseDocs: AttachmentRecord[]
): SubjectKnowledge {
  const preferredFormats = inferPreferredFormatsLocally(tasks, existing?.studentPreferredFormats);
  const submittedTasks = tasks.filter((t) => isTaskSubmittedInAules(t));
  const studentFiles = submittedTasks.flatMap((t) =>
    t.attachments.filter((a) => a.sourceType === 'student_submission')
  );

  const conceptFreq = new Map<string, number>();
  for (const t of tasks) {
    for (const tok of tokenize(t.title)) {
      conceptFreq.set(tok, (conceptFreq.get(tok) || 0) + 2);
    }
  }
  for (const d of courseDocs) {
    for (const tok of tokenize(d.name)) {
      conceptFreq.set(tok, (conceptFreq.get(tok) || 0) + 2);
    }
  }
  const topConcepts = Array.from(conceptFreq.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([word]) => word.toUpperCase());

  const criteriaSet = new Set<string>(existing?.evaluationCriteria || []);
  for (const t of tasks) {
    const sentences = (t.descriptionText || '').split(/[.!\n]+/);
    for (const s of sentences) {
      const clean = s.trim();
      if (
        clean.length >= 18 &&
        clean.length <= 180 &&
        /\b(rubrica|rúbrica|criterio|obligatori|debe|formato|puntu|valorar|entrega|pdf|docx|html)\b/i.test(
          clean
        )
      ) {
        criteriaSet.add(clean);
      }
      if (criteriaSet.size >= 8) break;
    }
  }

  const submittedStyleFallback =
    studentFiles.length > 0
      ? `En ${courseName} sueles entregar en ${preferredFormats
          .map((f) => f.toUpperCase())
          .join('/')} (ejemplos analizados: ${studentFiles
          .slice(0, 4)
          .map((f) => f.name)
          .join(', ')}).`
      : existing?.studentWorkStyle ||
        `Formato recomendado por los enunciados: ${preferredFormats
          .map((f) => f.toUpperCase())
          .join(', ')}.`;

  const mergedTaskIds = Array.from(
    new Set([...(existing?.learnedTaskIds || []), ...tasks.map((t) => t.id)])
  );

  const actionableCount = tasks.filter((t) => isTaskActionable(t)).length;
  const summary =
    existing?.summary && existing.summary.length > 40
      ? existing.summary
      : `${courseName}: ${tasks.length} actividades detectadas (${submittedTasks.length} entregas previas de referencia, ${actionableCount} pendientes de entrega) y ${courseDocs.length} recursos de apoyo indexados.`;

  return {
    courseId,
    courseName,
    summary,
    studentWorkStyle:
      existing?.studentWorkStyle && !existing.studentWorkStyle.startsWith('Aún no se han detectado')
        ? existing.studentWorkStyle
        : submittedStyleFallback,
    studentPreferredFormats: preferredFormats,
    keyConcepts:
      existing?.keyConcepts && existing.keyConcepts.length > 0 ? existing.keyConcepts : topConcepts,
    evaluationCriteria: Array.from(criteriaSet).slice(0, 8),
    studyTips:
      existing?.studyTips && existing.studyTips.length > 0
        ? existing.studyTips
        : [
            `Revisar los ${courseDocs.length} documentos indexados del curso antes de entregar.`,
            `Utilizar el formato habitual (${preferredFormats[0]?.toUpperCase() || 'PDF'}) salvo que el enunciado exija otro.`,
          ],
    glossary: existing?.glossary || [],
    learnedTaskIds: mergedTaskIds,
    updatedAt: new Date().toISOString(),
    driveFileId: existing?.driveFileId,
    driveWebViewLink: existing?.driveWebViewLink,
  };
}

export function buildLocalRequirementAnalysis(
  task: TaskRecord,
  contextSources: string[],
  recommendedFormat: string
): string {
  const attList = task.attachments
    .filter((a) => a.sourceType !== 'student_submission')
    .map((a) => `- ${a.name} (${a.sourceType === 'user_attachment' ? 'Adjuntado por ti' : 'Aules'})`)
    .join('\n');

  const ctxList = contextSources.length > 0 ? contextSources.map((s) => `- ${s}`).join('\n') : '- Enunciado directo';

  return `# Análisis de Requisitos — ${task.title}

- **Asignatura**: ${task.courseName}
- **Estado en Aules**: ${task.submissionStatus}
- **Fecha límite**: ${task.dueDate || 'No especificada'}
- **Formato óptimo detectado**: ${recommendedFormat.toUpperCase()}

## Enunciado
${task.descriptionText}

## Adjuntos de la Tarea
${attList || '- Sin adjuntos en la tarea'}

## Contexto del Curso Utilizado
${ctxList}
`;
}
