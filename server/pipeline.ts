import crypto from 'node:crypto';
import {
  discoverCourseResourcesForCourse,
  discoverCoursesAndTasks,
  downloadAndExtractAttachment,
} from './aulesClient.ts';
import {
  isTaskActionable,
  isTaskNoSubmission,
  isTaskSubmittedInAules,
} from './contextEngine.ts';
import { buildDeliverableFile } from './documentBuilder.ts';
import { ensureDriveFolder, syncFileSafely } from './driveSync.ts';
import {
  learnFromCourseMaterials,
  normalizeGroqModel,
  solveAndAnalyzeTask,
  type StudentReferenceExample,
} from './groqClient.ts';
import { sanitizeFileName } from './security.ts';
import {
  clearRunDriveToken,
  getOrRestoreAulesSession,
  getRun,
  getRunDriveToken,
  getRunEmitter,
  isRunCancelled,
  readAttachmentCache,
  readUserStore,
  registerRun,
  saveAttachmentCache,
  writeUserStore,
} from './store.ts';
import type {
  AttachmentRecord,
  PipelineLogEntry,
  PipelineRun,
  PipelineStageIndex,
  PipelineStageState,
  SubjectKnowledge,
  TaskRecord,
} from './types.ts';

export { isTaskSubmittedInAules };

function buildInitialStages(): PipelineStageState[] {
  return [
    {
      index: 1,
      title: 'Autenticación en Aules',
      description: 'Validando sesión activa o tareas ya guardadas en el estudio.',
      status: 'pending',
      completedItems: 0,
      totalItems: 1,
    },
    {
      index: 2,
      title: 'Detección de Cursos y Tareas',
      description: 'Escaneando asignaturas, entregas reales y avisos sin entrega en línea.',
      status: 'pending',
      completedItems: 0,
      totalItems: 1,
    },
    {
      index: 3,
      title: 'Descarga e Indexación Local',
      description: 'Descargando adjuntos y recursos de asignatura para contexto bajo demanda.',
      status: 'pending',
      completedItems: 0,
      totalItems: 0,
    },
    {
      index: 4,
      title: 'Aprendizaje Local y Estilo del Alumno',
      description: 'Indexando temario localmente y sintetizando tu estilo con entregas previas.',
      status: 'pending',
      completedItems: 0,
      totalItems: 0,
    },
    {
      index: 5,
      title: 'Resolución Secuencial de Tareas Sin Hacer',
      description: 'Resolviendo tareas pendientes en cola controlada por TPM y contexto relevante.',
      status: 'pending',
      completedItems: 0,
      totalItems: 0,
    },
    {
      index: 6,
      title: 'Sincronización Directa con Google Drive',
      description: 'Subiendo y actualizando automáticamente carpetas y entregables en Drive.',
      status: 'pending',
      completedItems: 0,
      totalItems: 0,
    },
  ];
}

function formatKnowledgeMarkdown(knowledge: SubjectKnowledge): string {
  const concepts = knowledge.keyConcepts.map((c) => `- ${c}`).join('\n');
  const criteria = knowledge.evaluationCriteria.map((c) => `- ${c}`).join('\n');
  const tips = knowledge.studyTips.map((c) => `- ${c}`).join('\n');
  const glossary = knowledge.glossary
    .map((g) => `- **${g.term}**: ${g.definition}`)
    .join('\n');

  return `# Base de Aprendizaje — ${knowledge.courseName}

Actualizado: ${knowledge.updatedAt}
Tareas integradas: ${knowledge.learnedTaskIds.length}

## Resumen del Enfoque de la Asignatura
${knowledge.summary}

## Cómo Trabaja el Estudiante en esta Asignatura
${knowledge.studentWorkStyle || 'Sin entregas previas analizadas aún.'}
Formatos habituales: ${(knowledge.studentPreferredFormats || ['pdf']).join(', ')}

## Conceptos Clave Aprendidos
${concepts || '- Sin conceptos registrados aún.'}

## Criterios de Evaluación Detectados
${criteria || '- Sin criterios específicos detectados aún.'}

## Recomendaciones de Estudio y Entrega
${tips || '- Sin recomendaciones adicionales.'}

## Glosario Técnico
${glossary || '- Sin términos registrados.'}
`;
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>
): Promise<void> {
  if (items.length === 0) return;
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const currentIndex = cursor++;
      await worker(items[currentIndex], currentIndex);
    }
  });
  await Promise.all(runners);
}

