import {
  buildLocalRequirementAnalysis,
  buildLocalSubjectKnowledge,
  selectRelevantCourseChunks,
} from './contextEngine.ts';
import type { AttachmentRecord, SubjectKnowledge, TaskDeliverables, TaskRecord } from './types.ts';

const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';
export const DEFAULT_GROQ_MODEL = 'llama-3.3-70b-versatile';

export interface AiModelInfo {
  id: string;
  name: string;
  contextLength?: number;
}

interface ModelBudget {
  tpmLimit: number;
  maxInputChars: number;
  maxOutputTokens: number;
}

const MODEL_BUDGETS: Record<string, ModelBudget> = {
  'llama-3.3-70b-versatile': {
    tpmLimit: 12000,
    maxInputChars: 14000,
    maxOutputTokens: 2500,
  },
  'openai/gpt-oss-120b': {
    tpmLimit: 8000,
    maxInputChars: 9600,
    maxOutputTokens: 2000,
  },
  'openai/gpt-oss-20b': {
    tpmLimit: 8000,
    maxInputChars: 9600,
    maxOutputTokens: 2000,
  },
  'llama-3.1-8b-instant': {
    tpmLimit: 6000,
    maxInputChars: 7500,
    maxOutputTokens: 1600,
  },
};

const FALLBACK_CHAIN = [
  'llama-3.3-70b-versatile',
  'openai/gpt-oss-20b',
  'llama-3.1-8b-instant',
];

const FALLBACK_GROQ_MODELS: AiModelInfo[] = [
  {
    id: 'llama-3.3-70b-versatile',
    name: 'Llama 3.3 70B Versatile (Recomendado · 12K TPM)',
    contextLength: 131072,
  },
  {
    id: 'openai/gpt-oss-120b',
    name: 'GPT-OSS 120B (Razonamiento · 8K TPM)',
    contextLength: 131072,
  },
  {
    id: 'openai/gpt-oss-20b',
    name: 'GPT-OSS 20B (Rápido y eficiente · 8K TPM)',
    contextLength: 131072,
  },
  {
    id: 'llama-3.1-8b-instant',
    name: 'Llama 3.1 8B Instant (Ultra rápido · 6K TPM)',
    contextLength: 131072,
  },
];

function getModelBudget(model: string): ModelBudget {
  return (
    MODEL_BUDGETS[model] || {
      tpmLimit: 8000,
      maxInputChars: 9600,
      maxOutputTokens: 2000,
    }
  );
}

function resolveRawGroqKey(): string {
  return (process.env.GROQ_API_KEY || '').trim();
}

export function isGroqConfigured(): boolean {
  return resolveRawGroqKey().length > 8;
}

function getGroqKey(): string {
  const key = resolveRawGroqKey();
  if (!key) {
    throw new Error(
      'Falta configurar GROQ_API_KEY en los secretos del entorno del servidor.'
    );
  }
  return key;
}

export function normalizeGroqModel(model?: string): string {
  const trimmed = (model || '').trim();
  if (
    !trimmed ||
    trimmed.toLowerCase().startsWith('grok') ||
    trimmed.startsWith('openrouter/') ||
    trimmed.includes(':free')
  ) {
    return DEFAULT_GROQ_MODEL;
  }
  return trimmed;
}

function formatGroqModelLabel(id: string): string {
  const match = FALLBACK_GROQ_MODELS.find((m) => m.id === id);
  if (match) return match.name;
  return id;
}

