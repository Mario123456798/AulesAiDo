import React, { useEffect, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  Loader2,
  PauseCircle,
  Play,
  RefreshCw,
  Square,
} from 'lucide-react';
import type { PipelineRun, PipelineStageState } from '../types';

interface ProcessLiveViewProps {
  isGoogleSignedIn: boolean;
  hasDriveToken: boolean;
  aulesConnected: boolean;
  groqConfigured: boolean;
  selectedModel: string;
  autoSyncEnabled: boolean;
  autoSyncIntervalMinutes: number;
  currentRun: PipelineRun | null;
  totalCourses: number;
  totalTasks: number;
  referenceTasks?: number;
  noSubmissionTasks?: number;
  solvedTasks: number;
  syncedTasks: number;
  onStartRun: (options?: { mode?: 'full' | 'pending_only'; forceRegenerate?: boolean }) => void;
  onCancelRun: (runId: string) => void;
  onOpenConnections: () => void;
  onRefreshDriveToken: () => void;
  onOpenDriveConfirm: () => void;
  onToggleAutoSync: (enabled: boolean) => void;
}

const DEFAULT_STAGES: PipelineStageState[] = [
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

function formatDuration(startedAt: string, finishedAt?: string, nowMs?: number): string {
  const start = new Date(startedAt).getTime();
  const end = finishedAt ? new Date(finishedAt).getTime() : nowMs ?? Date.now();
  const diffSec = Math.max(0, Math.floor((end - start) / 1000));
  const mins = Math.floor(diffSec / 60);
  const secs = diffSec % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function formatLogTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString('es-ES', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export const ProcessLiveView: React.FC<ProcessLiveViewProps> = ({
  isGoogleSignedIn,
  hasDriveToken,
  aulesConnected,
  groqConfigured,
  selectedModel,
  autoSyncEnabled,
  autoSyncIntervalMinutes,
  currentRun,
  totalCourses,
  totalTasks,
  referenceTasks = 0,
  noSubmissionTasks = 0,
  solvedTasks,
  syncedTasks,
  onStartRun,
  onCancelRun,
  onOpenConnections,
  onRefreshDriveToken,
  onOpenDriveConfirm,
  onToggleAutoSync,
}) => {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const isRunning = currentRun?.status === 'running';

  useEffect(() => {
    if (!isRunning) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [isRunning]);

  const stages = currentRun?.stages || DEFAULT_STAGES;
  const progress = currentRun?.overallProgress ?? 0;
  const canRunPending = isGoogleSignedIn && groqConfigured && totalTasks > 0;
  const readyToRun = isGoogleSignedIn && aulesConnected && groqConfigured;
  const pendingCount = Math.max(0, totalTasks - syncedTasks);

  const renderStageIcon = (status: PipelineStageState['status']) => {
    switch (status) {
      case 'completed':
        return <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-600" />;
      case 'active':
        return <Loader2 className="h-5 w-5 shrink-0 animate-spin text-blue-600" />;
      case 'paused':
        return <PauseCircle className="h-5 w-5 shrink-0 text-amber-600" />;
      case 'error':
        return <AlertCircle className="h-5 w-5 shrink-0 text-red-600" />;
      default:
        return <Clock className="h-5 w-5 shrink-0 text-slate-300" />;
    }
  };

  const statusText = (status: PipelineRun['status'] | undefined) => {
    switch (status) {
      case 'running':
        return 'En ejecución';
      case 'awaiting_confirmation':
        return 'Confirmación pendiente en Drive';
      case 'completed':
        return 'Completado';
      case 'cancelled':
        return 'Cancelado';
      case 'error':
        return 'Detenido por error';
      default:
        return 'En espera';
    }
  };

  return (
    <div className="space-y-8">
      {/* Top KPI summary strip */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <p className="text-xs font-medium text-slate-500">Asignaturas detectadas</p>
          <p className="mt-2 font-mono text-2xl font-semibold text-slate-900 tabular-nums">
            {totalCourses}
          </p>
          <p className="mt-1 text-xs text-slate-500">Conectadas desde Aules</p>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <p className="text-xs font-medium text-slate-500">Tareas sin hacer resueltas</p>
          <p className="mt-2 font-mono text-2xl font-semibold text-slate-900 tabular-nums">
            {solvedTasks} / {totalTasks}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            {referenceTasks > 0 || noSubmissionTasks > 0
              ? [
                  referenceTasks > 0 ? `${referenceTasks} hechas (ref.)` : '',
                  noSubmissionTasks > 0 ? `${noSubmissionTasks} sin entrega online` : '',
                ]
                  .filter(Boolean)
                  .join(' · ')
              : 'Solo resuelve las entregables sin hacer'}
          </p>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <p className="text-xs font-medium text-slate-500">Sincronizadas en Drive</p>
          <p className="mt-2 font-mono text-2xl font-semibold text-slate-900 tabular-nums">
            {syncedTasks} / {totalTasks}
          </p>
          <p className="mt-1 text-xs text-slate-500">Carpeta Aules Sync (HTML/PDF/DOCX)</p>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <p className="text-xs font-medium text-slate-500">Sincronización automática</p>
          <div className="mt-2 flex items-center justify-between gap-2">
            <span className="font-mono text-base font-semibold text-slate-900 tabular-nums">
              {autoSyncEnabled ? `Cada ${autoSyncIntervalMinutes} min` : 'Manual'}
            </span>
            <button
              type="button"
              onClick={() => onToggleAutoSync(!autoSyncEnabled)}
              disabled={!isGoogleSignedIn}
              className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap shrink-0"
            >
              {autoSyncEnabled ? 'Pausar auto' : 'Activar auto'}
            </button>
          </div>
          <p className="mt-1 truncate text-xs text-slate-500">{selectedModel}</p>
        </div>
      </div>

      {/* Prerequisite readiness notice when not fully connected */}
      {!readyToRun && (
        <div className="rounded-xl border border-slate-200 bg-white p-6">
          <div className="flex flex-col justify-between gap-4 md:flex-row md:items-center">
            <div>
              <h2 className="text-base font-semibold text-slate-900">
                Prepara las conexiones para iniciar el agente
              </h2>
              <p className="mt-1 text-sm text-slate-600">
                Verifica los tres requisitos para que el agente pueda descargar tus tareas de Aules,
                aprender con Groq y subir los resultados a Google Drive.
              </p>
            </div>
            <button
              type="button"
              onClick={onOpenConnections}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 whitespace-nowrap shrink-0"
            >
              Configurar conexiones
            </button>
          </div>

          <div className="mt-5 grid grid-cols-1 gap-4 border-t border-slate-200 pt-5 md:grid-cols-3">
            <div className="flex items-start gap-2.5">
              {isGoogleSignedIn ? (
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
              ) : (
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
              )}
              <div>
                <p className="text-sm font-medium text-slate-900">Google Drive</p>
                <p className="text-xs text-slate-500">
                  {isGoogleSignedIn && hasDriveToken
                    ? 'Autorizado correctamente'
                    : isGoogleSignedIn
                    ? 'Sesión guardada (se autoriza al ejecutar)'
                    : 'Pendiente de iniciar sesión con Google'}
                </p>
                {isGoogleSignedIn && !hasDriveToken && (
                  <button
                    type="button"
                    onClick={onRefreshDriveToken}
                    className="mt-1 text-xs font-medium text-blue-600 hover:underline"
                  >
                    Autorizar Drive ahora
                  </button>
                )}
              </div>
            </div>

            <div className="flex items-start gap-2.5">
              {aulesConnected ? (
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
              ) : (
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
              )}
              <div>
                <p className="text-sm font-medium text-slate-900">Portal Aules</p>
                <p className="text-xs text-slate-500">
                  {aulesConnected
                    ? 'Sesión de estudiante activa'
                    : 'Introduce tus credenciales web de Aules'}
                </p>
              </div>
            </div>

            <div className="flex items-start gap-2.5">
              {groqConfigured ? (
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
              ) : (
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />
              )}
              <div>
                <p className="text-sm font-medium text-slate-900">API de Groq</p>
                <p className="text-xs text-slate-500">
                  {groqConfigured
                    ? 'Configurada en el servidor'
                    : 'Añade GROQ_API_KEY en Secretos'}
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Pending Drive Overwrite Banner */}
      {currentRun?.status === 'awaiting_confirmation' &&
        currentRun.pendingConfirmations.length > 0 && (
          <div className="flex flex-col justify-between gap-4 rounded-xl border border-amber-300 bg-amber-50 p-5 md:flex-row md:items-center">
            <div>
              <p className="text-sm font-semibold text-slate-900">
                Confirmación necesaria para sobrescribir {currentRun.pendingConfirmations.length}{' '}
                archivo(s) en Google Drive
              </p>
              <p className="mt-0.5 text-sm text-slate-700">
                La sincronización se pausó de forma segura antes de reemplazar archivos existentes.
              </p>
            </div>
            <button
              type="button"
              onClick={onOpenDriveConfirm}
              className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-slate-800 whitespace-nowrap shrink-0"
            >
              Revisar y confirmar
            </button>
          </div>
        )}

      {/* Main Live Process Tracker & Stage Stepper */}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-12">
        <section className="xl:col-span-7 rounded-xl border border-slate-200 bg-white">
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 px-6 py-5">
            <div>
              <div className="flex items-center gap-2 text-xs font-medium text-slate-500">
                <span>Estado actual: {statusText(currentRun?.status)}</span>
                {currentRun?.startedAt && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span className="font-mono tabular-nums">
                      Duración {formatDuration(currentRun.startedAt, currentRun.finishedAt, nowMs)}
                    </span>
                  </>
                )}
              </div>
              <h2 className="mt-1 text-lg font-semibold text-slate-900">
                Progreso del Agente en Tiempo Real
              </h2>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {isRunning && currentRun ? (
                <button
                  type="button"
                  onClick={() => onCancelRun(currentRun.id)}
                  className="inline-flex items-center gap-2 rounded-lg border border-red-300 bg-white px-3.5 py-2 text-sm font-medium text-red-700 transition-colors hover:bg-red-50 whitespace-nowrap shrink-0"
                >
                  <Square className="h-3.5 w-3.5" />
                  Detener
                </button>
              ) : (
                <>
                  {canRunPending && pendingCount > 0 && (
                    <button
                      type="button"
                      onClick={() => onStartRun({ mode: 'pending_only', forceRegenerate: false })}
                      className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 whitespace-nowrap shrink-0"
                    >
                      <Play className="h-4 w-4" />
                      Hacer no hechas y subir a Drive ({pendingCount})
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => onStartRun({ mode: 'full', forceRegenerate: false })}
                    disabled={!readyToRun}
                    className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 whitespace-nowrap shrink-0 ${
                      canRunPending && pendingCount > 0
                        ? 'border border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
                        : 'bg-blue-600 text-white hover:bg-blue-700'
                    }`}
                  >
                    <Play className="h-4 w-4" />
                    Ejecutar ciclo completo
                  </button>
                  <button
                    type="button"
                    onClick={() => onStartRun({ mode: 'full', forceRegenerate: true })}
                    disabled={!readyToRun}
                    title="Volver a analizar y resolver todas las tareas"
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 whitespace-nowrap shrink-0"
                  >
                    <RefreshCw className="h-4 w-4" />
                    Reprocesar todo
                  </button>
                </>
              )}
            </div>
          </div>

          {/* Progress bar */}
          <div className="border-b border-slate-200 bg-slate-50/70 px-6 py-4">
            <div className="flex items-center justify-between gap-4 text-sm">
              <span className="truncate font-medium text-slate-700">
                {currentRun?.currentItemLabel || 'Listo para conectar con Aules y comenzar el análisis'}
              </span>
              <span className="font-mono font-semibold text-slate-900 tabular-nums shrink-0">
                {progress}%
              </span>
            </div>
            <div className="mt-2.5 h-2 w-full overflow-hidden rounded-full bg-slate-200">
              <div
                className={`h-full transition-all duration-300 ${
                  currentRun?.status === 'error'
                    ? 'bg-red-600'
                    : currentRun?.status === 'completed'
                    ? 'bg-emerald-600'
                    : 'bg-blue-600'
                }`}
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>

          {/* 6-Stage Stepper */}
          <ol className="divide-y divide-slate-100">
            {stages.map((stage) => {
              const isCurrent =
                currentRun?.status === 'running' && currentRun.currentStage === stage.index;
              return (
                <li
                  key={stage.index}
                  className={`flex items-start gap-4 px-6 py-4 transition-colors ${
                    isCurrent ? 'bg-blue-50/40' : ''
                  }`}
                >
                  <div className="mt-0.5">{renderStageIcon(stage.status)}</div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-sm font-semibold text-slate-900">
                        0{stage.index}. {stage.title}
                      </p>
                      <span className="font-mono text-xs text-slate-500 tabular-nums shrink-0">
                        {stage.totalItems > 0
                          ? `${stage.completedItems} / ${stage.totalItems}`
                          : stage.status === 'completed'
                          ? 'Listo'
                          : 'Pendiente'}
                      </span>
                    </div>
                    <p className="mt-0.5 text-sm text-slate-600">{stage.description}</p>
                  </div>
                </li>
              );
            })}
          </ol>
        </section>

        {/* Real-time Server Log Stream */}
        <section className="xl:col-span-5 flex flex-col rounded-xl border border-slate-200 bg-white">
          <div className="flex items-center justify-between border-b border-slate-200 px-6 py-5">
            <div>
              <h2 className="text-lg font-semibold text-slate-900">Registro de Actividad</h2>
              <p className="mt-0.5 text-xs text-slate-500">
                Eventos transmitidos en vivo desde el servidor
              </p>
            </div>
            <span className="font-mono text-xs text-slate-500 tabular-nums">
              {currentRun?.logs.length ?? 0} eventos
            </span>
          </div>

          <div className="flex-1 max-h-[540px] overflow-y-auto divide-y divide-slate-100 px-6 py-2">
            {!currentRun || currentRun.logs.length === 0 ? (
              <div className="flex h-64 flex-col items-center justify-center text-center">
                <p className="text-sm font-medium text-slate-700">
                  Aún no hay actividad registrada
                </p>
                <p className="mt-1 max-w-xs text-xs text-slate-500">
                  Cuando ejecutes el agente verás aquí cada documento descargado, concepto aprendido y
                  archivo subido a Google Drive.
                </p>
              </div>
            ) : (
              [...currentRun.logs].reverse().map((log) => (
                <div key={log.id} className="py-3 text-sm">
                  <div className="flex items-center gap-2 font-mono text-xs text-slate-500 tabular-nums">
                    <span>{formatLogTime(log.timestamp)}</span>
                    <span aria-hidden="true">·</span>
                    <span>Etapa 0{log.stage}</span>
                    <span aria-hidden="true">·</span>
                    <span
                      className={
                        log.level === 'error'
                          ? 'font-medium text-red-600'
                          : log.level === 'warning'
                          ? 'font-medium text-amber-600'
                          : log.level === 'success'
                          ? 'font-medium text-emerald-600'
                          : 'text-slate-600'
                      }
                    >
                      {log.level === 'error'
                        ? 'Error'
                        : log.level === 'warning'
                        ? 'Aviso'
                        : log.level === 'success'
                        ? 'Completado'
                        : 'Proceso'}
                    </span>
                  </div>
                  <p className="mt-1 text-slate-800">{log.message}</p>
                  {log.detail && <p className="mt-0.5 text-xs text-slate-500">{log.detail}</p>}
                </div>
              ))
            )}
          </div>
        </section>
      </div>
    </div>
  );
};
