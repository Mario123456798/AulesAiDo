import { useCallback, useEffect, useRef, useState } from 'react';
import type { User } from 'firebase/auth';
import {
  Activity,
  BookOpen,
  ClipboardList,
  FolderSync,
  Menu,
  Play,
  PlugZap,
  Square,
  X,
} from 'lucide-react';
import { ConnectionsView } from './components/ConnectionsView';
import { DriveConfirmModal } from './components/DriveConfirmModal';
import { DriveExplorerView } from './components/DriveExplorerView';
import { GoogleSignInButton } from './components/GoogleSignInButton';
import { KnowledgeView } from './components/KnowledgeView';
import { ProcessLiveView } from './components/ProcessLiveView';
import { TasksView } from './components/TasksView';
import {
  cancelPipelineRun,
  confirmDriveOverwrites,
  connectAulesAccount,
  deleteTaskAttachment,
  disconnectAulesAccount,
  fetchAiModels,
  fetchPublicConfigStatus,
  fetchWorkspaceState,
  solveSingleTask,
  startPipelineRun,
  subscribeToRunStream,
  syncSingleTaskToDrive,
  updateAgentSettings,
  updateTaskExportFormats,
  uploadTaskAttachment,
} from './lib/api';
import {
  ensureDriveAccessToken,
  getDriveAccessToken,
  googleSignIn,
  initAuth,
  logoutGoogle,
} from './lib/firebaseAuth';
import {
  isTaskActionableTodo,
  isTaskDoneInAules,
  isTaskNoSubmissionInAules,
} from './lib/taskUtils';
import type {
  AiModelInfo,
  DeliverableFormat,
  DriveConflictItem,
  PipelineRun,
  UserAgentStore,
} from './types';

type ActiveSection = 'process' | 'tasks' | 'knowledge' | 'drive' | 'connections';

const SECTION_META: Record<ActiveSection, { title: string; breadcrumb: string }> = {
  process: { title: 'Proceso en Vivo', breadcrumb: 'Proceso en Vivo' },
  tasks: { title: 'Asignaturas y Tareas', breadcrumb: 'Asignaturas y Tareas' },
  knowledge: { title: 'Base de Aprendizaje', breadcrumb: 'Base de Aprendizaje' },
  drive: { title: 'Google Drive', breadcrumb: 'Google Drive' },
  connections: { title: 'Conexiones', breadcrumb: 'Conexiones' },
};

