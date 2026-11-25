import { getDriveAccessToken, getFirebaseIdToken } from './firebaseAuth';
import type {
  AiModelInfo,
  AttachmentRecord,
  AulesProfile,
  DeliverableFormat,
  DriveConflictItem,
  DriveTreeNode,
  PipelineRun,
  TaskRecord,
  UserAgentStore,
} from '../types';

async function authFetch<T>(url: string, init: RequestInit = {}, includeDriveToken = false): Promise<T> {
  const idToken = await getFirebaseIdToken();
  if (!idToken) {
    throw new Error('Debes iniciar sesión con Google para continuar.');
  }

  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${idToken}`);
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  if (includeDriveToken) {
    const driveToken = getDriveAccessToken();
    if (driveToken) {
      headers.set('X-Drive-Token', driveToken);
    }
  }

  const res = await fetch(url, { ...init, headers });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    throw new Error(data.error || `Error de servidor (HTTP ${res.status})`);
  }
  return data;
}

export async function fetchPublicConfigStatus(): Promise<{ groqConfigured: boolean }> {
  const res = await fetch('/api/config/status');
  if (!res.ok) return { groqConfigured: false };
  return (await res.json()) as { groqConfigured: boolean };
}

export async function fetchWorkspaceState(): Promise<{
  store: UserAgentStore;
  aulesConnected: boolean;
  latestRun: PipelineRun | null;
  groqConfigured: boolean;
}> {
  return authFetch('/api/state');
}

export async function fetchAiModels(): Promise<{ models: AiModelInfo[] }> {
  return authFetch('/api/models');
}

export async function connectAulesAccount(payload: {
  baseUrl: string;
  username: string;
  password: string;
}): Promise<{ connected: boolean; profile: AulesProfile }> {
  return authFetch('/api/aules/connect', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function disconnectAulesAccount(): Promise<void> {
  await authFetch('/api/aules/disconnect', { method: 'POST' });
}

export async function updateAgentSettings(payload: {
  selectedModel?: string;
  autoSyncEnabled?: boolean;
  autoSyncIntervalMinutes?: number;
}): Promise<{ store: UserAgentStore }> {
  return authFetch('/api/settings', {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
}

export async function startPipelineRun(payload?: {
  mode?: 'full' | 'pending_only';
  courseId?: string;
  taskId?: string;
  forceRegenerate?: boolean;
}): Promise<{ run: PipelineRun }> {
  return authFetch(
    '/api/agent/run',
    {
      method: 'POST',
      body: JSON.stringify(payload || {}),
    },
    true
  );
}

export async function cancelPipelineRun(runId: string): Promise<void> {
  await authFetch(`/api/agent/runs/${encodeURIComponent(runId)}/cancel`, {
    method: 'POST',
  });
}

export async function confirmDriveOverwrites(
  runId: string,
  confirmedKeys: string[],
  action: 'overwrite' | 'skip'
): Promise<{ run: PipelineRun }> {
  return authFetch(
    `/api/agent/runs/${encodeURIComponent(runId)}/confirm-drive`,
    {
      method: 'POST',
      body: JSON.stringify({ confirmedKeys, action }),
    },
    true
  );
}

export async function solveSingleTask(taskId: string, model?: string): Promise<{ task: TaskRecord }> {
  return authFetch(`/api/tasks/${encodeURIComponent(taskId)}/solve`, {
    method: 'POST',
    body: JSON.stringify({ model }),
  });
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const commaIdx = result.indexOf(',');
      resolve(commaIdx >= 0 ? result.slice(commaIdx + 1) : result);
    };
    reader.onerror = () => reject(new Error('No se pudo leer el archivo seleccionado.'));
    reader.readAsDataURL(file);
  });
}

export async function uploadTaskAttachment(
  taskId: string,
  file: File
): Promise<{ task: TaskRecord; attachment: AttachmentRecord }> {
  const base64Content = await fileToBase64(file);
  return authFetch(`/api/tasks/${encodeURIComponent(taskId)}/attachments`, {
    method: 'POST',
    body: JSON.stringify({
      fileName: file.name,
      mimeType: file.type,
      base64Content,
    }),
  });
}

export async function deleteTaskAttachment(
  taskId: string,
  attId: string
): Promise<{ task: TaskRecord }> {
  return authFetch(
    `/api/tasks/${encodeURIComponent(taskId)}/attachments/${encodeURIComponent(attId)}`,
    { method: 'DELETE' }
  );
}

export async function updateTaskExportFormats(
  taskId: string,
  formats: DeliverableFormat[]
): Promise<{ task: TaskRecord }> {
  return authFetch(`/api/tasks/${encodeURIComponent(taskId)}/export-formats`, {
    method: 'PATCH',
    body: JSON.stringify({ formats }),
  });
}

export async function downloadTaskDeliverableFile(
  taskId: string,
  format: DeliverableFormat,
  fallbackBaseName: string
): Promise<void> {
  const idToken = await getFirebaseIdToken();
  if (!idToken) {
    throw new Error('Debes iniciar sesión con Google para descargar.');
  }

  const res = await fetch(
    `/api/tasks/${encodeURIComponent(taskId)}/export/${encodeURIComponent(format)}`,
    {
      headers: { Authorization: `Bearer ${idToken}` },
    }
  );
  if (!res.ok) {
    const errBody = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(errBody.error || `No se pudo generar el archivo ${format.toUpperCase()}.`);
  }

  const blob = await res.blob();
  const disposition = res.headers.get('Content-Disposition') || '';
  const match = disposition.match(/filename="?([^"]+)"?/i);
  const safeBase = fallbackBaseName.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 60) || 'entrega';
  const fileName = match?.[1] || `${safeBase}_entrega.${format}`;

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

export async function syncSingleTaskToDrive(
  taskId: string,
  confirmedKeys?: string[]
): Promise<{ task: TaskRecord; conflicts: DriveConflictItem[] }> {
  return authFetch(
    `/api/drive/sync-task/${encodeURIComponent(taskId)}`,
    {
      method: 'POST',
      body: JSON.stringify({ confirmedKeys }),
    },
    true
  );
}

export async function fetchDriveTree(): Promise<{
  rootFolder: { id: string; webViewLink: string };
  tree: DriveTreeNode[];
}> {
  return authFetch('/api/drive/tree', { method: 'GET' }, true);
}

export function subscribeToRunStream(
  runId: string,
  onRunUpdate: (run: PipelineRun) => void,
  onStreamError?: (message: string) => void
): () => void {
  const controller = new AbortController();

  void (async () => {
    try {
      const idToken = await getFirebaseIdToken();
      if (!idToken) return;

      const res = await fetch(`/api/agent/stream/${encodeURIComponent(runId)}`, {
        headers: {
          Authorization: `Bearer ${idToken}`,
          Accept: 'text/event-stream',
        },
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        onStreamError?.('No se pudo conectar con el canal en tiempo real.');
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';

        for (const frame of frames) {
          const lines = frame.split('\n');
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const rawJson = line.slice(6).trim();
              if (!rawJson) continue;
              try {
                const parsed = JSON.parse(rawJson) as PipelineRun;
                onRunUpdate(parsed);
              } catch {
                // Ignore malformed partial frame
              }
            }
          }
        }
      }
    } catch (err) {
      if ((err as { name?: string })?.name !== 'AbortError') {
        onStreamError?.(
          err instanceof Error ? err.message : 'Conexión en tiempo real interrumpida.'
        );
      }
    }
  })();

  return () => controller.abort();
}
