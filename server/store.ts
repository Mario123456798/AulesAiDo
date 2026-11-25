import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_GROQ_MODEL, normalizeGroqModel } from './groqClient.ts';
import { decryptServerData, encryptServerData, resolveConfinedPath } from './security.ts';
import type { AulesSession, PipelineRun, UserAgentStore } from './types.ts';

const DATA_DIR = path.resolve(process.cwd(), '.data');
const ATTACHMENTS_DIR = path.resolve(DATA_DIR, 'attachments');

const aulesSessions = new Map<string, AulesSession>();
const activeRuns = new Map<string, PipelineRun>();
const runEmitters = new Map<string, EventEmitter>();
const cancelledRuns = new Set<string>();
const pendingDriveTokens = new Map<string, string>();
const confirmedOverwriteKeys = new Map<string, Set<string>>();

async function ensureDirs(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(ATTACHMENTS_DIR, { recursive: true });
}

function getUserStorePath(uid: string): string {
  const hash = crypto.createHash('sha256').update(uid).digest('hex').slice(0, 24);
  return resolveConfinedPath(DATA_DIR, `store_${hash}.json`);
}

function createEmptyStore(uid: string, email: string): UserAgentStore {
  return {
    uid,
    email,
    aulesProfile: null,
    selectedModel: DEFAULT_GROQ_MODEL,
    autoSyncEnabled: false,
    autoSyncIntervalMinutes: 30,
    driveRootFolderId: null,
    driveRootFolderLink: null,
    courses: [],
    tasks: [],
    knowledge: {},
    runs: [],
  };
}

export async function readUserStore(uid: string, email = ''): Promise<UserAgentStore> {
  await ensureDirs();
  const filePath = getUserStorePath(uid);
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as UserAgentStore;
    if (email && !parsed.email) {
      parsed.email = email;
    }
    parsed.selectedModel = normalizeGroqModel(parsed.selectedModel);
    return parsed;
  } catch {
    const empty = createEmptyStore(uid, email);
    await writeUserStore(empty);
    return empty;
  }
}

export async function writeUserStore(store: UserAgentStore): Promise<void> {
  await ensureDirs();
  const filePath = getUserStorePath(store.uid);
  const tmpPath = `${filePath}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(store, null, 2), 'utf-8');
  await fs.rename(tmpPath, filePath);
}

export function sanitizeStoreForClient(store: UserAgentStore): UserAgentStore {
  const { encryptedAulesSession: _hidden, ...safe } = store;
  return safe;
}

export async function saveAttachmentCache(
  uid: string,
  attachmentId: string,
  buffer: Buffer
): Promise<string> {
  await ensureDirs();
  const userHash = crypto.createHash('sha256').update(uid).digest('hex').slice(0, 16);
  const cacheKey = `${userHash}_${attachmentId.replace(/[^a-zA-Z0-9_-]/g, '_')}.bin`;
  const target = resolveConfinedPath(ATTACHMENTS_DIR, cacheKey);
  await fs.writeFile(target, buffer);
  return cacheKey;
}

export async function readAttachmentCache(cacheKey: string): Promise<Buffer | null> {
  try {
    const target = resolveConfinedPath(ATTACHMENTS_DIR, cacheKey);
    return await fs.readFile(target);
  } catch {
    return null;
  }
}

export async function setAulesSession(uid: string, session: AulesSession): Promise<void> {
  aulesSessions.set(uid, session);
  const store = await readUserStore(uid);
  store.encryptedAulesSession = encryptServerData(JSON.stringify(session));
  await writeUserStore(store);
}

export async function getOrRestoreAulesSession(uid: string): Promise<AulesSession | null> {
  const mem = aulesSessions.get(uid);
  if (mem) return mem;

  const store = await readUserStore(uid);
  if (!store.encryptedAulesSession) return null;

  const raw = decryptServerData(store.encryptedAulesSession);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as AulesSession;
    if (parsed && parsed.baseUrl && parsed.cookies) {
      aulesSessions.set(uid, parsed);
      return parsed;
    }
  } catch {
    // Ignore corrupt session
  }
  return null;
}

export function getAulesSession(uid: string): AulesSession | null {
  return aulesSessions.get(uid) ?? null;
}

export async function clearAulesSession(uid: string): Promise<void> {
  aulesSessions.delete(uid);
  const store = await readUserStore(uid);
  delete store.encryptedAulesSession;
  await writeUserStore(store);
}

export function registerRun(run: PipelineRun): EventEmitter {
  activeRuns.set(run.id, run);
  const emitter = new EventEmitter();
  runEmitters.set(run.id, emitter);
  return emitter;
}

export function getRun(runId: string): PipelineRun | null {
  return activeRuns.get(runId) ?? null;
}

export function getRunEmitter(runId: string): EventEmitter | null {
  return runEmitters.get(runId) ?? null;
}

export function markRunCancelled(runId: string): void {
  cancelledRuns.add(runId);
}

export function isRunCancelled(runId: string): boolean {
  return cancelledRuns.has(runId);
}

export function setRunDriveToken(runId: string, token: string): void {
  pendingDriveTokens.set(runId, token);
}

export function getRunDriveToken(runId: string): string | null {
  return pendingDriveTokens.get(runId) ?? null;
}

export function clearRunDriveToken(runId: string): void {
  pendingDriveTokens.delete(runId);
}

export function grantOverwriteConfirmation(runId: string, keys: string[]): void {
  const existing = confirmedOverwriteKeys.get(runId) ?? new Set<string>();
  for (const k of keys) existing.add(k);
  confirmedOverwriteKeys.set(runId, existing);
}

export function hasOverwriteConfirmation(runId: string, key: string): boolean {
  return confirmedOverwriteKeys.get(runId)?.has(key) ?? false;
}
