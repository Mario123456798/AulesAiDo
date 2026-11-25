import 'dotenv/config';
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { createServer as createViteServer } from 'vite';
import crypto from 'node:crypto';
import {
  connectAules,
  discoverCourseResourcesForCourse,
  downloadAndExtractAttachment,
  verifyAulesSessionAlive,
} from './server/aulesClient.ts';
import {
  isTaskNoSubmission,
  isTaskSubmittedInAules,
  needsExtraCourseContext,
} from './server/contextEngine.ts';
import {
  buildDeliverableFile,
  extractTextFromUploadedFile,
} from './server/documentBuilder.ts';
import { ensureDriveFolder, listDriveFolderChildren, syncFileSafely } from './server/driveSync.ts';
import {
  isGroqConfigured,
  listGroqModels,
  normalizeGroqModel,
  solveAndAnalyzeTask,
} from './server/groqClient.ts';
import {
  createPipelineRun,
  executePipelineRun,
  getCourseReferenceExamples,
  resumeDriveSyncForRun,
} from './server/pipeline.ts';
import { sanitizeFileName, verifyFirebaseIdToken, type AuthenticatedUser } from './server/security.ts';
import {
  clearAulesSession,
  getOrRestoreAulesSession,
  getRun,
  getRunEmitter,
  grantOverwriteConfirmation,
  markRunCancelled,
  readAttachmentCache,
  readUserStore,
  sanitizeStoreForClient,
  saveAttachmentCache,
  setAulesSession,
  setRunDriveToken,
  writeUserStore,
} from './server/store.ts';
import type { AttachmentRecord, DeliverableFormat, DriveConflictItem } from './server/types.ts';

interface AuthedRequest extends express.Request {
  authUser?: AuthenticatedUser;
}

async function requireAuth(
  req: AuthedRequest,
  res: express.Response,
  next: express.NextFunction
): Promise<void> {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Debes iniciar sesión con Google primero.' });
      return;
    }
    const idToken = authHeader.slice(7).trim();
    const user = await verifyFirebaseIdToken(idToken);
    req.authUser = user;
    next();
  } catch (err) {
    res.status(401).json({
      error: err instanceof Error ? err.message : 'Sesión inválida o expirada.',
    });
  }
}

