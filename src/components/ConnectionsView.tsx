import React, { useEffect, useState } from 'react';
import { CheckCircle2, AlertCircle, LogOut } from 'lucide-react';
import type { User } from 'firebase/auth';
import type { AiModelInfo, AulesProfile } from '../types';
import { GoogleSignInButton } from './GoogleSignInButton';

interface ConnectionsViewProps {
  googleUser: User | null;
  hasDriveToken: boolean;
  isLoggingIn: boolean;
  onGoogleLogin: () => void;
  onGoogleLogout: () => void;
  aulesConnected: boolean;
  aulesProfile: AulesProfile | null;
  onConnectAules: (payload: {
    baseUrl: string;
    username: string;
    password: string;
  }) => Promise<void>;
  onDisconnectAules: () => Promise<void>;
  groqConfigured: boolean;
  models: AiModelInfo[];
  selectedModel: string;
  autoSyncEnabled: boolean;
  autoSyncIntervalMinutes: number;
  onUpdateSettings: (payload: {
    selectedModel?: string;
    autoSyncEnabled?: boolean;
    autoSyncIntervalMinutes?: number;
  }) => Promise<void>;
}

const AULES_PORTAL_PRESETS = [
  { label: 'Aules FP (Formación Profesional)', url: 'https://aules.edu.gva.es/fp' },
  { label: 'Aules ESO', url: 'https://aules.edu.gva.es/eso' },
  { label: 'Aules Batxillerat', url: 'https://aules.edu.gva.es/batxillerat' },
  { label: 'Aules Semipresencial', url: 'https://aules.edu.gva.es/semipresencial' },
  { label: 'Aules Educació a Distància (ED)', url: 'https://aules.edu.gva.es/ed' },
  { label: 'Aules Especials / FPA', url: 'https://aules.edu.gva.es/fpa' },
];