export default function App() {
  const [activeSection, setActiveSection] = useState<ActiveSection>('process');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const [authReady, setAuthReady] = useState(false);
  const [googleUser, setGoogleUser] = useState<User | null>(null);
  const [hasDriveToken, setHasDriveToken] = useState(false);
  const [isLoggingIn, setIsLoggingIn] = useState(false);

  const [groqConfigured, setGroqConfigured] = useState(false);
  const [aulesConnected, setAulesConnected] = useState(false);
  const [store, setStore] = useState<UserAgentStore | null>(null);
  const [currentRun, setCurrentRun] = useState<PipelineRun | null>(null);
  const [models, setModels] = useState<AiModelInfo[]>([]);

  const [bannerError, setBannerError] = useState<string | null>(null);
  const [bannerNotice, setBannerNotice] = useState<string | null>(null);

  // Drive confirmation modal state (either from pipeline run or single task sync)
  const [confirmModalState, setConfirmModalState] = useState<{
    source: 'run' | 'task';
    runId?: string;
    taskId?: string;
    conflicts: DriveConflictItem[];
  } | null>(null);
  const [isConfirmingDrive, setIsConfirmingDrive] = useState(false);

  const unsubscribeStreamRef = useRef<(() => void) | null>(null);

  const loadWorkspace = useCallback(async () => {
    try {
      const [ws, modelsRes] = await Promise.all([
        fetchWorkspaceState(),
        fetchAiModels().catch(() => ({ models: [] })),
      ]);
      setStore(ws.store);
      setAulesConnected(ws.aulesConnected);
      setGroqConfigured(ws.groqConfigured);
      if (ws.latestRun) {
        setCurrentRun(ws.latestRun);
        if (ws.latestRun.status === 'running') {
          unsubscribeStreamRef.current?.();
          unsubscribeStreamRef.current = subscribeToRunStream(
            ws.latestRun.id,
            (updated) => {
              setCurrentRun(updated);
              if (updated.status === 'completed' || updated.status === 'awaiting_confirmation') {
                void fetchWorkspaceState().then((fresh) => setStore(fresh.store));
              }
            },
            (msg) => setBannerError(msg)
          );
        }
      }
      if (modelsRes.models.length > 0) {
        setModels(modelsRes.models);
      }
    } catch (err) {
      setBannerError(err instanceof Error ? err.message : 'No se pudo cargar el espacio de trabajo.');
    }
  }, []);

  useEffect(() => {
    void fetchPublicConfigStatus().then((s) => setGroqConfigured(s.groqConfigured));

    const unsubscribe = initAuth(
      (user) => {
        setAuthReady(true);
        setGoogleUser(user);
        setHasDriveToken(Boolean(getDriveAccessToken()));
        void loadWorkspace();
      },
      (user) => {
        setAuthReady(true);
        setGoogleUser(user);
        setHasDriveToken(false);
        if (user) {
          void loadWorkspace();
        } else {
          setStore(null);
          setCurrentRun(null);
          setAulesConnected(false);
        }
      }
    );

    return () => {
      unsubscribe();
      unsubscribeStreamRef.current?.();
    };
  }, [loadWorkspace]);

  const handleGoogleLogin = async () => {
    setIsLoggingIn(true);
    setBannerError(null);
    try {
      const res = await googleSignIn();
      if (res) {
        setGoogleUser(res.user);
        setHasDriveToken(Boolean(res.accessToken));
        await loadWorkspace();
      }
    } catch (err) {
      setBannerError(err instanceof Error ? err.message : 'Error al iniciar sesión con Google.');
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleGoogleLogout = async () => {
    await logoutGoogle();
    setGoogleUser(null);
    setHasDriveToken(false);
    setStore(null);
    setCurrentRun(null);
    setAulesConnected(false);
  };

  const handleStartRun = useCallback(
    async (options?: { mode?: 'full' | 'pending_only'; forceRegenerate?: boolean }) => {
      setBannerError(null);
      setBannerNotice(null);
      try {
        if (!getDriveAccessToken()) {
          const refreshed = await ensureDriveAccessToken();
          if (refreshed) {
            setGoogleUser(refreshed.user);
            setHasDriveToken(Boolean(refreshed.accessToken));
          }
        }
        const { run } = await startPipelineRun({
          mode: options?.mode || 'full',
          forceRegenerate: options?.forceRegenerate || false,
        });
        setCurrentRun(run);
        setActiveSection('process');
        unsubscribeStreamRef.current?.();
        unsubscribeStreamRef.current = subscribeToRunStream(
          run.id,
          (updated) => {
            setCurrentRun(updated);
            if (updated.status === 'awaiting_confirmation' && updated.pendingConfirmations.length > 0) {
              setConfirmModalState({
                source: 'run',
                runId: updated.id,
                conflicts: updated.pendingConfirmations,
              });
            }
            if (updated.status === 'completed') {
              void fetchWorkspaceState().then((fresh) => setStore(fresh.store));
              setBannerNotice('Ciclo completado y sincronizado en Google Drive.');
            }
          },
          (msg) => setBannerError(msg)
        );
      } catch (err) {
        setBannerError(err instanceof Error ? err.message : 'No se pudo iniciar el agente.');
      }
    },
    []
  );

  // Automatic background synchronization while tab is open
  useEffect(() => {
    if (
      !store?.autoSyncEnabled ||
      !aulesConnected ||
      !hasDriveToken ||
      !groqConfigured ||
      currentRun?.status === 'running'
    ) {
      return;
    }

    const intervalMs = Math.max(5, store.autoSyncIntervalMinutes || 30) * 60 * 1000;
    const timer = window.setInterval(() => {
      void handleStartRun({ mode: 'full', forceRegenerate: false });
    }, intervalMs);

    return () => window.clearInterval(timer);
  }, [
    store?.autoSyncEnabled,
    store?.autoSyncIntervalMinutes,
    aulesConnected,
    hasDriveToken,
    groqConfigured,
    currentRun?.status,
    handleStartRun,
  ]);

  const handleCancelRun = async (runId: string) => {
    await cancelPipelineRun(runId);
  };

  const handleConnectAules = async (payload: {
    baseUrl: string;
    username: string;
    password: string;
  }) => {
    await connectAulesAccount(payload);
    await loadWorkspace();
  };

  const handleDisconnectAules = async () => {
    await disconnectAulesAccount();
    setAulesConnected(false);
  };

  const handleUpdateSettings = async (payload: {
    selectedModel?: string;
    autoSyncEnabled?: boolean;
    autoSyncIntervalMinutes?: number;
  }) => {
    const res = await updateAgentSettings(payload);
    setStore(res.store);
  };

  const handleSolveTask = async (taskId: string) => {
    setBannerError(null);
    const res = await solveSingleTask(taskId, store?.selectedModel);
    setStore((prev) =>
      prev
        ? {
            ...prev,
            tasks: prev.tasks.map((t) => (t.id === res.task.id ? res.task : t)),
          }
        : prev
    );
    const ctxSources = res.task.deliverables?.contextSourcesUsed;
    setBannerNotice(
      ctxSources && ctxSources.length > 0
        ? `Deberes actualizados para "${res.task.title}" (contexto: ${ctxSources.join(', ')}).`
        : `Deberes y apuntes actualizados para "${res.task.title}".`
    );
  };

  const handleUploadAttachment = async (taskId: string, file: File) => {
    setBannerError(null);
    const res = await uploadTaskAttachment(taskId, file);
    setStore((prev) =>
      prev
        ? {
            ...prev,
            tasks: prev.tasks.map((t) => (t.id === res.task.id ? res.task : t)),
          }
        : prev
    );
    setBannerNotice(`Archivo "${res.attachment.name}" adjuntado a "${res.task.title}".`);
  };

  const handleDeleteAttachment = async (taskId: string, attId: string) => {
    setBannerError(null);
    const res = await deleteTaskAttachment(taskId, attId);
    setStore((prev) =>
      prev
        ? {
            ...prev,
            tasks: prev.tasks.map((t) => (t.id === res.task.id ? res.task : t)),
          }
        : prev
    );
    setBannerNotice('Adjunto eliminado.');
  };

  const handleUpdateExportFormats = async (taskId: string, formats: DeliverableFormat[]) => {
    setBannerError(null);
    const res = await updateTaskExportFormats(taskId, formats);
    setStore((prev) =>
      prev
        ? {
            ...prev,
            tasks: prev.tasks.map((t) => (t.id === res.task.id ? res.task : t)),
          }
        : prev
    );
  };

  const handleSyncTask = async (taskId: string) => {
    setBannerError(null);
    if (!getDriveAccessToken()) {
      const refreshed = await ensureDriveAccessToken();
      if (refreshed) {
        setGoogleUser(refreshed.user);
        setHasDriveToken(Boolean(refreshed.accessToken));
      }
    }
    const res = await syncSingleTaskToDrive(taskId);
    setStore((prev) =>
      prev
        ? {
            ...prev,
            tasks: prev.tasks.map((t) => (t.id === res.task.id ? res.task : t)),
          }
        : prev
    );
    if (res.conflicts.length > 0) {
      setConfirmModalState({
        source: 'task',
        taskId,
        conflicts: res.conflicts,
      });
    } else {
      setBannerNotice(`"${res.task.title}" sincronizada en Google Drive.`);
    }
  };

  const handleConfirmOverwrite = async (keys: string[]) => {
    if (!confirmModalState) return;
    setIsConfirmingDrive(true);
    try {
      if (!getDriveAccessToken()) {
        const refreshed = await ensureDriveAccessToken();
        if (refreshed) {
          setGoogleUser(refreshed.user);
          setHasDriveToken(Boolean(refreshed.accessToken));
        }
      }
      if (confirmModalState.source === 'run' && confirmModalState.runId) {
        const { run } = await confirmDriveOverwrites(confirmModalState.runId, keys, 'overwrite');
        setCurrentRun(run);
        await loadWorkspace();
        setBannerNotice('Archivos actualizados en Google Drive.');
      } else if (confirmModalState.source === 'task' && confirmModalState.taskId) {
        const res = await syncSingleTaskToDrive(confirmModalState.taskId, keys);
        setStore((prev) =>
          prev
            ? {
                ...prev,
                tasks: prev.tasks.map((t) => (t.id === res.task.id ? res.task : t)),
              }
            : prev
        );
        setBannerNotice(`"${res.task.title}" actualizada en Google Drive.`);
      }
      setConfirmModalState(null);
    } catch (err) {
      setBannerError(
        err instanceof Error ? err.message : 'Error al confirmar la actualización en Google Drive.'
      );
    } finally {
      setIsConfirmingDrive(false);
    }
  };

  const handleSkipOverwrite = async () => {
    if (!confirmModalState) return;
    setIsConfirmingDrive(true);
    try {
      if (confirmModalState.source === 'run' && confirmModalState.runId) {
        const { run } = await confirmDriveOverwrites(confirmModalState.runId, [], 'skip');
        setCurrentRun(run);
        await loadWorkspace();
      }
      setConfirmModalState(null);
    } finally {
      setIsConfirmingDrive(false);
    }
  };

  const isRunning = currentRun?.status === 'running';
  const tasks = store?.tasks ?? [];
  const courses = store?.courses ?? [];
  const todoTasks = tasks.filter(isTaskActionableTodo);
  const referenceTasksCount = tasks.filter(isTaskDoneInAules).length;
  const noSubmissionTasksCount = tasks.filter(isTaskNoSubmissionInAules).length;
  const canRunPending = Boolean(googleUser && groqConfigured && todoTasks.length > 0);
  const readyToRun = Boolean(googleUser && aulesConnected && groqConfigured);
  const solvedCount = todoTasks.filter((t) => {
    const sol = t.deliverables?.homeworkSolutionMd?.trim() || '';
    return sol.length >= 100 && !sol.includes('No se generó solución');
  }).length;
  const syncedCount = todoTasks.filter((t) => t.status === 'synced').length;

  const navItems: Array<{ id: ActiveSection; label: string; icon: typeof Activity; count?: number }> = [
    { id: 'process', label: 'Proceso en Vivo', icon: Activity },
    { id: 'tasks', label: 'Asignaturas y Tareas', icon: ClipboardList, count: tasks.length },
    {
      id: 'knowledge',
      label: 'Base de Aprendizaje',
      icon: BookOpen,
      count: Object.keys(store?.knowledge || {}).length,
    },
    { id: 'drive', label: 'Google Drive', icon: FolderSync },
    { id: 'connections', label: 'Conexiones', icon: PlugZap },
  ];

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex">
      {/* Left Navigation Sidebar */}
      <aside
        className={`fixed inset-y-0 left-0 z-40 w-[260px] shrink-0 border-r border-slate-200 bg-white flex flex-col transition-transform duration-200 lg:static lg:translate-x-0 ${
          mobileMenuOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex h-16 items-center justify-between border-b border-slate-200 px-6">
          <span className="font-display text-base font-bold tracking-tight text-slate-900 whitespace-nowrap">
            Aules Sync Agent
          </span>
          <button
            type="button"
            onClick={() => setMobileMenuOpen(false)}
            className="rounded-md p-1 text-slate-500 lg:hidden"
            aria-label="Cerrar menú"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <nav className="flex-1 space-y-1 p-4" aria-label="Navegación principal">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = activeSection === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  setActiveSection(item.id);
                  setMobileMenuOpen(false);
                }}
                className={`flex w-full items-center justify-between rounded-lg px-3.5 py-2.5 text-sm font-medium transition-colors whitespace-nowrap ${
                  active
                    ? 'bg-blue-50 text-blue-700'
                    : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                }`}
              >
                <span className="flex items-center gap-2.5 truncate">
                  <Icon className={`h-4 w-4 shrink-0 ${active ? 'text-blue-600' : 'text-slate-400'}`} />
                  <span className="truncate">{item.label}</span>
                </span>
                {typeof item.count === 'number' && item.count > 0 && (
                  <span className="font-mono text-xs text-slate-500 tabular-nums">
                    {item.count}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        <div className="border-t border-slate-200 p-4 space-y-3">
          {!authReady ? (
            <p className="text-xs text-slate-500">Restaurando sesión...</p>
          ) : googleUser ? (
            <div className="space-y-2">
              <div className="space-y-0.5">
                <p className="truncate text-xs font-semibold text-slate-900">
                  {googleUser.displayName || 'Usuario'}
                </p>
                <p className="truncate text-xs text-slate-500">{googleUser.email}</p>
                <p className="text-xs text-slate-500">
                  Aules: {aulesConnected ? 'Sesión activa' : 'Sin conectar'}
                </p>
              </div>
              {!hasDriveToken && (
                <button
                  type="button"
                  onClick={() => void handleGoogleLogin()}
                  disabled={isLoggingIn}
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-50"
                >
                  {isLoggingIn ? 'Autorizando Drive...' : 'Autorizar Drive en esta sesión'}
                </button>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-xs text-slate-500">Inicia sesión para habilitar Drive:</p>
              <GoogleSignInButton onClick={handleGoogleLogin} disabled={isLoggingIn} />
            </div>
          )}
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Top Bar Contract: Breadcrumb on left, 1 primary CTA on right */}
        <header className="sticky top-0 z-30 flex h-16 items-center justify-between gap-6 border-b border-slate-200 bg-white px-6">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              className="rounded-md p-1.5 text-slate-600 hover:bg-slate-100 lg:hidden"
              aria-label="Abrir menú"
            >
              <Menu className="h-5 w-5" />
            </button>
            <div className="flex items-center gap-2 text-sm min-w-0">
              <span className="text-slate-500 whitespace-nowrap">Estudio</span>
              <span className="text-slate-300" aria-hidden="true">
                /
              </span>
              <h1 className="truncate font-semibold text-slate-900">
                {SECTION_META[activeSection].breadcrumb}
              </h1>
            </div>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            {isRunning && currentRun ? (
              <button
                type="button"
                onClick={() => void handleCancelRun(currentRun.id)}
                className="inline-flex items-center gap-2 rounded-lg border border-red-300 bg-white px-4 py-2 text-sm font-medium text-red-700 transition-colors hover:bg-red-50 whitespace-nowrap shrink-0"
              >
                <Square className="h-3.5 w-3.5" />
                Detener Agente
              </button>
            ) : (
              <button
                type="button"
                onClick={() => {
                  if (canRunPending && !aulesConnected) {
                    void handleStartRun({ mode: 'pending_only', forceRegenerate: false });
                  } else if (!readyToRun) {
                    setActiveSection('connections');
                  } else {
                    void handleStartRun({ mode: 'full', forceRegenerate: false });
                  }
                }}
                className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 whitespace-nowrap shrink-0"
              >
                <Play className="h-4 w-4" />
                {canRunPending && syncedCount < todoTasks.length
                  ? 'Hacer sin entregar y subir a Drive'
                  : readyToRun
                  ? 'Ejecutar Agente'
                  : 'Configurar Agente'}
              </button>
            )}
          </div>
        </header>

        <main className="mx-auto w-full max-w-[1200px] flex-1 p-6 lg:p-8 space-y-6">
          {bannerError && (
            <div className="flex items-center justify-between gap-4 rounded-xl border border-red-200 bg-red-50 px-5 py-3.5 text-sm text-red-800">
              <span>{bannerError}</span>
              <button
                type="button"
                onClick={() => setBannerError(null)}
                className="text-red-600 hover:text-red-900"
                aria-label="Cerrar error"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          )}

          {bannerNotice && (
            <div className="flex items-center justify-between gap-4 rounded-xl border border-emerald-200 bg-emerald-50 px-5 py-3.5 text-sm text-emerald-800">
              <span>{bannerNotice}</span>
              <button
                type="button"
                onClick={() => setBannerNotice(null)}
                className="text-emerald-700 hover:text-emerald-950"
                aria-label="Cerrar aviso"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          )}

          {activeSection === 'process' && (
            <ProcessLiveView
              isGoogleSignedIn={Boolean(googleUser)}
              hasDriveToken={hasDriveToken}
              aulesConnected={aulesConnected}
              groqConfigured={groqConfigured}
              selectedModel={store?.selectedModel || 'llama-3.3-70b-versatile'}
              autoSyncEnabled={store?.autoSyncEnabled ?? false}
              autoSyncIntervalMinutes={store?.autoSyncIntervalMinutes ?? 30}
              currentRun={currentRun}
              totalCourses={courses.length}
              totalTasks={todoTasks.length}
              referenceTasks={referenceTasksCount}
              noSubmissionTasks={noSubmissionTasksCount}
              solvedTasks={solvedCount}
              syncedTasks={syncedCount}
              onStartRun={(opts) => void handleStartRun(opts)}
              onCancelRun={(id) => void handleCancelRun(id)}
              onOpenConnections={() => setActiveSection('connections')}
              onRefreshDriveToken={() => void handleGoogleLogin()}
              onOpenDriveConfirm={() => {
                if (currentRun && currentRun.pendingConfirmations.length > 0) {
                  setConfirmModalState({
                    source: 'run',
                    runId: currentRun.id,
                    conflicts: currentRun.pendingConfirmations,
                  });
                }
              }}
              onToggleAutoSync={(enabled) => void handleUpdateSettings({ autoSyncEnabled: enabled })}
            />
          )}

          {activeSection === 'tasks' && (
            <TasksView
              courses={courses}
              tasks={tasks}
              selectedModel={store?.selectedModel || 'llama-3.3-70b-versatile'}
              canSyncDrive={Boolean(googleUser)}
              onSolveTask={handleSolveTask}
              onSyncTask={handleSyncTask}
              onUploadAttachment={handleUploadAttachment}
              onDeleteAttachment={handleDeleteAttachment}
              onUpdateExportFormats={handleUpdateExportFormats}
              onGoToProcess={() => setActiveSection('process')}
            />
          )}

          {activeSection === 'knowledge' && (
            <KnowledgeView
              knowledgeMap={store?.knowledge || {}}
              onGoToProcess={() => setActiveSection('process')}
            />
          )}

          {activeSection === 'drive' && (
            <DriveExplorerView
              isGoogleSignedIn={Boolean(googleUser)}
              hasDriveToken={hasDriveToken}
              onGoogleLogin={() => void handleGoogleLogin()}
              isLoggingIn={isLoggingIn}
            />
          )}

          {activeSection === 'connections' && (
            <ConnectionsView
              googleUser={googleUser}
              hasDriveToken={hasDriveToken}
              isLoggingIn={isLoggingIn}
              onGoogleLogin={() => void handleGoogleLogin()}
              onGoogleLogout={() => void handleGoogleLogout()}
              aulesConnected={aulesConnected}
              aulesProfile={store?.aulesProfile ?? null}
              onConnectAules={handleConnectAules}
              onDisconnectAules={handleDisconnectAules}
              groqConfigured={groqConfigured}
              models={models}
              selectedModel={store?.selectedModel || 'llama-3.3-70b-versatile'}
              autoSyncEnabled={store?.autoSyncEnabled ?? false}
              autoSyncIntervalMinutes={store?.autoSyncIntervalMinutes ?? 30}
              onUpdateSettings={handleUpdateSettings}
            />
          )}
        </main>
      </div>

      {confirmModalState && (
        <DriveConfirmModal
          conflicts={confirmModalState.conflicts}
          isSubmitting={isConfirmingDrive}
          onConfirmOverwrite={(keys) => void handleConfirmOverwrite(keys)}
          onSkipExisting={() => void handleSkipOverwrite()}
          onClose={() => setConfirmModalState(null)}
        />
      )}
    </div>
  );
}
