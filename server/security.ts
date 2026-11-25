import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

interface FirebaseConfigFile {
  projectId: string;
}

const configPath = path.resolve(process.cwd(), 'firebase-applet-config.json');
let cachedProjectId: string | null = null;

function getFirebaseProjectId(): string {
  if (cachedProjectId) return cachedProjectId;
  const raw = fs.readFileSync(configPath, 'utf-8');
  const parsed = JSON.parse(raw) as FirebaseConfigFile;
  cachedProjectId = parsed.projectId;
  return cachedProjectId;
}

let cachedCerts: Record<string, string> = {};
let certsExpiresAt = 0;

async function getGooglePublicCerts(): Promise<Record<string, string>> {
  const now = Date.now();
  if (now < certsExpiresAt && Object.keys(cachedCerts).length > 0) {
    return cachedCerts;
  }

  const res = await fetch(
    'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com'
  );
  if (!res.ok) {
    throw new Error('No se pudieron obtener las claves de verificación de Firebase');
  }

  const cacheControl = res.headers.get('cache-control') || '';
  const maxAgeMatch = cacheControl.match(/max-age=(\d+)/i);
  const maxAgeSeconds = maxAgeMatch ? Number(maxAgeMatch[1]) : 3600;
  certsExpiresAt = now + maxAgeSeconds * 1000;
  cachedCerts = (await res.json()) as Record<string, string>;
  return cachedCerts;
}

function decodeBase64Url(segment: string): Buffer {
  const normalized = segment.replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (normalized.length % 4)) % 4;
  return Buffer.from(normalized + '='.repeat(padLen), 'base64');
}

export interface AuthenticatedUser {
  uid: string;
  email: string;
}

export async function verifyFirebaseIdToken(token: string): Promise<AuthenticatedUser> {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('Token de autenticación inválido');
  }

  const [headerB64, payloadB64, signatureB64] = parts;
  const header = JSON.parse(decodeBase64Url(headerB64).toString('utf-8')) as {
    alg?: string;
    kid?: string;
  };
  const payload = JSON.parse(decodeBase64Url(payloadB64).toString('utf-8')) as {
    aud?: string;
    iss?: string;
    sub?: string;
    exp?: number;
    iat?: number;
    email?: string;
  };

  if (header.alg !== 'RS256' || !header.kid) {
    throw new Error('Cabecera de token no válida');
  }

  const projectId = getFirebaseProjectId();
  const expectedIssuer = `https://securetoken.google.com/${projectId}`;
  const nowSec = Math.floor(Date.now() / 1000);

  if (payload.aud !== projectId) {
    throw new Error('Audiencia de token no válida');
  }
  if (payload.iss !== expectedIssuer) {
    throw new Error('Emisor de token no válido');
  }
  if (!payload.sub || typeof payload.sub !== 'string') {
    throw new Error('Usuario de token no válido');
  }
  if (!payload.exp || payload.exp <= nowSec) {
    throw new Error('La sesión ha expirado, vuelve a iniciar sesión con Google');
  }

  const certs = await getGooglePublicCerts();
  const cert = certs[header.kid];
  if (!cert) {
    throw new Error('Certificado de verificación no encontrado');
  }

  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(`${headerB64}.${payloadB64}`);
  verifier.end();

  const signature = decodeBase64Url(signatureB64);
  const isValid = verifier.verify(cert, signature);
  if (!isValid) {
    throw new Error('Firma de token no válida');
  }

  return {
    uid: payload.sub,
    email: typeof payload.email === 'string' ? payload.email : '',
  };
}

function isPrivateOrLoopbackHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (
    lower === 'localhost' ||
    lower === 'metadata.google.internal' ||
    lower.endsWith('.local') ||
    lower.endsWith('.internal') ||
    lower === '::1' ||
    lower === '[::1]'
  ) {
    return true;
  }

  const ipType = net.isIP(lower);
  if (ipType === 4) {
    const octets = lower.split('.').map(Number);
    const [a, b] = octets;
    if (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    ) {
      return true;
    }
  }

  if (ipType === 6) {
    if (lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd') || lower === '::1') {
      return true;
    }
  }

  return false;
}

export function validateAulesBaseUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    throw new Error('Debes indicar la URL de tu portal Aules o Moodle');
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('La URL de Aules no tiene un formato válido (ej. https://aules.edu.gva.es/fp/)');
  }

  if (parsed.protocol !== 'https:') {
    throw new Error('Por seguridad, la URL de Aules debe usar HTTPS');
  }

  if (isPrivateOrLoopbackHost(parsed.hostname)) {
    throw new Error('La URL indicada apunta a una dirección privada no permitida');
  }

  // Strip trailing /login/index.php or trailing slash cleanly
  let cleanPath = parsed.pathname.replace(/\/login\/index\.php.*$/i, '');
  cleanPath = cleanPath.replace(/\/+$/, '');
  return `${parsed.origin}${cleanPath}`;
}

export function assertSameOriginAulesUrl(targetUrl: string, baseUrl: string): URL {
  const base = new URL(baseUrl);
  const target = new URL(targetUrl, baseUrl);
  if (target.protocol !== 'https:' || target.origin !== base.origin) {
    throw new Error('Enlace fuera del dominio autorizado de Aules');
  }
  if (isPrivateOrLoopbackHost(target.hostname)) {
    throw new Error('Destino de red no permitido');
  }
  return target;
}

export function sanitizeFileName(name: string): string {
  return name
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140) || 'archivo';
}

export function resolveConfinedPath(baseDir: string, relativeName: string): string {
  const resolvedBase = path.resolve(baseDir);
  const safeName = relativeName.replace(/[^a-zA-Z0-9._-]/g, '_');
  const resolvedTarget = path.resolve(resolvedBase, safeName);
  if (!resolvedTarget.startsWith(resolvedBase + path.sep)) {
    throw new Error('Ruta de archivo fuera del directorio permitido');
  }
  return resolvedTarget;
}

const EPHEMERAL_FALLBACK_KEY = crypto.randomBytes(32);

function getServerEncryptionKey(): Buffer {
  const secretSource =
    process.env.AULES_SESSION_SECRET?.trim() ||
    process.env.GROQ_API_KEY?.trim();
  if (!secretSource) {
    return EPHEMERAL_FALLBACK_KEY;
  }
  return crypto.createHash('sha256').update(`aules-session:${secretSource}`).digest();
}

export function encryptServerData(plainText: string): string {
  const key = getServerEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64url')}.${tag.toString('base64url')}.${encrypted.toString('base64url')}`;
}

export function decryptServerData(payload: string): string | null {
  try {
    const parts = payload.split('.');
    if (parts.length !== 3) return null;
    const [ivB64, tagB64, dataB64] = parts;
    const key = getServerEncryptionKey();
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(ivB64, 'base64url')
    );
    decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(dataB64, 'base64url')),
      decipher.final(),
    ]);
    return decrypted.toString('utf8');
  } catch {
    return null;
  }
}
