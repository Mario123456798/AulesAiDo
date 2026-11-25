import crypto from 'node:crypto';
import { sanitizeFileName } from './security.ts';
import type { DriveConflictItem } from './types.ts';

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';

interface DriveFileMeta {
  id: string;
  name: string;
  mimeType: string;
  webViewLink?: string;
}

function escapeDriveQuery(val: string): string {
  return val.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function driveJsonFetch<T>(url: string, accessToken: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${accessToken}`);
  const res = await fetch(url, { ...init, headers });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Error de Google Drive (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }

  return (await res.json()) as T;
}

export async function ensureDriveFolder(
  accessToken: string,
  folderName: string,
  parentId?: string
): Promise<{ id: string; webViewLink: string }> {
  const safeName = sanitizeFileName(folderName);
  const parentClause = parentId ? ` and '${escapeDriveQuery(parentId)}' in parents` : '';
  const query = `name = '${escapeDriveQuery(safeName)}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false${parentClause}`;

  const searchUrl = `${DRIVE_API}/files?q=${encodeURIComponent(
    query
  )}&fields=files(id,name,webViewLink)&spaces=drive&pageSize=5`;

  const searchRes = await driveJsonFetch<{ files?: DriveFileMeta[] }>(searchUrl, accessToken);
  if (searchRes.files && searchRes.files.length > 0) {
    const found = searchRes.files[0];
    return {
      id: found.id,
      webViewLink: found.webViewLink || `https://drive.google.com/drive/folders/${found.id}`,
    };
  }

  const created = await driveJsonFetch<DriveFileMeta>(
    `${DRIVE_API}/files?fields=id,name,webViewLink`,
    accessToken,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: safeName,
        mimeType: 'application/vnd.google-apps.folder',
        ...(parentId ? { parents: [parentId] } : {}),
      }),
    }
  );

  return {
    id: created.id,
    webViewLink: created.webViewLink || `https://drive.google.com/drive/folders/${created.id}`,
  };
}

export async function findDriveFileInFolder(
  accessToken: string,
  folderId: string,
  fileName: string
): Promise<DriveFileMeta | null> {
  const safeName = sanitizeFileName(fileName);
  const query = `name = '${escapeDriveQuery(safeName)}' and '${escapeDriveQuery(
    folderId
  )}' in parents and trashed = false`;
  const url = `${DRIVE_API}/files?q=${encodeURIComponent(
    query
  )}&fields=files(id,name,mimeType,webViewLink)&pageSize=5`;
  const res = await driveJsonFetch<{ files?: DriveFileMeta[] }>(url, accessToken);
  return res.files && res.files.length > 0 ? res.files[0] : null;
}

export async function uploadFileToDrive(
  accessToken: string,
  params: {
    folderId: string;
    fileName: string;
    mimeType: string;
    content: Buffer;
    existingFileId?: string;
  }
): Promise<{ id: string; webViewLink: string; name: string }> {
  const safeName = sanitizeFileName(params.fileName);
  const boundary = `aules_sync_${crypto.randomBytes(12).toString('hex')}`;

  const metadata: Record<string, unknown> = {
    name: safeName,
    mimeType: params.mimeType,
  };
  if (!params.existingFileId) {
    metadata.parents = [params.folderId];
  }

  const preamble =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: ${params.mimeType || 'application/octet-stream'}\r\n\r\n`;
  const epilogue = `\r\n--${boundary}--`;

  const bodyBuffer = Buffer.concat([
    Buffer.from(preamble, 'utf-8'),
    params.content,
    Buffer.from(epilogue, 'utf-8'),
  ]);

  const targetUrl = params.existingFileId
    ? `${DRIVE_UPLOAD_API}/files/${encodeURIComponent(
        params.existingFileId
      )}?uploadType=multipart&fields=id,name,webViewLink`
    : `${DRIVE_UPLOAD_API}/files?uploadType=multipart&fields=id,name,webViewLink`;

  const res = await fetch(targetUrl, {
    method: params.existingFileId ? 'PATCH' : 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body: bodyBuffer,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Error al subir "${safeName}" a Google Drive (HTTP ${res.status}): ${errText.slice(0, 200)}`);
  }

  const data = (await res.json()) as DriveFileMeta;
  return {
    id: data.id,
    name: data.name,
    webViewLink: data.webViewLink || `https://drive.google.com/file/d/${data.id}/view`,
  };
}

export async function listDriveFolderChildren(
  accessToken: string,
  folderId: string
): Promise<DriveFileMeta[]> {
  const query = `'${escapeDriveQuery(folderId)}' in parents and trashed = false`;
  const url = `${DRIVE_API}/files?q=${encodeURIComponent(
    query
  )}&fields=files(id,name,mimeType,webViewLink)&orderBy=folder,name&pageSize=100`;
  const res = await driveJsonFetch<{ files?: DriveFileMeta[] }>(url, accessToken);
  return res.files ?? [];
}

export function buildConflictKey(folderId: string, fileName: string): string {
  return `${folderId}::${sanitizeFileName(fileName)}`;
}

export async function syncFileSafely(
  accessToken: string,
  params: {
    folderId: string;
    fileName: string;
    mimeType: string;
    content: Buffer;
    courseId: string;
    courseName: string;
    taskId?: string;
    taskTitle?: string;
    autoOverwrite?: boolean;
    isOverwriteConfirmed?: (key: string) => boolean;
  }
): Promise<
  | { uploaded: true; fileId: string; webViewLink: string; name: string }
  | { uploaded: false; conflict: DriveConflictItem }
> {
  const existing = await findDriveFileInFolder(accessToken, params.folderId, params.fileName);
  const key = buildConflictKey(params.folderId, params.fileName);

  const canOverwrite =
    Boolean(params.autoOverwrite) || Boolean(params.isOverwriteConfirmed?.(key));

  if (existing && !canOverwrite) {
    return {
      uploaded: false,
      conflict: {
        key,
        taskId: params.taskId,
        courseId: params.courseId,
        courseName: params.courseName,
        taskTitle: params.taskTitle,
        folderId: params.folderId,
        existingFileId: existing.id,
        fileName: existing.name,
        mimeType: params.mimeType,
        reason: 'El archivo ya existe en Google Drive y requiere confirmación para actualizarse.',
      },
    };
  }

  const uploaded = await uploadFileToDrive(accessToken, {
    folderId: params.folderId,
    fileName: params.fileName,
    mimeType: params.mimeType,
    content: params.content,
    existingFileId: existing?.id,
  });

  return {
    uploaded: true,
    fileId: uploaded.id,
    webViewLink: uploaded.webViewLink,
    name: uploaded.name,
  };
}