export async function listGroqModels(): Promise<AiModelInfo[]> {
  if (!isGroqConfigured()) {
    return FALLBACK_GROQ_MODELS;
  }

  try {
    const res = await fetch(`${GROQ_BASE_URL}/models`, {
      headers: {
        Authorization: `Bearer ${getGroqKey()}`,
      },
    });
    if (!res.ok) return FALLBACK_GROQ_MODELS;

    const json = (await res.json()) as {
      data?: Array<{
        id: string;
        active?: boolean;
        context_window?: number;
      }>;
    };

    if (!Array.isArray(json.data) || json.data.length === 0) {
      return FALLBACK_GROQ_MODELS;
    }

    const chatModels: AiModelInfo[] = json.data
      .filter(
        (m) =>
          typeof m.id === 'string' &&
          m.active !== false &&
          !/whisper|orpheus|tts|guard|safeguard|moderation|embed|compound-audio/i.test(m.id)
      )
      .map((m) => ({
        id: m.id,
        name: formatGroqModelLabel(m.id),
        contextLength: typeof m.context_window === 'number' ? m.context_window : undefined,
      }));

    if (chatModels.length === 0) {
      return FALLBACK_GROQ_MODELS;
    }

    const seen = new Set(chatModels.map((m) => m.id));
    for (const fallback of [...FALLBACK_GROQ_MODELS].reverse()) {
      if (!seen.has(fallback.id)) {
        chatModels.unshift(fallback);
      }
    }

    const priorityIds = FALLBACK_GROQ_MODELS.map((m) => m.id);
    chatModels.sort((a, b) => {
      const idxA = priorityIds.indexOf(a.id);
      const idxB = priorityIds.indexOf(b.id);
      if (idxA >= 0 && idxB >= 0) return idxA - idxB;
      if (idxA >= 0) return -1;
      if (idxB >= 0) return 1;
      return a.id.localeCompare(b.id);
    });

    return chatModels;
  } catch {
    return FALLBACK_GROQ_MODELS;
  }
}

function stripReasoningTags(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.2);
}

function parseDurationMs(raw: string | null | undefined): number {
  if (!raw) return 0;
  let totalMs = 0;
  const minMatch = raw.match(/(\d+(?:\.\d+)?)m(?!s)/i);
  const secMatch = raw.match(/(\d+(?:\.\d+)?)s/i);
  const msMatch = raw.match(/(\d+(?:\.\d+)?)ms/i);
  if (minMatch) totalMs += Number(minMatch[1]) * 60_000;
  if (secMatch) totalMs += Number(secMatch[1]) * 1000;
  if (msMatch) totalMs += Number(msMatch[1]);
  return Math.round(totalMs);
}

// Global sequential queue + per-model TPM sliding window / header state
let groqQueueTail: Promise<unknown> = Promise.resolve();

interface ModelRateState {
  remainingTokens?: number;
  resetAtMs?: number;
  history: Array<{ at: number; tokens: number }>;
}

const modelRateState = new Map<string, ModelRateState>();

function getRateState(model: string): ModelRateState {
  let s = modelRateState.get(model);
  if (!s) {
    s = { history: [] };
    modelRateState.set(model, s);
  }
  const cutoff = Date.now() - 62_000;
  s.history = s.history.filter((h) => h.at >= cutoff);
  return s;
}