export function getCourseReferenceExamples(
  allTasks: TaskRecord[],
  courseId: string,
  excludeTaskId?: string
): StudentReferenceExample[] {
  return allTasks
    .filter((t) => t.courseId === courseId && t.id !== excludeTaskId && isTaskSubmittedInAules(t))
    .slice(0, 3)
    .map((t) => {
      const studentFiles = t.attachments.filter((a) => a.sourceType === 'student_submission');
      const filesText = studentFiles
        .map((a) => `[${a.name}]: ${(a.extractedText || '').slice(0, 700)}`)
        .join('\n');
      const combined = [t.submittedWorkText || '', filesText].filter(Boolean).join('\n').trim();
      return {
        taskTitle: t.title,
        submissionSummary:
          combined ||
          `Entrega realizada en Aules (${t.submissionStatus}) sobre: ${t.descriptionText.slice(0, 350)}`,
        fileNames: studentFiles.map((f) => f.name),
      };
    });
}

function isTaskIncomplete(task: TaskRecord): boolean {
  if (!isTaskActionable(task)) return false;
  if (!task.deliverables) return true;
  const sol = task.deliverables.homeworkSolutionMd?.trim() || '';
  if (sol.length < 100 || sol.includes('No se generó solución')) return true;
  return false;
}

const lastPersistedByRun = new Map<string, number>();

async function persistRunToStore(
  uid: string,
  email: string,
  run: PipelineRun,
  force = false
): Promise<void> {
  const now = Date.now();
  const prev = lastPersistedByRun.get(run.id) ?? 0;
  if (!force && now - prev < 2000) return;
  lastPersistedByRun.set(run.id, now);

  const store = await readUserStore(uid, email);
  const idx = store.runs.findIndex((r) => r.id === run.id);
  if (idx >= 0) {
    store.runs[idx] = run;
  } else {
    store.runs = [run, ...store.runs].slice(0, 15);
  }
  await writeUserStore(store);
}

function emitUpdate(run: PipelineRun): void {
  const emitter = getRunEmitter(run.id);
  if (emitter) {
    emitter.emit('update', run);
  }
}

function addLog(
  run: PipelineRun,
  stage: PipelineStageIndex,
  level: PipelineLogEntry['level'],
  message: string,
  detail?: string
): void {
  const entry: PipelineLogEntry = {
    id: crypto.randomBytes(6).toString('hex'),
    timestamp: new Date().toISOString(),
    stage,
    level,
    message,
    detail,
  };
  run.logs = [...run.logs.slice(-149), entry];
  emitUpdate(run);
}

function setStageStatus(
  run: PipelineRun,
  stageIdx: PipelineStageIndex,
  patch: Partial<PipelineStageState>
): void {
  run.currentStage = stageIdx;
  run.stages = run.stages.map((s) => (s.index === stageIdx ? { ...s, ...patch } : s));
  const totalWeight = run.stages.length;
  let score = 0;
  for (const st of run.stages) {
    if (st.status === 'completed') score += 1;
    else if (st.status === 'active' || st.status === 'paused') {
      const frac = st.totalItems > 0 ? st.completedItems / st.totalItems : 0.2;
      score += Math.min(0.95, Math.max(0.1, frac));
    }
  }
  run.overallProgress = Math.round((score / totalWeight) * 100);
  emitUpdate(run);
}

export interface StartPipelineOptions {
  uid: string;
  email: string;
  mode?: 'full' | 'pending_only';
  courseId?: string;
  taskId?: string;
  forceRegenerate?: boolean;
}