async function startServer(): Promise<void> {
  const app = express();
  app.use(express.json({ limit: '18mb' }));

  // Public configuration status (no secrets exposed)
  app.get('/api/config/status', (_req, res) => {
    res.json({
      groqConfigured: isGroqConfigured(),
    });
  });

  // Groq Cloud available models
  app.get('/api/models', requireAuth, async (_req, res) => {
    const models = await listGroqModels();
    res.json({ models });
  });

  // Load user's agent workspace state
  app.get('/api/state', requireAuth, async (req: AuthedRequest, res) => {
    const user = req.authUser!;
    const store = await readUserStore(user.uid, user.email);
    let activeAules = await getOrRestoreAulesSession(user.uid);
    if (activeAules) {
      // Quick non-blocking-feel session check only if restored from disk (not yet verified recently)
      const ageMs = Date.now() - new Date(activeAules.connectedAt).getTime();
      if (ageMs > 5 * 60 * 1000) {
        const alive = await verifyAulesSessionAlive(activeAules);
        if (!alive) {
          await clearAulesSession(user.uid);
          activeAules = null;
        } else {
          activeAules.connectedAt = new Date().toISOString();
          await setAulesSession(user.uid, activeAules);
        }
      }
    }
    let storeChanged = false;
    for (const t of store.tasks) {
      if (isTaskNoSubmission(t)) {
        if (
          t.status !== 'no_submission' ||
          t.requiresOnlineSubmission !== false ||
          t.isSubmittedInAules !== false ||
          t.errorMessage
        ) {
          t.requiresOnlineSubmission = false;
          t.isSubmittedInAules = false;
          t.status = 'no_submission';
          t.errorMessage = undefined;
          storeChanged = true;
        }
      } else if (isTaskSubmittedInAules(t)) {
        if (t.status !== 'reference' || t.isSubmittedInAules !== true) {
          t.isSubmittedInAules = true;
          t.status = 'reference';
          t.errorMessage = undefined;
          storeChanged = true;
        }
      } else if (t.status === 'awaiting_drive_confirm') {
        const hasValidSol = Boolean(
          t.deliverables && t.deliverables.homeworkSolutionMd.trim().length >= 100
        );
        t.status = hasValidSol ? 'solved' : 'downloaded';
        storeChanged = true;
      }
    }

    const storedFirst = store.runs[0];
    if (storedFirst && storedFirst.status === 'running' && !getRun(storedFirst.id)) {
      storedFirst.status = 'error';
      storedFirst.finishedAt = new Date().toISOString();
      storedFirst.errorMessage =
        'Ejecución anterior interrumpida por reinicio del servidor. Puedes continuar con las tareas pendientes.';
      storedFirst.currentItemLabel = 'Ejecución anterior interrumpida';
      storeChanged = true;
    }
    if (storeChanged) {
      await writeUserStore(store);
    }
    const latestRun = store.runs[0] ? getRun(store.runs[0].id) || store.runs[0] : null;

    res.json({
      store: sanitizeStoreForClient(store),
      aulesConnected: Boolean(activeAules),
      latestRun,
      groqConfigured: isGroqConfigured(),
    });
  });

  // Connect Aules with web credentials (in-memory MoodleSession only)
  app.post('/api/aules/connect', requireAuth, async (req: AuthedRequest, res) => {
    const user = req.authUser!;
    const { baseUrl, username, password } = req.body as {
      baseUrl?: string;
      username?: string;
      password?: string;
    };

    if (!baseUrl || !username || !password) {
      res.status(400).json({ error: 'Introduce la URL de Aules, tu usuario y tu contraseña.' });
      return;
    }

    try {
      const session = await connectAules(baseUrl, username, password);
      await setAulesSession(user.uid, session);

      const store = await readUserStore(user.uid, user.email);
      store.aulesProfile = {
        baseUrl: session.baseUrl,
        username: session.username,
        fullName: session.fullName,
        lastConnectedAt: session.connectedAt,
      };
      await writeUserStore(store);

      res.json({
        connected: true,
        profile: store.aulesProfile,
      });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'No se pudo iniciar sesión en Aules.',
      });
    }
  });

  app.post('/api/aules/disconnect', requireAuth, async (req: AuthedRequest, res) => {
    const user = req.authUser!;
    await clearAulesSession(user.uid);
    res.json({ connected: false });
  });

  // Update model and auto-sync preferences
  app.patch('/api/settings', requireAuth, async (req: AuthedRequest, res) => {
    const user = req.authUser!;
    const { selectedModel, autoSyncEnabled, autoSyncIntervalMinutes } = req.body as {
      selectedModel?: string;
      autoSyncEnabled?: boolean;
      autoSyncIntervalMinutes?: number;
    };

    const store = await readUserStore(user.uid, user.email);
    if (typeof selectedModel === 'string' && selectedModel.trim()) {
      store.selectedModel = normalizeGroqModel(selectedModel.trim());
    }
    if (typeof autoSyncEnabled === 'boolean') {
      store.autoSyncEnabled = autoSyncEnabled;
    }
    if (typeof autoSyncIntervalMinutes === 'number' && autoSyncIntervalMinutes >= 5) {
      store.autoSyncIntervalMinutes = Math.min(240, Math.round(autoSyncIntervalMinutes));
    }
    await writeUserStore(store);
    res.json({ store: sanitizeStoreForClient(store) });
  });

  // Start full 6-stage automation run or pending-tasks batch
  app.post('/api/agent/run', requireAuth, async (req: AuthedRequest, res) => {
    const user = req.authUser!;
    const driveToken = req.headers['x-drive-token'];
    const { mode = 'full', courseId, taskId, forceRegenerate } = (req.body || {}) as {
      mode?: 'full' | 'pending_only';
      courseId?: string;
      taskId?: string;
      forceRegenerate?: boolean;
    };

    const store = await readUserStore(user.uid, user.email);
    const hasSavedTasks = store.tasks.length > 0;

    if (mode !== 'pending_only' || !hasSavedTasks) {
      const aulesSession = await getOrRestoreAulesSession(user.uid);
      if (!aulesSession) {
        res.status(400).json({
          error: 'Conecta primero tus credenciales web de Aules en la sección Conexiones.',
        });
        return;
      }
    }

    if (!isGroqConfigured()) {
      res.status(400).json({
        error: 'GROQ_API_KEY no está configurada en los secretos del servidor.',
      });
      return;
    }

    if (typeof driveToken !== 'string' || !driveToken.trim()) {
      res.status(400).json({
        error: 'Necesitas autorizar Google Drive iniciando sesión con Google antes de ejecutar el agente.',
      });
      return;
    }

    const run = createPipelineRun(user.uid);
    setRunDriveToken(run.id, driveToken.trim());

    store.runs = [run, ...store.runs].slice(0, 15);
    await writeUserStore(store);

    // Execute pipeline asynchronously while streaming SSE updates
    void executePipelineRun(run, {
      uid: user.uid,
      email: user.email,
      mode,
      courseId,
      taskId,
      forceRegenerate,
    });

    res.json({ run });
  });

  // Live SSE progress stream for a run
  app.get('/api/agent/stream/:runId', requireAuth, async (req: AuthedRequest, res) => {
    const user = req.authUser!;
    const runId = String(req.params.runId);
    const run = getRun(runId);

    if (!run || run.uid !== user.uid) {
      res.status(404).json({ error: 'Ejecución no encontrada.' });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const sendSnapshot = (payload: unknown) => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    sendSnapshot(run);

    const emitter = getRunEmitter(runId);
    if (!emitter) {
      res.end();
      return;
    }

    const onUpdate = (updatedRun: typeof run) => {
      sendSnapshot(updatedRun);
      if (
        updatedRun.status === 'completed' ||
        updatedRun.status === 'error' ||
        updatedRun.status === 'cancelled'
      ) {
        cleanup();
        res.end();
      }
    };

    const keepAlive = setInterval(() => {
      res.write(': ping\n\n');
    }, 15000);

    const cleanup = () => {
      clearInterval(keepAlive);
      emitter.off('update', onUpdate);
    };

    emitter.on('update', onUpdate);
    req.on('close', cleanup);
  });

  app.post('/api/agent/runs/:runId/cancel', requireAuth, async (req: AuthedRequest, res) => {
    const user = req.authUser!;
    const runId = String(req.params.runId);
    const run = getRun(runId);
    if (!run || run.uid !== user.uid) {
      res.status(404).json({ error: 'Ejecución no encontrada.' });
      return;
    }
    markRunCancelled(runId);
    res.json({ cancelled: true });
  });

  // Confirm or skip overwriting existing files in Google Drive
  app.post('/api/agent/runs/:runId/confirm-drive', requireAuth, async (req: AuthedRequest, res) => {
    const user = req.authUser!;
    const runId = String(req.params.runId);
    const driveToken = req.headers['x-drive-token'];
    const { confirmedKeys, action } = req.body as {
      confirmedKeys?: string[];
      action?: 'overwrite' | 'skip';
    };

    const run = getRun(runId);
    if (!run || run.uid !== user.uid) {
      res.status(404).json({ error: 'Ejecución no encontrada.' });
      return;
    }

    if (action === 'skip') {
      run.pendingConfirmations = [];
      run.status = 'completed';
      run.finishedAt = new Date().toISOString();
      run.currentItemLabel = 'Sincronización finalizada (archivos existentes conservados)';
      const store = await readUserStore(user.uid, user.email);
      const idx = store.runs.findIndex((r) => r.id === run.id);
      if (idx >= 0) store.runs[idx] = run;
      await writeUserStore(store);
      res.json({ run });
      return;
    }

    if (typeof driveToken !== 'string' || !driveToken.trim()) {
      res.status(400).json({ error: 'Falta el token de Google Drive para continuar.' });
      return;
    }

    setRunDriveToken(runId, driveToken.trim());
    grantOverwriteConfirmation(runId, Array.isArray(confirmedKeys) ? confirmedKeys : []);
    const updatedRun = await resumeDriveSyncForRun(runId, user.uid, user.email);
    res.json({ run: updatedRun });
  });

  // Re-solve a single task on demand
  app.post('/api/tasks/:taskId/solve', requireAuth, async (req: AuthedRequest, res) => {
    const user = req.authUser!;
    const taskId = String(req.params.taskId);
    const { model } = (req.body || {}) as { model?: string };

    if (!isGroqConfigured()) {
      res.status(400).json({ error: 'GROQ_API_KEY no está configurada en el servidor.' });
      return;
    }

    const store = await readUserStore(user.uid, user.email);
    const task = store.tasks.find((t) => t.id === taskId);
    if (!task) {
      res.status(404).json({ error: 'Tarea no encontrada.' });
      return;
    }

    try {
      const targetModel = normalizeGroqModel(model?.trim() || store.selectedModel);
      const refExamples = getCourseReferenceExamples(store.tasks, task.courseId, task.id);

      let courseDocs = store.courseResources?.[task.courseId] || [];
      if (courseDocs.length === 0 && needsExtraCourseContext(task)) {
        const activeAules = await getOrRestoreAulesSession(user.uid);
        const course = store.courses.find((c) => c.id === task.courseId);
        if (activeAules && course) {
          try {
            const discovered = await discoverCourseResourcesForCourse(
              activeAules,
              course.id,
              course.url
            );
            const downloadedDocs: AttachmentRecord[] = [];
            for (const resItem of discovered.slice(0, 6)) {
              try {
                const dl = await downloadAndExtractAttachment(activeAules, resItem);
                const cacheKey = await saveAttachmentCache(user.uid, resItem.id, dl.buffer);
                downloadedDocs.push({
                  ...resItem,
                  name: dl.fileName,
                  mimeType: dl.mimeType,
                  byteSize: dl.byteSize,
                  extractedText: dl.extractedText,
                  downloaded: true,
                  localCacheKey: cacheKey,
                });
              } catch {
                // Non-fatal per resource
              }
            }
            if (downloadedDocs.length > 0) {
              if (!store.courseResources) store.courseResources = {};
              store.courseResources[task.courseId] = downloadedDocs;
              courseDocs = downloadedDocs;
            }
          } catch {
            // Non-fatal if Aules course discovery fails during single-task solve
          }
        }
      }

      const deliverables = await solveAndAnalyzeTask(
        targetModel,
        task,
        store.knowledge[task.courseId],
        courseDocs,
        refExamples
      );
      task.deliverables = deliverables;
      if (!task.exportFormats || task.exportFormats.length === 0) {
        task.exportFormats = [deliverables.outputFormat || 'pdf'];
      }
      task.status = 'solved';
      task.errorMessage = undefined;
      task.updatedAt = new Date().toISOString();
      await writeUserStore(store);
      res.json({ task });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Error al resolver la tarea con Groq.',
      });
    }
  });

  // Upload user-provided HTML, PDF, DOCX, or text attachment to a task
  app.post('/api/tasks/:taskId/attachments', requireAuth, async (req: AuthedRequest, res) => {
    const user = req.authUser!;
    const taskId = String(req.params.taskId);
    const { fileName, mimeType, base64Content } = (req.body || {}) as {
      fileName?: string;
      mimeType?: string;
      base64Content?: string;
    };

    if (!fileName || !base64Content) {
      res.status(400).json({ error: 'Falta el nombre o contenido del archivo.' });
      return;
    }

    const safeName = sanitizeFileName(fileName);
    const lower = safeName.toLowerCase();
    if (!/\.(html|htm|pdf|docx|txt|md|csv)$/i.test(lower)) {
      res.status(400).json({
        error: 'Solo se admiten archivos HTML, PDF, DOCX, TXT, MD o CSV.',
      });
      return;
    }

    const buffer = Buffer.from(base64Content, 'base64');
    if (buffer.length === 0 || buffer.length > 12 * 1024 * 1024) {
      res.status(400).json({ error: 'El archivo debe pesar entre 1 byte y 12 MB.' });
      return;
    }

    const store = await readUserStore(user.uid, user.email);
    const task = store.tasks.find((t) => t.id === taskId);
    if (!task) {
      res.status(404).json({ error: 'Tarea no encontrada.' });
      return;
    }

    const resolvedMime =
      mimeType ||
      (lower.endsWith('.pdf')
        ? 'application/pdf'
        : lower.endsWith('.docx')
        ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        : lower.endsWith('.html') || lower.endsWith('.htm')
        ? 'text/html'
        : 'text/plain');

    const extractedText = await extractTextFromUploadedFile(safeName, resolvedMime, buffer);
    const attId = `usr_${crypto.randomBytes(6).toString('hex')}`;
    const cacheKey = await saveAttachmentCache(user.uid, attId, buffer);

    const newAttachment: AttachmentRecord = {
      id: attId,
      name: safeName,
      sourceUrl: `local://user_attachment/${attId}`,
      mimeType: resolvedMime,
      byteSize: buffer.length,
      downloaded: true,
      localCacheKey: cacheKey,
      extractedText,
      sourceType: 'user_attachment',
    };

    task.attachments = [...task.attachments, newAttachment];
    task.updatedAt = new Date().toISOString();
    await writeUserStore(store);
    res.json({ task, attachment: newAttachment });
  });

  // Remove a user-attached file from a task
  app.delete(
    '/api/tasks/:taskId/attachments/:attId',
    requireAuth,
    async (req: AuthedRequest, res) => {
      const user = req.authUser!;
      const taskId = String(req.params.taskId);
      const attId = String(req.params.attId);

      const store = await readUserStore(user.uid, user.email);
      const task = store.tasks.find((t) => t.id === taskId);
      if (!task) {
        res.status(404).json({ error: 'Tarea no encontrada.' });
        return;
      }

      task.attachments = task.attachments.filter(
        (a) => !(a.id === attId && a.sourceType === 'user_attachment')
      );
      task.updatedAt = new Date().toISOString();
      await writeUserStore(store);
      res.json({ task });
    }
  );

  // Update preferred deliverable export formats (html / pdf / docx) for a task
  app.patch('/api/tasks/:taskId/export-formats', requireAuth, async (req: AuthedRequest, res) => {
    const user = req.authUser!;
    const taskId = String(req.params.taskId);
    const { formats } = (req.body || {}) as { formats?: string[] };

    const validSet = new Set<DeliverableFormat>(['html', 'pdf', 'docx', 'md']);
    const cleanFormats = Array.isArray(formats)
      ? Array.from(new Set(formats.filter((f): f is DeliverableFormat => validSet.has(f as DeliverableFormat))))
      : [];

    if (cleanFormats.length === 0) {
      res.status(400).json({ error: 'Selecciona al menos un formato de entrega (HTML, PDF o DOCX).' });
      return;
    }

    const store = await readUserStore(user.uid, user.email);
    const task = store.tasks.find((t) => t.id === taskId);
    if (!task) {
      res.status(404).json({ error: 'Tarea no encontrada.' });
      return;
    }

    task.exportFormats = cleanFormats;
    task.updatedAt = new Date().toISOString();
    await writeUserStore(store);
    res.json({ task });
  });

  // Download generated deliverable in HTML, PDF, DOCX, or MD format
  app.get('/api/tasks/:taskId/export/:format', requireAuth, async (req: AuthedRequest, res) => {
    const user = req.authUser!;
    const taskId = String(req.params.taskId);
    const fmt = String(req.params.format).toLowerCase() as DeliverableFormat;
    if (!['html', 'pdf', 'docx', 'md'].includes(fmt)) {
      res.status(400).json({ error: 'Formato no soportado. Usa html, pdf, docx o md.' });
      return;
    }

    const store = await readUserStore(user.uid, user.email);
    const task = store.tasks.find((t) => t.id === taskId);
    if (!task || !task.deliverables) {
      res.status(404).json({ error: 'La tarea aún no tiene entregables generados.' });
      return;
    }

    const built = await buildDeliverableFile(fmt, task, task.deliverables);
    res.setHeader('Content-Type', built.mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${built.fileName}"`);
    res.send(built.buffer);
  });

  // Sync a single task to Google Drive (with explicit overwrite confirmation check)
  app.post('/api/drive/sync-task/:taskId', requireAuth, async (req: AuthedRequest, res) => {
    const user = req.authUser!;
    const taskId = String(req.params.taskId);
    const driveToken = req.headers['x-drive-token'];
    const { confirmedKeys } = (req.body || {}) as { confirmedKeys?: string[] };

    if (typeof driveToken !== 'string' || !driveToken.trim()) {
      res.status(400).json({ error: 'Inicia sesión con Google Drive primero.' });
      return;
    }

    const store = await readUserStore(user.uid, user.email);
    const task = store.tasks.find((t) => t.id === taskId);
    if (!task) {
      res.status(404).json({ error: 'Tarea no encontrada.' });
      return;
    }

    try {
      const rootFolder = await ensureDriveFolder(driveToken.trim(), 'Aules Sync');
      store.driveRootFolderId = rootFolder.id;
      store.driveRootFolderLink = rootFolder.webViewLink;

      const courseFolder = await ensureDriveFolder(driveToken.trim(), task.courseName, rootFolder.id);
      const taskFolder = await ensureDriveFolder(
        driveToken.trim(),
        sanitizeFileName(task.title),
        courseFolder.id
      );

      task.driveFolderId = taskFolder.id;
      task.driveFolderLink = taskFolder.webViewLink;

      const confirmedSet = new Set(Array.isArray(confirmedKeys) ? confirmedKeys : []);
      const conflicts: DriveConflictItem[] = [];
      const syncedFiles = [...(task.driveFiles || [])];

      const upsertFile = (name: string, fileId: string, webViewLink: string) => {
        const idx = syncedFiles.findIndex((f) => f.name === name);
        const item = { name, fileId, webViewLink, updatedAt: new Date().toISOString() };
        if (idx >= 0) syncedFiles[idx] = item;
        else syncedFiles.push(item);
      };

      for (const att of task.attachments) {
        const buf = att.localCacheKey
          ? await readAttachmentCache(att.localCacheKey)
          : att.extractedText
          ? Buffer.from(att.extractedText, 'utf-8')
          : null;
        if (!buf) continue;
        const r = await syncFileSafely(driveToken.trim(), {
          folderId: taskFolder.id,
          fileName: att.name,
          mimeType: att.mimeType || 'application/octet-stream',
          content: buf,
          courseId: task.courseId,
          courseName: task.courseName,
          taskId: task.id,
          taskTitle: task.title,
          autoOverwrite: true,
          isOverwriteConfirmed: (key) => confirmedSet.has(key),
        });
        if (r.uploaded) upsertFile(r.name, r.fileId, r.webViewLink);
        else conflicts.push(r.conflict);
      }

      if (task.deliverables) {
        const docs: Array<{ name: string; mimeType: string; content: Buffer }> = [
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
          docs.push({ name: built.fileName, mimeType: built.mimeType, content: built.buffer });
        }

        for (const d of docs) {
          const r = await syncFileSafely(driveToken.trim(), {
            folderId: taskFolder.id,
            fileName: d.name,
            mimeType: d.mimeType,
            content: d.content,
            courseId: task.courseId,
            courseName: task.courseName,
            taskId: task.id,
            taskTitle: task.title,
            autoOverwrite: true,
            isOverwriteConfirmed: (key) => confirmedSet.has(key),
          });
          if (r.uploaded) upsertFile(r.name, r.fileId, r.webViewLink);
          else conflicts.push(r.conflict);
        }
      }

      task.driveFiles = syncedFiles;
      task.status = conflicts.length > 0 ? 'awaiting_drive_confirm' : 'synced';
      task.updatedAt = new Date().toISOString();
      await writeUserStore(store);

      res.json({ task, conflicts });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Error al sincronizar la tarea con Google Drive.',
      });
    }
  });

  // Live Google Drive folder tree under "Aules Sync"
  app.get('/api/drive/tree', requireAuth, async (req: AuthedRequest, res) => {
    const user = req.authUser!;
    const driveToken = req.headers['x-drive-token'];
    if (typeof driveToken !== 'string' || !driveToken.trim()) {
      res.status(400).json({ error: 'Inicia sesión con Google para explorar Google Drive.' });
      return;
    }

    try {
      const store = await readUserStore(user.uid, user.email);
      const rootFolder = await ensureDriveFolder(driveToken.trim(), 'Aules Sync');
      store.driveRootFolderId = rootFolder.id;
      store.driveRootFolderLink = rootFolder.webViewLink;
      await writeUserStore(store);

      const courseItems = await listDriveFolderChildren(driveToken.trim(), rootFolder.id);
      const tree = await Promise.all(
        courseItems
          .filter((item) => item.mimeType === 'application/vnd.google-apps.folder')
          .map(async (courseFolder) => {
            const subItems = await listDriveFolderChildren(driveToken.trim(), courseFolder.id);
            const children = await Promise.all(
              subItems.map(async (sub) => {
                if (sub.mimeType === 'application/vnd.google-apps.folder') {
                  const files = await listDriveFolderChildren(driveToken.trim(), sub.id);
                  return { ...sub, files };
                }
                return { ...sub, files: [] };
              })
            );
            return { ...courseFolder, children };
          })
      );

      res.json({ rootFolder, tree });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Error al leer Google Drive.',
      });
    }
  });

  const httpServer = http.createServer(app);

  // Mount Vite middleware in dev or static dist in production
  const isProd = process.env.NODE_ENV === 'production';
  if (!isProd) {
    const hmrDisabled = process.env.DISABLE_HMR === 'true';
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        allowedHosts: true,
        hmr: hmrDisabled ? false : undefined,
        ws: hmrDisabled ? false : { server: httpServer },
      },
      appType: 'spa',
    });
    if (hmrDisabled) {
      app.get('/@vite/client', (_req, res) => {
        res.setHeader('Content-Type', 'application/javascript');
        res.send(`
export function createHotContext() {
  return { accept(){}, prune(){}, dispose(){}, decline(){}, invalidate(){}, on(){}, off(){}, send(){} };
}
export function updateStyle(id, css) {
  let el = document.querySelector('style[data-vite-dev-id="' + id + '"]');
  if (!el) {
    el = document.createElement('style');
    el.setAttribute('data-vite-dev-id', id);
    document.head.appendChild(el);
  }
  el.textContent = css;
}
export function removeStyle(id) {
  const el = document.querySelector('style[data-vite-dev-id="' + id + '"]');
  if (el) el.remove();
}
export function injectQuery(url) { return url; }
`);
      });
    }
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(distDir, 'index.html'));
    });
  }

  const port = Number(process.env.PORT || 3000);
  httpServer.listen(port, '0.0.0.0', () => {
    console.log(`Aules Sync Agent listening on http://0.0.0.0:${port}`);
  });
}

void startServer();