export const ConnectionsView: React.FC<ConnectionsViewProps> = ({
  googleUser,
  hasDriveToken,
  isLoggingIn,
  onGoogleLogin,
  onGoogleLogout,
  aulesConnected,
  aulesProfile,
  onConnectAules,
  onDisconnectAules,
  groqConfigured,
  models,
  selectedModel,
  autoSyncEnabled,
  autoSyncIntervalMinutes,
  onUpdateSettings,
}) => {
  const [baseUrl, setBaseUrl] = useState(
    aulesProfile?.baseUrl || 'https://aules.edu.gva.es/fp'
  );
  const [username, setUsername] = useState(aulesProfile?.username || '');
  const [password, setPassword] = useState('');
  const [aulesBusy, setAulesBusy] = useState(false);
  const [aulesError, setAulesError] = useState<string | null>(null);
  const [aulesSuccess, setAulesSuccess] = useState<string | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);

  useEffect(() => {
    if (aulesProfile?.baseUrl) {
      setBaseUrl((prev) => prev || aulesProfile.baseUrl);
    }
    if (aulesProfile?.username) {
      setUsername((prev) => prev || aulesProfile.username);
    }
  }, [aulesProfile?.baseUrl, aulesProfile?.username]);

  const handleAulesSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setAulesBusy(true);
    setAulesError(null);
    setAulesSuccess(null);
    try {
      await onConnectAules({ baseUrl, username, password });
      setPassword('');
      setAulesSuccess('Sesión web iniciada correctamente en Aules.');
    } catch (err) {
      setAulesError(
        err instanceof Error ? err.message : 'No se pudo iniciar sesión en Aules.'
      );
    } finally {
      setAulesBusy(false);
    }
  };

  const handleDisconnect = async () => {
    setAulesBusy(true);
    setAulesError(null);
    setAulesSuccess(null);
    try {
      await onDisconnectAules();
    } finally {
      setAulesBusy(false);
    }
  };

  const handleModelChange = async (newModel: string) => {
    setSavingSettings(true);
    try {
      await onUpdateSettings({ selectedModel: newModel });
    } finally {
      setSavingSettings(false);
    }
  };

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
      {/* Aules Web Credentials */}
      <section className="lg:col-span-7 rounded-xl border border-slate-200 bg-white p-6">
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 pb-4">
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              1. Credenciales Web de Aules / Moodle
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              La conexión se realiza directamente contra tu portal Aules manteniendo la sesión
              cifrada de forma persistente sin almacenar tu contraseña en texto plano.
            </p>
          </div>
          {aulesConnected ? (
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-700 whitespace-nowrap shrink-0">
              <CheckCircle2 className="h-4 w-4" />
              Conectado
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-700 whitespace-nowrap shrink-0">
              <AlertCircle className="h-4 w-4" />
              Desconectado
            </span>
          )}
        </div>

        {aulesConnected && aulesProfile && (
          <div className="mt-5 flex flex-wrap items-center justify-between gap-4 rounded-lg border border-emerald-200 bg-emerald-50/70 px-4 py-3">
            <div>
              <p className="text-sm font-medium text-slate-900">{aulesProfile.fullName}</p>
              <p className="text-xs text-slate-600">
                {aulesProfile.username} · {aulesProfile.baseUrl}
              </p>
            </div>
            <button
              type="button"
              onClick={() => void handleDisconnect()}
              disabled={aulesBusy}
              className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              Cerrar sesión de Aules
            </button>
          </div>
        )}

        <form onSubmit={(e) => void handleAulesSubmit(e)} className="mt-5 space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-700">
              Selector rápido de portal Aules
            </label>
            <select
              value={
                AULES_PORTAL_PRESETS.some((p) => p.url === baseUrl) ? baseUrl : 'custom'
              }
              onChange={(e) => {
                if (e.target.value !== 'custom') setBaseUrl(e.target.value);
              }}
              className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-blue-600 focus:outline-none"
            >
              {AULES_PORTAL_PRESETS.map((p) => (
                <option key={p.url} value={p.url}>
                  {p.label}
                </option>
              ))}
              <option value="custom">Otra URL de Aules o Moodle...</option>
            </select>
          </div>

          <div>
            <label htmlFor="aules-url" className="block text-xs font-medium text-slate-700">
              URL del portal Aules / Moodle (HTTPS)
            </label>
            <input
              id="aules-url"
              type="url"
              required
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://aules.edu.gva.es/fp"
              className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none"
            />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="aules-user" className="block text-xs font-medium text-slate-700">
                Usuario / NIA
              </label>
              <input
                id="aules-user"
                type="text"
                required
                autoComplete="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="Tu usuario de Aules"
                className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none"
              />
            </div>

            <div>
              <label htmlFor="aules-pass" className="block text-xs font-medium text-slate-700">
                Contraseña de Aules
              </label>
              <input
                id="aules-pass"
                type="password"
                required
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none"
              />
            </div>
          </div>

          {aulesError && (
            <p className="rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5 text-sm text-red-700">
              {aulesError}
            </p>
          )}
          {aulesSuccess && (
            <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3.5 py-2.5 text-sm text-emerald-700">
              {aulesSuccess}
            </p>
          )}

          <div className="pt-2">
            <button
              type="submit"
              disabled={aulesBusy || !googleUser}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {aulesBusy
                ? 'Conectando con Aules...'
                : aulesConnected
                ? 'Renovar sesión de Aules'
                : 'Conectar con Aules'}
            </button>
            {!googleUser && (
              <p className="mt-2 text-xs text-slate-500">
                Inicia sesión primero con Google en el panel derecho para vincular tu sesión.
              </p>
            )}
          </div>
        </form>
      </section>

      {/* Google Drive + Groq Cloud Settings */}
      <div className="lg:col-span-5 space-y-6">
        <section className="rounded-xl border border-slate-200 bg-white p-6">
          <div className="flex items-start justify-between gap-3 border-b border-slate-200 pb-4">
            <div>
              <h2 className="text-base font-semibold text-slate-900">2. Cuenta de Google Drive</h2>
              <p className="mt-1 text-sm text-slate-600">
                Autoriza la creación de la carpeta Aules Sync y la subida automática de tus
                tareas.
              </p>
            </div>
            {googleUser && hasDriveToken ? (
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-700 whitespace-nowrap shrink-0">
                <CheckCircle2 className="h-4 w-4" />
                Activa
              </span>
            ) : googleUser ? (
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-blue-700 whitespace-nowrap shrink-0">
                <CheckCircle2 className="h-4 w-4" />
                Sesión guardada
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-700 whitespace-nowrap shrink-0">
                <AlertCircle className="h-4 w-4" />
                Pendiente
              </span>
            )}
          </div>

          <div className="mt-5 space-y-4">
            {googleUser ? (
              <>
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-slate-900">
                      {googleUser.displayName || 'Cuenta de Google'}
                    </p>
                    <p className="truncate text-xs text-slate-500">{googleUser.email}</p>
                  </div>
                  <button
                    type="button"
                    onClick={onGoogleLogout}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap shrink-0"
                  >
                    <LogOut className="h-3.5 w-3.5" />
                    Desconectar
                  </button>
                </div>
                {!hasDriveToken && (
                  <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50 px-3.5 py-2.5">
                    <p className="text-xs text-slate-600">
                      Tu cuenta sigue iniciada; autoriza el permiso temporal de Drive para explorar
                      o sincronizar al instante.
                    </p>
                    <button
                      type="button"
                      onClick={onGoogleLogin}
                      disabled={isLoggingIn}
                      className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50 whitespace-nowrap shrink-0"
                    >
                      {isLoggingIn ? 'Autorizando...' : 'Autorizar Drive'}
                    </button>
                  </div>
                )}
              </>
            ) : (
              <GoogleSignInButton onClick={onGoogleLogin} disabled={isLoggingIn} />
            )}
          </div>
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-6 space-y-4">
          <div className="flex items-start justify-between gap-3 border-b border-slate-200 pb-4">
            <div>
              <h2 className="text-base font-semibold text-slate-900">
                3. API de Groq Cloud y Sincronización
              </h2>
              <p className="mt-1 text-sm text-slate-600">
                La clave de Groq se lee de forma segura desde los secretos del servidor.
              </p>
            </div>
            {groqConfigured ? (
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-700 whitespace-nowrap shrink-0">
                <CheckCircle2 className="h-4 w-4" />
                Lista
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-red-700 whitespace-nowrap shrink-0">
                <AlertCircle className="h-4 w-4" />
                Sin configurar
              </span>
            )}
          </div>

          {!groqConfigured && (
            <p className="rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-xs text-amber-800">
              Configura la variable de entorno <code className="font-mono">GROQ_API_KEY</code> en el
              panel de Secretos para habilitar el aprendizaje y la resolución de tareas con Groq.
            </p>
          )}

          <div>
            <label htmlFor="groq-model" className="block text-xs font-medium text-slate-700">
              Modelo de Groq para análisis y deberes
            </label>
            <select
              id="groq-model"
              value={selectedModel}
              disabled={savingSettings || !googleUser}
              onChange={(e) => void handleModelChange(e.target.value)}
              className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-blue-600 focus:outline-none disabled:opacity-50"
            >
              {models.length === 0 ? (
                <option value={selectedModel}>{selectedModel}</option>
              ) : (
                models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))
              )}
            </select>
            <p className="mt-1.5 text-xs text-slate-500">
              Recomendado equilibrado: llama-3.3-70b-versatile. Razonamiento avanzado:
              openai/gpt-oss-120b.
            </p>
          </div>

          <div className="border-t border-slate-200 pt-4">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-medium text-slate-900">
                  Sincronización automática periódica
                </p>
                <p className="text-xs text-slate-500">
                  Ejecuta el agente automáticamente mientras esta aplicación esté abierta.
                </p>
              </div>
              <button
                type="button"
                disabled={savingSettings || !googleUser}
                onClick={() => void onUpdateSettings({ autoSyncEnabled: !autoSyncEnabled })}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                  autoSyncEnabled
                    ? 'bg-blue-600 text-white hover:bg-blue-700'
                    : 'border border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
                }`}
              >
                {autoSyncEnabled ? 'Activada' : 'Desactivada'}
              </button>
            </div>

            {autoSyncEnabled && (
              <div className="mt-3">
                <label
                  htmlFor="sync-interval"
                  className="block text-xs font-medium text-slate-700"
                >
                  Intervalo de comprobación
                </label>
                <select
                  id="sync-interval"
                  value={autoSyncIntervalMinutes}
                  onChange={(e) =>
                    void onUpdateSettings({ autoSyncIntervalMinutes: Number(e.target.value) })
                  }
                  className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900"
                >
                  <option value={15}>Cada 15 minutos</option>
                  <option value={30}>Cada 30 minutos</option>
                  <option value={60}>Cada 60 minutos</option>
                  <option value={120}>Cada 2 horas</option>
                </select>
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
};