export function createPipelineRun(uid: string): PipelineRun {
  const run: PipelineRun = {
    id: `run_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
    uid,
    status: 'running',
    currentStage: 1,
    overallProgress: 0,
    currentItemLabel: 'Iniciando agente...',
    startedAt: new Date().toISOString(),
    stages: buildInitialStages(),
    logs: [],
    pendingConfirmations: [],
  };
  registerRun(run);
  return run;
}

const cachedRunResources = new Map<string, Record<string, AttachmentRecord[]>>();

async function syncDeliverablesToDrive(
  run: PipelineRun,
  uid: string,
  email: string,
  courseResourcesByCourse: Record<string, AttachmentRecord[]>
): Promise<void> {
  const driveToken = getRunDriveToken(run.id);
  if (!driveToken) {
    setStageStatus(run, 6, { status: 'error' });
    addLog(
      run,
      6,
      'warning',
      'Falta autorización de Google Drive para subir los archivos.',
      'Inicia sesión con Google en Conexiones y vuelve a sincronizar.'
    );
    throw new Error('Debes iniciar sesión con Google para sincronizar con Google Drive.');
  }

  const store = await readUserStore(uid, email);
  const effectiveResources =
    Object.keys(courseResourcesByCourse).length > 0
      ? courseResourcesByCourse
      : store.courseResources || {};

  const tasksToSync = store.tasks.filter((t) => isTaskActionable(t) && Boolean(t.deliverables));
  setStageStatus(run, 6, {
    status: 'active',
    completedItems: 0,
    totalItems: Math.max(1, tasksToSync.length),
  });

  run.currentItemLabel = 'Verificando carpeta raíz "Aules Sync" en Google Drive';
  addLog(
    run,
    6,
    'info',
    `Subiendo y actualizando automáticamente ${tasksToSync.length} tarea(s) en Google Drive...`
  );

  const rootFolder = await ensureDriveFolder(driveToken, 'Aules Sync');
  store.driveRootFolderId = rootFolder.id;
  store.driveRootFolderLink = rootFolder.webViewLink;
  await writeUserStore(store);

  const courseFolderCache = new Map<string, { id: string; webViewLink: string }>();
  const courseFolderPromises = new Map<string, Promise<{ id: string; webViewLink: string }>>();

  const getCourseFolder = async (courseName: string) => {
    const cached = courseFolderCache.get(courseName);
    if (cached) return cached;
    let p = courseFolderPromises.get(courseName);
    if (!p) {
      p = ensureDriveFolder(driveToken, courseName, rootFolder.id).then((res) => {
        courseFolderCache.set(courseName, res);
        return res;
      });
      courseFolderPromises.set(courseName, p);
    }
    return p;
  };

  const courseNamesById = new Map<string, string>();
  for (const c of store.courses) courseNamesById.set(c.id, c.name);

  for (const [courseId, knowledge] of Object.entries(store.knowledge)) {
    if (isRunCancelled(run.id)) return;
    const courseFolder = await getCourseFolder(knowledge.courseName);
    const kbFolder = await ensureDriveFolder(driveToken, '_Base_de_Aprendizaje', courseFolder.id);
    const kbMd = formatKnowledgeMarkdown(knowledge);

    const res = await syncFileSafely(driveToken, {
      folderId: kbFolder.id,
      fileName: 'memoria_asignatura.md',
      mimeType: 'text/markdown',
      content: Buffer.from(kbMd, 'utf-8'),
      courseId,
      courseName: knowledge.courseName,
      autoOverwrite: true,
    });

    if (res.uploaded) {
      knowledge.driveFileId = res.fileId;
      knowledge.driveWebViewLink = res.webViewLink;
    }

    const docs = effectiveResources[courseId] || [];
    if (docs.length > 0) {
      const docsFolder = await ensureDriveFolder(driveToken, '_Documentacion_Curso', courseFolder.id);
      for (const doc of docs) {
        if (!doc.localCacheKey && !doc.extractedText) continue;
        const rawBuf = doc.localCacheKey
          ? await readAttachmentCache(doc.localCacheKey)
          : Buffer.from(doc.extractedText, 'utf-8');
        if (!rawBuf) continue;

        const docSync = await syncFileSafely(driveToken, {
          folderId: docsFolder.id,
          fileName: doc.name,
          mimeType: doc.mimeType || 'application/octet-stream',
          content: rawBuf,
          courseId,
          courseName: knowledge.courseName,
          autoOverwrite: true,
        });
        if (docSync.uploaded) {
          doc.driveFileId = docSync.fileId;
          doc.driveWebViewLink = docSync.webViewLink;
        }
      }
    }
  }

  let completedTasks = 0;
  await runWithConcurrency(tasksToSync, 3, async (task) => {
    if (isRunCancelled(run.id)) return;

    run.currentItemLabel = `Subiendo a Drive: ${task.courseName} · ${task.title}`;
    emitUpdate(run);

    const courseFolder = await getCourseFolder(
      courseNamesById.get(task.courseId) || task.courseName
    );
    const taskFolder = await ensureDriveFolder(
      driveToken,
      sanitizeFileName(task.title),
      courseFolder.id
    );
    task.driveFolderId = taskFolder.id;
    task.driveFolderLink = taskFolder.webViewLink;

    const syncedFiles: NonNullable<TaskRecord['driveFiles']> = [...(task.driveFiles || [])];
    const upsertSyncedFile = (name: string, fileId: string, webViewLink: string) => {
      const idx = syncedFiles.findIndex((f) => f.name === name);
      const entry = { name, fileId, webViewLink, updatedAt: new Date().toISOString() };
      if (idx >= 0) syncedFiles[idx] = entry;
      else syncedFiles.push(entry);
    };

    for (const att of task.attachments) {
      const rawBuf = att.localCacheKey
        ? await readAttachmentCache(att.localCacheKey)
        : att.extractedText
        ? Buffer.from(att.extractedText, 'utf-8')
        : null;
      if (!rawBuf) continue;

      const attRes = await syncFileSafely(driveToken, {
        folderId: taskFolder.id,
        fileName: att.name,
        mimeType: att.mimeType || 'application/octet-stream',
        content: rawBuf,
        courseId: task.courseId,
        courseName: task.courseName,
        taskId: task.id,
        taskTitle: task.title,
        autoOverwrite: true,
      });
      if (attRes.uploaded) {
        att.driveFileId = attRes.fileId;
        att.driveWebViewLink = attRes.webViewLink;
        upsertSyncedFile(attRes.name, attRes.fileId, attRes.webViewLink);
      }
    }

    if (task.deliverables) {
      const generatedFiles: Array<{ name: string; mimeType: string; content: Buffer }> = [
        {
          name: '01_analisis_requisitos.md',
          mimeType: 'text/markdown',
          content: Buffer.from(task.deliverables.requirementAnalysisMd, 'utf-8'),
        },
        {
          name: '02_apuntes_estudio.md',
          mimeType: 'text/markdown',
          content: Buffer.from(task.deliverables.studyNotesMd, 'utf-8'),
        },
        {
          name: '03_deberes_resueltos.md',
          mimeType: 'text/markdown',
          content: Buffer.from(task.deliverables.homeworkSolutionMd, 'utf-8'),
        },
      ];

      const exportFormats = Array.from(
        new Set(
          (task.exportFormats && task.exportFormats.length > 0
            ? task.exportFormats
            : [task.deliverables.outputFormat || 'pdf']
          ).filter((fmt) => fmt !== 'md')
        )
      );

      for (const fmt of exportFormats) {
        const built = await buildDeliverableFile(fmt, task, task.deliverables);
        generatedFiles.push({
          name: built.fileName,
          mimeType: built.mimeType,
          content: built.buffer,
        });
      }

      for (const gf of generatedFiles) {
        const gfRes = await syncFileSafely(driveToken, {
          folderId: taskFolder.id,
          fileName: gf.name,
          mimeType: gf.mimeType,
          content: gf.content,
          courseId: task.courseId,
          courseName: task.courseName,
          taskId: task.id,
          taskTitle: task.title,
          autoOverwrite: true,
        });
        if (gfRes.uploaded) {
          upsertSyncedFile(gfRes.name, gfRes.fileId, gfRes.webViewLink);
        }
      }
    }

    task.driveFiles = syncedFiles;
    task.status = 'synced';
    task.updatedAt = new Date().toISOString();

    completedTasks++;
    setStageStatus(run, 6, { completedItems: completedTasks });
    addLog(
      run,
      6,
      'success',
      `Subida a Drive (${completedTasks}/${tasksToSync.length}): ${task.title}`
    );
    await persistRunToStore(uid, email, run);
  });

  await writeUserStore(store);

  run.pendingConfirmations = [];
  run.status = 'completed';
  run.finishedAt = new Date().toISOString();
  run.currentItemLabel = 'Proceso completado y sincronizado con Google Drive';
  setStageStatus(run, 6, { status: 'completed', completedItems: Math.max(1, tasksToSync.length) });
  run.overallProgress = 100;
  addLog(
    run,
    6,
    'success',
    'Todas las tareas pendientes resueltas y actualizadas automáticamente en Google Drive.'
  );
  await persistRunToStore(uid, email, run, true);
  clearRunDriveToken(run.id);
}

export async function executePipelineRun(
  run: PipelineRun,
  options: StartPipelineOptions
): Promise<void> {
  const { uid, email, mode = 'full', courseId, taskId, forceRegenerate } = options;

  try {
    const store = await readUserStore(uid, email);
    const session = await getOrRestoreAulesSession(uid);
    const useExistingTasks = mode === 'pending_only' && store.tasks.length > 0;

    // Stage 1: Verify Aules or stored tasks
    setStageStatus(run, 1, { status: 'active', completedItems: 0, totalItems: 1 });
    if (useExistingTasks) {
      run.currentItemLabel = 'Cargando tareas detectadas y recursos indexados';
      setStageStatus(run, 1, { status: 'completed', completedItems: 1 });
      addLog(
        run,
        1,
        'success',
        `Modo pendientes activo: ${store.tasks.length} tareas cargadas de ${store.courses.length} asignaturas.`
      );
    } else {
      run.currentItemLabel = 'Verificando credenciales activas de Aules';
      addLog(run, 1, 'info', 'Comprobando sesión activa en el portal Aules...');
      if (!session) {
        throw new Error('No hay una sesión activa de Aules. Conecta tus credenciales en Conexiones.');
      }
      setStageStatus(run, 1, { status: 'completed', completedItems: 1 });
      addLog(run, 1, 'success', `Sesión verificada para ${session.fullName} (${session.baseUrl})`);
    }
    if (isRunCancelled(run.id)) throw new Error('Proceso cancelado por el usuario.');

    // Stage 2: Discover courses & tasks (or normalize stored tasks & load persisted courseResources)
    let courseResourcesByCourse: Record<string, AttachmentRecord[]> = {
      ...(store.courseResources || {}),
    };

    if (useExistingTasks) {
      // Re-classify cached tasks cleanly (e.g., flag no_submission items and unblock awaiting_drive_confirm)
      store.tasks = store.tasks.map((t) => {
        if (isTaskNoSubmission(t)) {
          return {
            ...t,
            requiresOnlineSubmission: false,
            isSubmittedInAules: false,
            deliverables: undefined,
            status: 'no_submission',
          };
        }
        if (isTaskSubmittedInAules(t)) {
          return {
            ...t,
            isSubmittedInAules: true,
            requiresOnlineSubmission: true,
            status: t.status === 'synced' ? 'synced' : 'reference',
          };
        }
        if (t.status === 'awaiting_drive_confirm' && t.deliverables) {
          return { ...t, status: 'solved' };
        }
        if (t.status === 'error') {
          return { ...t, status: 'detected', errorMessage: undefined };
        }
        return t;
      });
      await writeUserStore(store);

      setStageStatus(run, 2, { status: 'completed', completedItems: 1, totalItems: 1 });
      addLog(
        run,
        2,
        'info',
        `Clasificadas ${store.tasks.filter(isTaskActionable).length} tareas accionables sin entregar.`
      );
    } else {
      setStageStatus(run, 2, { status: 'active', completedItems: 0, totalItems: 1 });
      run.currentItemLabel = 'Escaneando cursos, entregas y recursos en Aules';
      addLog(run, 2, 'info', 'Explorando asignaturas matriculadas, enunciados y recursos...');

      const discovered = await discoverCoursesAndTasks(session!, (msg) => {
        run.currentItemLabel = msg;
        emitUpdate(run);
      });

      // Merge newly discovered course resources with previously downloaded cache
      const mergedResources: Record<string, AttachmentRecord[]> = {};
      for (const [cId, newDocs] of Object.entries(discovered.courseResources)) {
        const prevDocs = store.courseResources?.[cId] || [];
        mergedResources[cId] = newDocs.map((doc) => {
          const prevDoc = prevDocs.find((p) => p.sourceUrl === doc.sourceUrl);
          return prevDoc && prevDoc.downloaded ? { ...doc, ...prevDoc } : doc;
        });
      }
      courseResourcesByCourse = mergedResources;
      store.courseResources = mergedResources;
      cachedRunResources.set(run.id, mergedResources);

      store.courses = discovered.courses;
      const existingById = new Map(store.tasks.map((t) => [t.id, t]));
      store.tasks = discovered.tasks.map((dt) => {
        const prev = existingById.get(dt.id);
        if (!prev) return dt;
        const mergedAulesAtts = dt.attachments.map((att) => {
          const prevAtt = prev.attachments.find((p) => p.sourceUrl === att.sourceUrl);
          return prevAtt && prevAtt.downloaded
            ? { ...att, ...prevAtt, sourceType: att.sourceType }
            : att;
        });
        const userAtts = prev.attachments.filter((p) => p.sourceType === 'user_attachment');
        const noSub = isTaskNoSubmission(dt);
        const submitted = isTaskSubmittedInAules(dt);
        let nextStatus = prev.status;
        if (noSub) nextStatus = 'no_submission';
        else if (submitted) nextStatus = 'reference';
        else if (forceRegenerate) nextStatus = 'detected';
        else if (prev.status === 'awaiting_drive_confirm' && prev.deliverables) nextStatus = 'solved';
        else if (prev.status === 'error') nextStatus = 'detected';

        return {
          ...dt,
          requiresOnlineSubmission: !noSub,
          exportFormats: prev.exportFormats,
          deliverables: noSub || submitted || forceRegenerate ? undefined : prev.deliverables,
          status: nextStatus,
          errorMessage: nextStatus === 'detected' ? undefined : prev.errorMessage,
          driveFolderId: prev.driveFolderId,
          driveFolderLink: prev.driveFolderLink,
          driveFiles: prev.driveFiles,
          attachments: [...mergedAulesAtts, ...userAtts],
        };
      });
      await writeUserStore(store);

      const totalResourcesDetected = Object.values(courseResourcesByCourse).reduce(
        (sum, list) => sum + list.length,
        0
      );
      setStageStatus(run, 2, { status: 'completed', completedItems: 1 });
      addLog(
        run,
        2,
        'success',
        `Detectados ${discovered.courses.length} cursos, ${store.tasks.length} tareas y ${totalResourcesDetected} recursos.`,
        discovered.courses.map((c) => c.name).slice(0, 6).join(', ')
      );
    }
    if (isRunCancelled(run.id)) throw new Error('Proceso cancelado por el usuario.');

    const targetTasks = store.tasks.filter((t) => {
      if (taskId) return t.id === taskId;
      if (courseId) return t.courseId === courseId;
      return true;
    });

    // If pending_only and a course with incomplete actionable tasks lacks course resources, discover them now
    if (session && useExistingTasks) {
      const coursesNeedingContext = new Set(
        targetTasks.filter((t) => isTaskIncomplete(t)).map((t) => t.courseId)
      );
      for (const cId of coursesNeedingContext) {
        if (isRunCancelled(run.id)) break;
        const existingDocs = courseResourcesByCourse[cId] || [];
        if (existingDocs.length === 0) {
          const courseObj = store.courses.find((c) => c.id === cId);
          if (courseObj) {
            run.currentItemLabel = `Buscando apuntes de ${courseObj.name} en Aules...`;
            emitUpdate(run);
            const foundDocs = await discoverCourseResourcesForCourse(
              session,
              courseObj.id,
              courseObj.url
            );
            courseResourcesByCourse[cId] = foundDocs;
          }
        }
      }
      store.courseResources = courseResourcesByCourse;
      await writeUserStore(store);
    }

    // Stage 3: Download & extract documentation (concurrency = 4)
    const courseDocsList = Object.entries(courseResourcesByCourse)
      .filter(([cId]) => !courseId || cId === courseId)
      .flatMap(([, docs]) => docs.filter((d) => !d.downloaded || !d.localCacheKey).slice(0, 15));
    const pendingTaskAtts = targetTasks.flatMap((t) =>
      t.attachments.filter((a) => !a.downloaded || !a.localCacheKey).map((a) => ({ task: t, att: a }))
    );
    const totalToDownload = courseDocsList.length + pendingTaskAtts.length;

    setStageStatus(run, 3, {
      status: 'active',
      completedItems: 0,
      totalItems: Math.max(1, totalToDownload),
    });

    if (!session || totalToDownload === 0) {
      addLog(
        run,
        3,
        'info',
        session
          ? 'Recursos y adjuntos ya descargados e indexados en caché local.'
          : 'Sesión web de Aules no activa: se usarán los recursos ya guardados en disco.'
      );
      setStageStatus(run, 3, { status: 'completed', completedItems: 1, totalItems: 1 });
    } else {
      addLog(run, 3, 'info', `Descargando e indexando ${totalToDownload} documento(s) de apoyo...`);
      let downloadedCount = 0;

      const downloadItems: Array<() => Promise<void>> = [
        ...courseDocsList.map((doc) => async () => {
          if (doc.downloaded && doc.localCacheKey) return;
          try {
            run.currentItemLabel = `Descargando recurso del curso: ${doc.name}`;
            emitUpdate(run);
            const dl = await downloadAndExtractAttachment(session, doc);
            doc.name = dl.fileName;
            doc.mimeType = dl.mimeType;
            doc.byteSize = dl.byteSize;
            doc.extractedText = dl.extractedText;
            doc.downloaded = true;
            doc.localCacheKey = await saveAttachmentCache(uid, doc.id, dl.buffer);
          } catch {
            // Non-fatal
          } finally {
            downloadedCount++;
            setStageStatus(run, 3, { completedItems: downloadedCount });
          }
        }),
        ...pendingTaskAtts.map(({ task, att }) => async () => {
          try {
            run.currentItemLabel = `Descargando adjunto: ${att.name}`;
            emitUpdate(run);
            const dl = await downloadAndExtractAttachment(session, att);
            att.name = dl.fileName;
            att.mimeType = dl.mimeType;
            att.byteSize = dl.byteSize;
            att.extractedText = dl.extractedText;
            att.downloaded = true;
            att.localCacheKey = await saveAttachmentCache(uid, att.id, dl.buffer);
            if (task.status === 'detected') task.status = 'downloaded';
          } catch (err) {
            addLog(
              run,
              3,
              'warning',
              `No se pudo descargar "${att.name}"`,
              err instanceof Error ? err.message : undefined
            );
          } finally {
            downloadedCount++;
            setStageStatus(run, 3, { completedItems: downloadedCount });
          }
        }),
      ];

      await runWithConcurrency(downloadItems, 4, async (fn) => {
        if (isRunCancelled(run.id)) return;
        await fn();
      });

      store.courseResources = courseResourcesByCourse;
      await writeUserStore(store);
      setStageStatus(run, 3, { status: 'completed', completedItems: Math.max(1, totalToDownload) });
      addLog(run, 3, 'success', 'Documentación de asignaturas y tareas indexada en caché.');
    }
    if (isRunCancelled(run.id)) throw new Error('Proceso cancelado por el usuario.');

    // Stage 4: Local learning + minimal Groq style synthesis only for new student submissions
    const targetCourses = store.courses.filter((c) => !courseId || c.id === courseId);
    setStageStatus(run, 4, {
      status: 'active',
      completedItems: 0,
      totalItems: Math.max(1, targetCourses.length),
    });
    const activeModel = normalizeGroqModel(store.selectedModel);
    addLog(
      run,
      4,
      'info',
      `Indexando ${targetCourses.length} asignatura(s) localmente (solo usa IA si hay entregas nuevas del alumno)...`
    );

    let learnedCourses = 0;
    await runWithConcurrency(targetCourses, 1, async (course) => {
      if (isRunCancelled(run.id)) return;
      const courseTasks = store.tasks.filter((t) => t.courseId === course.id);
      const courseDocs = courseResourcesByCourse[course.id] || [];
      const existingKb = store.knowledge[course.id];

      try {
        run.currentItemLabel = `Actualizando memoria: ${course.name}`;
        emitUpdate(run);
        const updatedKnowledge = await learnFromCourseMaterials(
          activeModel,
          course.id,
          course.name,
          existingKb,
          courseTasks,
          courseDocs,
          (waitSec, m) => {
            run.currentItemLabel = `Esperando recarga de cuota Groq (${waitSec}s · ${m})...`;
            emitUpdate(run);
          }
        );
        store.knowledge[course.id] = updatedKnowledge;
      } catch (err) {
        addLog(
          run,
          4,
          'warning',
          `Nota en memoria de "${course.name}"`,
          err instanceof Error ? err.message : undefined
        );
      } finally {
        learnedCourses++;
        setStageStatus(run, 4, { completedItems: learnedCourses });
      }
    });

    await writeUserStore(store);
    await persistRunToStore(uid, email, run, true);
    setStageStatus(run, 4, { status: 'completed', completedItems: Math.max(1, targetCourses.length) });
    if (isRunCancelled(run.id)) throw new Error('Proceso cancelado por el usuario.');

    // Stage 5: Solve ONLY actionable unsubmitted tasks sequentially with TPM pacing
    let referenceSkipped = 0;
    let noSubmissionSkipped = 0;
    for (const t of targetTasks) {
      if (isTaskNoSubmission(t)) {
        t.requiresOnlineSubmission = false;
        t.isSubmittedInAules = false;
        t.status = 'no_submission';
        noSubmissionSkipped++;
      } else if (isTaskSubmittedInAules(t)) {
        t.isSubmittedInAules = true;
        if (t.status !== 'synced') {
          t.status = 'reference';
        }
        referenceSkipped++;
      }
    }

    const tasksToSolve = targetTasks.filter(
      (t) => isTaskActionable(t) && (forceRegenerate || isTaskIncomplete(t))
    );
    setStageStatus(run, 5, {
      status: 'active',
      completedItems: 0,
      totalItems: Math.max(1, tasksToSolve.length),
    });

    if (referenceSkipped > 0 || noSubmissionSkipped > 0) {
      addLog(
        run,
        5,
        'info',
        `Omitidas ${referenceSkipped} ya entregada(s) (referencia de estilo) y ${noSubmissionSkipped} sin entrega en línea.`
      );
    }

    if (tasksToSolve.length === 0) {
      addLog(run, 5, 'info', 'Todas las tareas pendientes ya están resueltas; pasando a Drive.');
    } else {
      addLog(
        run,
        5,
        'info',
        `Resolviendo ${tasksToSolve.length} tarea(s) sin hacer en cola secuencial con ${activeModel}...`
      );
    }

    let solvedCount = 0;
    await runWithConcurrency(tasksToSolve, 1, async (task) => {
      if (isRunCancelled(run.id)) return;
      run.currentItemLabel = `Resolviendo (${solvedCount + 1}/${tasksToSolve.length}): ${task.title}`;
      emitUpdate(run);

      try {
        const refExamples = getCourseReferenceExamples(store.tasks, task.courseId, task.id);
        const courseDocs = courseResourcesByCourse[task.courseId] || [];
        const deliverables = await solveAndAnalyzeTask(
          activeModel,
          task,
          store.knowledge[task.courseId],
          courseDocs,
          refExamples,
          (waitSec, m) => {
            run.currentItemLabel = `Pausa TPM Groq (${waitSec}s · ${m}) antes de "${task.title}"`;
            emitUpdate(run);
          }
        );
        task.deliverables = deliverables;
        if (!task.exportFormats || task.exportFormats.length === 0) {
          task.exportFormats = [deliverables.outputFormat || 'pdf'];
        }
        task.status = 'solved';
        task.errorMessage = undefined;
        task.updatedAt = new Date().toISOString();
        await writeUserStore(store);

        solvedCount++;
        setStageStatus(run, 5, { completedItems: solvedCount });
        const ctxNote =
          deliverables.contextSourcesUsed && deliverables.contextSourcesUsed.length > 0
            ? `Contexto: ${deliverables.contextSourcesUsed.join(', ')}`
            : undefined;
        addLog(
          run,
          5,
          'success',
          `Resuelta (${solvedCount}/${tasksToSolve.length}): ${task.title} [${deliverables.modelUsed}]`,
          ctxNote
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Error al generar deberes';
        task.status = 'error';
        task.errorMessage = msg;
        await writeUserStore(store);

        solvedCount++;
        setStageStatus(run, 5, { completedItems: solvedCount });
        addLog(run, 5, 'error', `Error en "${task.title}"`, msg);
      }

      await persistRunToStore(uid, email, run);
    });

    setStageStatus(run, 5, { status: 'completed', completedItems: Math.max(1, tasksToSolve.length) });
    if (isRunCancelled(run.id)) throw new Error('Proceso cancelado por el usuario.');

    // Stage 6: Direct Drive Sync (Auto-PATCH without pauses)
    await syncDeliverablesToDrive(run, uid, email, courseResourcesByCourse);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error inesperado en el agente';
    const cancelled = isRunCancelled(run.id);
    run.status = cancelled ? 'cancelled' : 'error';
    run.errorMessage = message;
    run.finishedAt = new Date().toISOString();
    run.currentItemLabel = cancelled ? 'Proceso cancelado' : `Error: ${message}`;
    setStageStatus(run, run.currentStage, { status: 'error' });
    addLog(run, run.currentStage, cancelled ? 'warning' : 'error', message);
    await persistRunToStore(uid, email, run, true);
    clearRunDriveToken(run.id);
  }
}

export async function resumeDriveSyncForRun(
  runId: string,
  uid: string,
  email: string
): Promise<PipelineRun> {
  const run = getRun(runId);
  if (!run || run.uid !== uid) {
    throw new Error('Ejecución no encontrada');
  }

  run.status = 'running';
  const resources = cachedRunResources.get(runId) || {};
  await syncDeliverablesToDrive(run, uid, email, resources);
  return run;
}