function enqueueGroqTask<T>(fn: () => Promise<T>): Promise<T> {
  const next = groqQueueTail.then(fn, fn);
  groqQueueTail = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

async function waitIfNeededForBudget(
  model: string,
  neededTokens: number,
  onWait?: (waitSec: number, model: string) => void
): Promise<void> {
  const state = getRateState(model);
  const budget = getModelBudget(model);
  const now = Date.now();

  if (
    typeof state.remainingTokens === 'number' &&
    typeof state.resetAtMs === 'number' &&
    state.resetAtMs > now &&
    state.remainingTokens < neededTokens
  ) {
    const waitMs = Math.min(62_000, state.resetAtMs - now + 350);
    if (waitMs > 400) {
      onWait?.(Math.ceil(waitMs / 1000), model);
      await new Promise((r) => setTimeout(r, waitMs));
    }
    return;
  }

  const usedLastMinute = state.history.reduce((sum, h) => sum + h.tokens, 0);
  if (usedLastMinute + neededTokens > budget.tpmLimit * 0.9 && state.history.length > 0) {
    const oldestAt = state.history[0].at;
    const waitMs = Math.min(62_000, Math.max(1200, oldestAt + 61_000 - now));
    onWait?.(Math.ceil(waitMs / 1000), model);
    await new Promise((r) => setTimeout(r, waitMs));
  }
}

function recordHeaderAndUsage(model: string, headers: Headers, fallbackTokens: number): void {
  const state = getRateState(model);
  const remHeader = headers.get('x-ratelimit-remaining-tokens');
  const resetHeader = headers.get('x-ratelimit-reset-tokens');

  if (remHeader !== null && !Number.isNaN(Number(remHeader))) {
    state.remainingTokens = Number(remHeader);
  }
  const resetMs = parseDurationMs(resetHeader);
  if (resetMs > 0) {
    state.resetAtMs = Date.now() + resetMs;
  }
  state.history.push({ at: Date.now(), tokens: fallbackTokens });
}

async function callGroqRaw(
  model: string,
  systemPrompt: string,
  userPrompt: string,
  options: {
    useJsonFormat?: boolean;
    maxTokens?: number;
    onWait?: (waitSec: number, activeModel: string) => void;
  } = {}
): Promise<{ text: string; modelUsed: string }> {
  return enqueueGroqTask(async () => {
    const apiKey = getGroqKey();
    const initialModel = normalizeGroqModel(model);
    const candidateModels = Array.from(new Set([initialModel, ...FALLBACK_CHAIN]));

    let allowJsonFormat = Boolean(options.useJsonFormat);
    let activeUserPrompt = userPrompt;

    for (const activeModel of candidateModels) {
      const budget = getModelBudget(activeModel);
      const safeMaxInputChars = Math.max(3000, budget.maxInputChars - systemPrompt.length);
      if (activeUserPrompt.length > safeMaxInputChars) {
        activeUserPrompt = `${activeUserPrompt.slice(0, safeMaxInputChars - 30)}\n[...compactado...]`;
      }

      const requestedOutput = Math.min(
        options.maxTokens ?? budget.maxOutputTokens,
        budget.maxOutputTokens
      );
      const inputTokensEst = estimateTokens(systemPrompt + activeUserPrompt);
      // Keep input + max_tokens strictly under 92% of model TPM limit to prevent HTTP 413
      const safeMaxTokens = Math.max(
        700,
        Math.min(requestedOutput, Math.floor(budget.tpmLimit * 0.92) - inputTokensEst)
      );

      for (let attempt = 0; attempt < 3; attempt++) {
        await waitIfNeededForBudget(activeModel, inputTokensEst + safeMaxTokens, options.onWait);

        const bodyPayload: Record<string, unknown> = {
          model: activeModel,
          temperature: 0.22,
          max_tokens: safeMaxTokens,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: activeUserPrompt },
          ],
        };
        if (allowJsonFormat) {
          bodyPayload.response_format = { type: 'json_object' };
        }

        const res = await fetch(`${GROQ_BASE_URL}/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(bodyPayload),
        });

        recordHeaderAndUsage(activeModel, res.headers, inputTokensEst + safeMaxTokens);

        if (res.status === 400 && allowJsonFormat) {
          allowJsonFormat = false;
          continue;
        }

        if (res.status === 413) {
          // Request exceeded TPM limit on this model: shrink prompt aggressively and try next model
          activeUserPrompt = activeUserPrompt.slice(0, Math.floor(activeUserPrompt.length * 0.65));
          break;
        }

        if (res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504) {
          const errPreview = await res.text().catch(() => '');
          const headerWait = parseDurationMs(res.headers.get('x-ratelimit-reset-tokens'));
          const retryAfter = Number(res.headers.get('retry-after') || '0') * 1000;
          const bodyMatch = errPreview.match(/try again in\s+([0-9hms.]+)/i);
          const bodyWait = parseDurationMs(bodyMatch?.[1]);

          const waitMs = Math.max(retryAfter, headerWait, bodyWait, 2000 * Math.pow(2, attempt));
          if (waitMs > 28_000) {
            // Daily/long limit on this model -> switch to fallback model immediately
            break;
          }
          options.onWait?.(Math.ceil(waitMs / 1000), activeModel);
          await new Promise((r) => setTimeout(r, waitMs + 300));
          continue;
        }

        if (!res.ok) {
          const errText = await res.text();
          if (attempt === 0 && candidateModels.length > 1) break;
          throw new Error(`Error en Groq API (HTTP ${res.status}): ${errText.slice(0, 220)}`);
        }

        const data = (await res.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
          usage?: { total_tokens?: number };
          error?: { message?: string };
        };

        if (data.usage?.total_tokens) {
          const state = getRateState(activeModel);
          if (state.history.length > 0) {
            state.history[state.history.length - 1].tokens = data.usage.total_tokens;
          }
        }

        if (data.error?.message) {
          throw new Error(`Groq API: ${data.error.message}`);
        }

        const rawContent = data.choices?.[0]?.message?.content;
        if (!rawContent || !rawContent.trim()) {
          if (attempt < 1) {
            await new Promise((r) => setTimeout(r, 1000));
            continue;
          }
          break;
        }

        return { text: stripReasoningTags(rawContent), modelUsed: activeModel };
      }
    }

    throw new Error(
      'Groq API alcanzó temporalmente los límites de cuota en los modelos disponibles. Espera unos segundos y reintenta.'
    );
  });
}

function tryParseJsonObject<T>(raw: string): T | null {
  const cleaned = raw
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  try {
    return JSON.parse(cleaned) as T;
  } catch {
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      try {
        return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1)) as T;
      } catch {
        return null;
      }
    }
    return null;
  }
}

export interface StudentReferenceExample {
  taskTitle: string;
  submissionSummary: string;
  fileNames: string[];
}

export async function learnFromCourseMaterials(
  model: string,
  courseId: string,
  courseName: string,
  existingKnowledge: SubjectKnowledge | undefined,
  tasks: TaskRecord[],
  courseDocs: AttachmentRecord[],
  onWait?: (waitSec: number, activeModel: string) => void
): Promise<SubjectKnowledge> {
  // Always build crisp baseline knowledge locally (0 AI requests)
  const localKb = buildLocalSubjectKnowledge(
    courseId,
    courseName,
    existingKnowledge,
    tasks,
    courseDocs
  );

  const submittedTasks = tasks.filter((t) => t.isSubmittedInAules);
  const hasRichSubmissions = submittedTasks.some(
    (t) =>
      Boolean(t.submittedWorkText && t.submittedWorkText.length > 40) ||
      t.attachments.some((a) => a.sourceType === 'student_submission' && a.extractedText.length > 60)
  );
  const alreadyAnalyzedStyle =
    Boolean(existingKnowledge?.studentWorkStyle) &&
    !existingKnowledge!.studentWorkStyle!.startsWith('Aún no se han detectado') &&
    submittedTasks.every((t) => existingKnowledge?.learnedTaskIds.includes(t.id));

  // Skip Groq call in Stage 4 unless there are new submitted student works to extract style from!
  if (!hasRichSubmissions || alreadyAnalyzedStyle) {
    return localKb;
  }

  const studentWorkDigest = submittedTasks
    .slice(0, 3)
    .map((t) => {
      const subFiles = t.attachments
        .filter((a) => a.sourceType === 'student_submission')
        .map((a) => `${a.name}: ${(a.extractedText || '').slice(0, 750)}`)
        .join('\n');
      const online = t.submittedWorkText ? `Texto: ${t.submittedWorkText.slice(0, 650)}` : '';
      return `### ${t.title}\n${online}\n${subFiles}`;
    })
    .join('\n\n')
    .slice(0, 2800);

  const systemPrompt = `Analiza brevemente el estilo real de trabajo de un estudiante en "${courseName}" y responde SOLO JSON válido:
{"summary":"resumen conciso","studentWorkStyle":"tono, estructura, nivel técnico y presentación","studentPreferredFormats":["pdf","docx","html"],"keyConcepts":["..."],"evaluationCriteria":["..."]}`;

  const userPrompt = `Entregas reales del alumno:\n${studentWorkDigest}\n\nConceptos locales: ${localKb.keyConcepts.join(', ')}`;

  try {
    const { text: raw } = await callGroqRaw(model, systemPrompt, userPrompt, {
      useJsonFormat: true,
      maxTokens: 900,
      onWait,
    });
    const parsed = tryParseJsonObject<{
      summary?: string;
      studentWorkStyle?: string;
      studentPreferredFormats?: string[];
      keyConcepts?: string[];
      evaluationCriteria?: string[];
    }>(raw);

    return {
      ...localKb,
      summary: parsed?.summary || localKb.summary,
      studentWorkStyle: parsed?.studentWorkStyle || localKb.studentWorkStyle,
      studentPreferredFormats:
        Array.isArray(parsed?.studentPreferredFormats) && parsed.studentPreferredFormats.length > 0
          ? parsed.studentPreferredFormats.map((f) => String(f).toLowerCase())
          : localKb.studentPreferredFormats,
      keyConcepts:
        Array.isArray(parsed?.keyConcepts) && parsed.keyConcepts.length > 0
          ? parsed.keyConcepts
          : localKb.keyConcepts,
      evaluationCriteria:
        Array.isArray(parsed?.evaluationCriteria) && parsed.evaluationCriteria.length > 0
          ? parsed.evaluationCriteria
          : localKb.evaluationCriteria,
      updatedAt: new Date().toISOString(),
    };
  } catch {
    // Non-fatal: fall back cleanly to zero-AI local knowledge
    return localKb;
  }
}

function extractSection(text: string, marker: string, nextMarkers: string[]): string {
  const startIdx = text.indexOf(marker);
  if (startIdx < 0) return '';
  const contentStart = startIdx + marker.length;
  let endIdx = text.length;
  for (const next of nextMarkers) {
    const idx = text.indexOf(next, contentStart);
    if (idx >= 0 && idx < endIdx) {
      endIdx = idx;
    }
  }
  return text.slice(contentStart, endIdx).trim();
}

function normalizeOutputFormat(
  rawFormat: string,
  task: TaskRecord,
  preferredFormats?: string[]
): 'html' | 'pdf' | 'docx' | 'md' {
  const clean = rawFormat.trim().toLowerCase();
  if (clean.includes('html')) return 'html';
  if (clean.includes('docx') || clean.includes('word')) return 'docx';
  if (clean.includes('pdf')) return 'pdf';
  if (clean.includes('md') || clean.includes('markdown')) return 'md';

  const promptText = `${task.title} ${task.descriptionText}`.toLowerCase();
  if (/\b(html|página web|web|css|etiquetas|formulario)\b/.test(promptText)) return 'html';
  if (/\b(docx|word|\.doc)\b/.test(promptText)) return 'docx';
  if (/\bpdf\b/.test(promptText)) return 'pdf';

  const firstPref = preferredFormats?.[0]?.toLowerCase();
  if (firstPref === 'html' || firstPref === 'pdf' || firstPref === 'docx' || firstPref === 'md') {
    return firstPref;
  }
  return 'pdf';
}

export async function solveAndAnalyzeTask(
  model: string,
  task: TaskRecord,
  knowledge: SubjectKnowledge | undefined,
  courseDocs: AttachmentRecord[],
  referenceExamples: StudentReferenceExample[] = [],
  onWait?: (waitSec: number, activeModel: string) => void
): Promise<TaskDeliverables> {
  const safeModel = normalizeGroqModel(model);

  const userAttachmentsDigest = task.attachments
    .filter((a) => a.sourceType === 'user_attachment' && a.extractedText.trim().length > 0)
    .map((a) => `[Adjunto alumno ${a.name}]:\n${a.extractedText.slice(0, 1800)}`)
    .join('\n\n')
    .slice(0, 2400);

  const taskAttachmentsDigest = task.attachments
    .filter(
      (a) =>
        a.sourceType !== 'user_attachment' &&
        a.sourceType !== 'student_submission' &&
        a.extractedText.trim().length > 0
    )
    .map((a) => `[Adjunto Aules ${a.name}]:\n${a.extractedText.slice(0, 1400)}`)
    .join('\n\n')
    .slice(0, 2200);

  // Use BM25-style local matcher to select ONLY the most relevant course material chunks!
  const { contextDigest, sourceNames } = selectRelevantCourseChunks(task, courseDocs, 1800);

  const styleExamplesDigest = referenceExamples
    .slice(0, 1)
    .map(
      (ex) =>
        `Ejemplo (${ex.taskTitle} · ${ex.fileNames.join(', ') || 'texto'}): ${ex.submissionSummary.slice(0, 800)}`
    )
    .join('\n');

  const styleLine = knowledge?.studentWorkStyle
    ? `${knowledge.studentWorkStyle.slice(0, 320)} | Formatos: ${(knowledge.studentPreferredFormats || ['pdf']).join(', ')}`
    : 'Claro, estructurado, directo y técnico.';

  const systemPrompt = `Resuelve COMPLETAMENTE una tarea pendiente de Aules adaptándote al estilo real del estudiante.
Responde en español usando exactamente estas etiquetas:

<<<FORMATO>>>
(html, pdf o docx según pida web, Word o informe estándar)

<<<APUNTES>>>
(Resumen breve de conceptos clave para defender la entrega)

<<<DEBERES>>>
(Resolución COMPLETA lista para entregar de todos los ejercicios/apartados pedidos)

<<<HTML_ENTREGABLE>>>
(SOLO si <<<FORMATO>>> es html, documento <!doctype html> completo)`;

  const userPrompt = `Asignatura: ${task.courseName}
Tarea: ${task.title}${task.dueDate ? ` | Entrega: ${task.dueDate}` : ''}
Estilo alumno: ${styleLine}
${styleExamplesDigest ? `\n${styleExamplesDigest}` : ''}

Enunciado:
${task.descriptionText.slice(0, 2000)}
${userAttachmentsDigest ? `\nArchivos del alumno:\n${userAttachmentsDigest}` : ''}
${taskAttachmentsDigest ? `\nAdjuntos enunciado:\n${taskAttachmentsDigest}` : ''}
${contextDigest ? `\nFragmentos relevantes del temario:\n${contextDigest}` : ''}`;

  const { text: raw, modelUsed } = await callGroqRaw(safeModel, systemPrompt, userPrompt, {
    useJsonFormat: false,
    maxTokens: 2400,
    onWait,
  });

  const rawFormat = extractSection(raw, '<<<FORMATO>>>', [
    '<<<APUNTES>>>',
    '<<<DEBERES>>>',
    '<<<HTML_ENTREGABLE>>>',
  ]);
  let notes = extractSection(raw, '<<<APUNTES>>>', ['<<<DEBERES>>>', '<<<HTML_ENTREGABLE>>>']);
  let homework = extractSection(raw, '<<<DEBERES>>>', ['<<<HTML_ENTREGABLE>>>']);
  const deliverableHtml = extractSection(raw, '<<<HTML_ENTREGABLE>>>', [])
    .replace(/^```html\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  if (!homework && raw.trim().length > 60) {
    homework = raw
      .replace(/<<<FORMATO>>>[\s\S]*?(?=<<<|$)/, '')
      .replace(/<<<APUNTES>>>[\s\S]*?(?=<<<|$)/, '')
      .trim();
  }

  const outputFormat = normalizeOutputFormat(
    rawFormat,
    task,
    knowledge?.studentPreferredFormats
  );

  // Requirement analysis is generated locally at 0 AI requests
  const analysis = buildLocalRequirementAnalysis(task, sourceNames, outputFormat);

  if (!notes) {
    notes = `# Apuntes de Estudio — ${task.title}\n\n${knowledge?.summary || ''}\n\n${
      contextDigest ? `## Fragmentos de apoyo utilizados\n${contextDigest}` : ''
    }`;
  }

  return {
    requirementAnalysisMd: analysis,
    studyNotesMd: notes,
    homeworkSolutionMd: homework || raw.trim(),
    outputFormat,
    deliverableHtml: deliverableHtml.length > 80 ? deliverableHtml : undefined,
    contextSourcesUsed: sourceNames,
    generatedAt: new Date().toISOString(),
    modelUsed,
  };
}
