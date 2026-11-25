import React, { useMemo, useRef, useState } from 'react';
import {
  Check,
  CloudUpload,
  Copy,
  Download,
  ExternalLink,
  FileText,
  Paperclip,
  RefreshCw,
  Search,
  Trash2,
} from 'lucide-react';
import { downloadTaskDeliverableFile } from '../lib/api';
import {
  isTaskActionableTodo,
  isTaskDoneInAules,
  isTaskNoSubmissionInAules,
} from '../lib/taskUtils';
import type {
  AttachmentRecord,
  CourseRecord,
  DeliverableFormat,
  TaskRecord,
  TaskStatus,
} from '../types';

interface TasksViewProps {
  courses: CourseRecord[];
  tasks: TaskRecord[];
  selectedModel: string;
  canSyncDrive: boolean;
  onSolveTask: (taskId: string) => Promise<void>;
  onSyncTask: (taskId: string) => Promise<void>;
  onUploadAttachment: (taskId: string, file: File) => Promise<void>;
  onDeleteAttachment: (taskId: string, attId: string) => Promise<void>;
  onUpdateExportFormats: (taskId: string, formats: DeliverableFormat[]) => Promise<void>;
  onGoToProcess: () => void;
}

type FilterMode = 'pending' | 'reference' | 'no_submission' | 'solved' | 'synced' | 'all';
type DeliverableTab = 'homework' | 'notes' | 'analysis' | 'attachments';

const EXPORT_FORMAT_OPTIONS: Array<{ id: DeliverableFormat; label: string }> = [
  { id: 'html', label: 'HTML' },
  { id: 'pdf', label: 'PDF' },
  { id: 'docx', label: 'DOCX' },
];

function statusLabel(task: TaskRecord): { text: string; tone: string } {
  if (isTaskNoSubmissionInAules(task)) {
    return { text: 'Sin entrega online', tone: 'text-slate-500' };
  }
  if (isTaskDoneInAules(task)) {
    return { text: 'Hecha · Referencia', tone: 'text-slate-600' };
  }
  const status: TaskStatus = task.status;
  switch (status) {
    case 'synced':
      return { text: 'Sincronizada', tone: 'text-emerald-700' };
    case 'solved':
      return { text: 'Resuelta', tone: 'text-blue-700' };
    case 'awaiting_drive_confirm':
      return { text: 'Lista para Drive', tone: 'text-blue-700' };
    case 'downloaded':
    case 'analyzed':
      return { text: 'Documentación leída', tone: 'text-slate-700' };
    case 'error':
      return { text: 'Con error', tone: 'text-red-700' };
    default:
      return { text: 'Sin hacer', tone: 'text-amber-700' };
  }
}

function attachmentSourceLabel(sourceType: AttachmentRecord['sourceType']): string {
  switch (sourceType) {
    case 'user_attachment':
      return 'Adjuntado por ti';
    case 'student_submission':
      return 'Tu entrega en Aules';
    case 'course_resource':
      return 'Recurso del curso';
    default:
      return 'Enunciado Aules';
  }
}

export const TasksView: React.FC<TasksViewProps> = ({
  courses,
  tasks,
  selectedModel,
  canSyncDrive,
  onSolveTask,
  onSyncTask,
  onUploadAttachment,
  onDeleteAttachment,
  onUpdateExportFormats,
  onGoToProcess,
}) => {
  const [filterMode, setFilterMode] = useState<FilterMode>('pending');
  const [courseFilter, setCourseFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(tasks[0]?.id ?? null);
  const [activeTab, setActiveTab] = useState<DeliverableTab>('homework');
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);
  const [downloadingFormat, setDownloadingFormat] = useState<DeliverableFormat | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const counts = useMemo(() => {
    let pending = 0;
    let reference = 0;
    let noSubmission = 0;
    let solved = 0;
    let synced = 0;
    for (const t of tasks) {
      if (isTaskNoSubmissionInAules(t)) {
        noSubmission += 1;
      } else if (isTaskDoneInAules(t)) {
        reference += 1;
      } else {
        pending += 1;
        if (t.status === 'solved') solved += 1;
        if (t.status === 'synced') synced += 1;
      }
    }
    return { pending, reference, noSubmission, solved, synced, all: tasks.length };
  }, [tasks]);

  const filteredTasks = useMemo(() => {
    return tasks.filter((t) => {
      const done = isTaskDoneInAules(t);
      const noSub = isTaskNoSubmissionInAules(t);
      const actionable = isTaskActionableTodo(t);
      if (courseFilter !== 'all' && t.courseId !== courseFilter) return false;
      if (filterMode === 'pending' && !actionable) return false;
      if (filterMode === 'reference' && !done) return false;
      if (filterMode === 'no_submission' && !noSub) return false;
      if (filterMode === 'solved' && (!actionable || t.status !== 'solved')) return false;
      if (filterMode === 'synced' && (!actionable || t.status !== 'synced')) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const hit =
          t.title.toLowerCase().includes(q) ||
          t.courseName.toLowerCase().includes(q) ||
          t.descriptionText.toLowerCase().includes(q);
        if (!hit) return false;
      }
      return true;
    });
  }, [tasks, courseFilter, filterMode, searchQuery]);

  const selectedTask = useMemo(() => {
    return (
      filteredTasks.find((t) => t.id === selectedTaskId) ||
      tasks.find((t) => t.id === selectedTaskId) ||
      filteredTasks[0] ||
      null
    );
  }, [filteredTasks, tasks, selectedTaskId]);

  const selectedIsDone = selectedTask ? isTaskDoneInAules(selectedTask) : false;
  const selectedIsNoSubmission = selectedTask ? isTaskNoSubmissionInAules(selectedTask) : false;
  const selectedIsActionable = selectedTask ? isTaskActionableTodo(selectedTask) : false;

  const activeFormats: DeliverableFormat[] = useMemo(() => {
    if (!selectedTask) return ['pdf'];
    if (selectedTask.exportFormats && selectedTask.exportFormats.length > 0) {
      return selectedTask.exportFormats;
    }
    if (selectedTask.deliverables?.outputFormat) {
      return [selectedTask.deliverables.outputFormat];
    }
    return ['pdf'];
  }, [selectedTask]);

  const handleCopy = async (text: string, key: string) => {
    await navigator.clipboard.writeText(text);
    setCopiedKey(key);
    window.setTimeout(() => setCopiedKey(null), 1800);
  };

  const handleDownloadMd = (filename: string, content: string) => {
    const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleDownloadFormat = async (task: TaskRecord, fmt: DeliverableFormat) => {
    setLocalError(null);
    setDownloadingFormat(fmt);
    try {
      await downloadTaskDeliverableFile(task.id, fmt, task.title);
    } catch (err) {
      setLocalError(
        err instanceof Error ? err.message : `Error al exportar en formato ${fmt.toUpperCase()}.`
      );
    } finally {
      setDownloadingFormat(null);
    }
  };

  const handleToggleFormat = async (task: TaskRecord, fmt: DeliverableFormat) => {
    setLocalError(null);
    const current = new Set<DeliverableFormat>(activeFormats);
    if (current.has(fmt)) {
      if (current.size === 1) return; // Keep at least one format selected
      current.delete(fmt);
    } else {
      current.add(fmt);
    }
    try {
      await onUpdateExportFormats(task.id, Array.from(current));
    } catch (err) {
      setLocalError(
        err instanceof Error ? err.message : 'No se pudo guardar la preferencia de formato.'
      );
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0 || !selectedTask) return;
    setLocalError(null);
    setBusyTaskId(selectedTask.id);
    try {
      for (const file of Array.from(files)) {
        await onUploadAttachment(selectedTask.id, file);
      }
      setActiveTab('attachments');
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'No se pudo adjuntar el archivo.');
    } finally {
      setBusyTaskId(null);
      e.target.value = '';
    }
  };

  const handleDeleteUserAttachment = async (taskId: string, attId: string) => {
    setLocalError(null);
    setBusyTaskId(taskId);
    try {
      await onDeleteAttachment(taskId, attId);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'No se pudo eliminar el adjunto.');
    } finally {
      setBusyTaskId(null);
    }
  };

  const handleSolve = async (taskId: string) => {
    setLocalError(null);
    setBusyTaskId(taskId);
    try {
      await onSolveTask(taskId);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Error al resolver la tarea.');
    } finally {
      setBusyTaskId(null);
    }
  };

  const handleSync = async (taskId: string) => {
    setLocalError(null);
    setBusyTaskId(taskId);
    try {
      await onSyncTask(taskId);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Error al sincronizar con Drive.');
    } finally {
      setBusyTaskId(null);
    }
  };

  if (tasks.length === 0) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-12 text-center">
        <h2 className="text-lg font-semibold text-slate-900">
          Todavía no hay tareas descargadas de Aules
        </h2>
        <p className="mx-auto mt-2 max-w-md text-sm text-slate-600">
          Ejecuta el agente desde Proceso en Vivo para escanear tus asignaturas, aprender de tus
          entregas anteriores y resolver únicamente las tareas sin hacer.
        </p>
        <button
          type="button"
          onClick={onGoToProcess}
          className="mt-6 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700"
        >
          Ir a Proceso en Vivo
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept=".html,.htm,.pdf,.docx,.txt,.md,.csv"
        onChange={(e) => void handleFileChange(e)}
        className="hidden"
      />

      {localError && (
        <div className="flex items-center justify-between gap-4 rounded-xl border border-red-200 bg-red-50 px-5 py-3 text-sm text-red-800">
          <span>{localError}</span>
          <button
            type="button"
            onClick={() => setLocalError(null)}
            className="text-xs font-medium text-red-700 hover:underline"
          >
            Cerrar
          </button>
        </div>
      )}

      {/* Filter Toolbar */}
      <div className="flex flex-col justify-between gap-4 rounded-xl border border-slate-200 bg-white p-4 lg:flex-row lg:items-center">
        <div className="flex flex-wrap items-center gap-1 rounded-lg bg-slate-100 p-1">
          {(
            [
              { id: 'pending', label: `Sin hacer (${counts.pending})` },
              { id: 'reference', label: `Hechas · Referencia (${counts.reference})` },
              { id: 'no_submission', label: `Sin entrega online (${counts.noSubmission})` },
              { id: 'solved', label: `Resueltas (${counts.solved})` },
              { id: 'synced', label: `En Drive (${counts.synced})` },
              { id: 'all', label: `Todas (${counts.all})` },
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setFilterMode(tab.id)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                filterMode === tab.id
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <select
            value={courseFilter}
            onChange={(e) => setCourseFilter(e.target.value)}
            aria-label="Filtrar por asignatura"
            className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 focus:border-blue-600 focus:outline-none"
          >
            <option value="all">Todas las asignaturas ({courses.length})</option>
            {courses.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>

          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Buscar tarea o enunciado..."
              className="w-64 rounded-lg border border-slate-300 bg-white py-1.5 pl-9 pr-3 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none"
            />
          </div>
        </div>
      </div>

      {/* Table + Task Inspector Split */}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-12">
        <div className="xl:col-span-5 overflow-hidden rounded-xl border border-slate-200 bg-white">
          <div className="border-b border-slate-200 px-5 py-3.5">
            <p className="text-xs font-medium text-slate-500 tabular-nums">
              Mostrando {filteredTasks.length} de {tasks.length} tareas
            </p>
          </div>
          <div className="max-h-[720px] overflow-y-auto divide-y divide-slate-100">
            {filteredTasks.length === 0 ? (
              <div className="p-8 text-center text-sm text-slate-500">
                No hay tareas que coincidan con el filtro aplicado.
              </div>
            ) : (
              filteredTasks.map((task) => {
                const st = statusLabel(task);
                const isSelected = selectedTask?.id === task.id;
                return (
                  <button
                    key={task.id}
                    type="button"
                    onClick={() => setSelectedTaskId(task.id)}
                    className={`w-full px-5 py-3.5 text-left transition-colors ${
                      isSelected ? 'bg-blue-50/60' : 'hover:bg-slate-50'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <p className="text-sm font-semibold text-slate-900 line-clamp-1">
                        {task.title}
                      </p>
                      <span className={`text-xs font-medium whitespace-nowrap shrink-0 ${st.tone}`}>
                        {st.text}
                      </span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                      <span className="truncate max-w-[190px]">{task.courseName}</span>
                      <span aria-hidden="true">·</span>
                      <span className="font-mono tabular-nums">
                        {task.attachments.length} adjunto(s)
                      </span>
                      {task.dueDate && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="truncate">{task.dueDate}</span>
                        </>
                      )}
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>

        {/* Task Inspector */}
        <div className="xl:col-span-7 rounded-xl border border-slate-200 bg-white">
          {!selectedTask ? (
            <div className="flex h-64 items-center justify-center text-sm text-slate-500">
              Selecciona una tarea para ver el enunciado, documentación y solución.
            </div>
          ) : (
            <div className="flex flex-col">
              <div className="border-b border-slate-200 px-6 py-5">
                <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                  <span>{selectedTask.courseName}</span>
                  <span aria-hidden="true">·</span>
                  <span>{selectedTask.submissionStatus}</span>
                  {selectedTask.dueDate && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span>Entrega: {selectedTask.dueDate}</span>
                    </>
                  )}
                </div>

                <div className="mt-2 flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
                  <h2 className="text-lg font-semibold text-slate-900">{selectedTask.title}</h2>
                  <div className="flex flex-wrap items-center gap-2 shrink-0">
                    <a
                      href={selectedTask.url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                      Ver en Aules
                    </a>
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={busyTaskId === selectedTask.id}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap"
                    >
                      <Paperclip className="h-3.5 w-3.5" />
                      Adjuntar HTML/PDF/DOCX
                    </button>
                    {selectedIsActionable ? (
                      <>
                        <button
                          type="button"
                          onClick={() => void handleSolve(selectedTask.id)}
                          disabled={busyTaskId === selectedTask.id}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap"
                        >
                          <RefreshCw
                            className={`h-3.5 w-3.5 ${
                              busyTaskId === selectedTask.id ? 'animate-spin' : ''
                            }`}
                          />
                          {selectedTask.deliverables ? 'Regenerar' : 'Resolver ahora'}
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleSync(selectedTask.id)}
                          disabled={busyTaskId === selectedTask.id || !canSyncDrive}
                          className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50 whitespace-nowrap"
                        >
                          <CloudUpload className="h-3.5 w-3.5" />
                          Sincronizar Drive
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        onClick={() => void handleSolve(selectedTask.id)}
                        disabled={busyTaskId === selectedTask.id}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap"
                      >
                        <RefreshCw
                          className={`h-3.5 w-3.5 ${
                            busyTaskId === selectedTask.id ? 'animate-spin' : ''
                          }`}
                        />
                        Generar borrador de repaso
                      </button>
                    )}
                  </div>
                </div>

                {selectedTask.driveFolderLink && (
                  <div className="mt-3 text-xs text-slate-600">
                    Carpeta en Drive:{' '}
                    <a
                      href={selectedTask.driveFolderLink}
                      target="_blank"
                      rel="noreferrer"
                      className="font-medium text-blue-600 hover:underline"
                    >
                      Abrir carpeta de la tarea en Google Drive
                    </a>
                  </div>
                )}

                {selectedTask.status === 'error' && selectedTask.errorMessage && (
                  <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                    {selectedTask.errorMessage}
                  </div>
                )}
              </div>

              {/* Banner for tasks that don't require online submission */}
              {selectedIsNoSubmission && (
                <div className="border-b border-slate-200 bg-slate-50 px-6 py-4 space-y-1">
                  <p className="text-xs font-semibold text-slate-900">
                    Actividad sin entrega en línea (nota o registro presencial)
                  </p>
                  <p className="text-xs text-slate-600">
                    Aules indica que esta tarea no requiere que envíes ningún archivo ni texto en
                    línea, por lo que el agente la omite automáticamente para ahorrar peticiones de
                    IA.
                  </p>
                </div>
              )}

              {/* Reference Banner for already submitted tasks */}
              {selectedIsDone && (
                <div className="border-b border-slate-200 bg-slate-50 px-6 py-4 space-y-2">
                  <p className="text-xs font-semibold text-slate-900">
                    Tarea ya entregada en Aules · Descargada como ejemplo de tu forma de trabajar
                  </p>
                  <p className="text-xs text-slate-600">
                    El agente no resuelve automáticamente las tareas que ya has entregado; usa esta
                    entrega y sus adjuntos para aprender tu estilo y aplicarlo en las tareas sin hacer
                    de {selectedTask.courseName}.
                  </p>
                  {selectedTask.submittedWorkText && (
                    <div className="mt-2 rounded-lg border border-slate-200 bg-white p-3">
                      <p className="text-xs font-medium text-slate-700">
                        Texto de tu entrega en Aules
                      </p>
                      <p className="mt-1 max-h-28 overflow-y-auto whitespace-pre-line text-xs text-slate-700">
                        {selectedTask.submittedWorkText}
                      </p>
                    </div>
                  )}
                </div>
              )}

              {/* Export format selection & download bar */}
              {selectedIsActionable && (
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-slate-50/70 px-6 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-medium text-slate-700">
                      Formatos para Drive:
                    </span>
                    <div className="flex items-center gap-1">
                      {EXPORT_FORMAT_OPTIONS.map((fmt) => {
                        const selected = activeFormats.includes(fmt.id);
                        return (
                          <button
                            key={fmt.id}
                            type="button"
                            onClick={() => void handleToggleFormat(selectedTask, fmt.id)}
                            className={`rounded-md border px-2.5 py-1 font-mono text-xs font-medium transition-colors whitespace-nowrap ${
                              selected
                                ? 'border-blue-600 bg-blue-50 text-blue-700'
                                : 'border-slate-300 bg-white text-slate-600 hover:bg-slate-50'
                            }`}
                          >
                            {fmt.label}
                          </button>
                        );
                      })}
                    </div>
                    {selectedTask.deliverables?.outputFormat && (
                      <span className="text-xs text-slate-500">
                        Recomendado por Groq: {selectedTask.deliverables.outputFormat.toUpperCase()}
                      </span>
                    )}
                  </div>

                  {selectedTask.deliverables && (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-xs text-slate-500 mr-1">Descargar entrega:</span>
                      {EXPORT_FORMAT_OPTIONS.map((fmt) => (
                        <button
                          key={fmt.id}
                          type="button"
                          disabled={downloadingFormat !== null}
                          onClick={() => void handleDownloadFormat(selectedTask, fmt.id)}
                          className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2.5 py-1 font-mono text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap"
                        >
                          <Download className="h-3 w-3" />
                          {downloadingFormat === fmt.id ? '...' : fmt.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Prompt excerpt */}
              <div className="border-b border-slate-200 bg-slate-50/50 px-6 py-4">
                <p className="text-xs font-semibold text-slate-700">Enunciado extraído de Aules</p>
                <p className="mt-1.5 max-h-28 overflow-y-auto whitespace-pre-line text-sm text-slate-700">
                  {selectedTask.descriptionText}
                </p>
              </div>

              {/* Deliverable Tabs */}
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-6 py-3">
                <div className="flex flex-wrap items-center gap-1 rounded-lg bg-slate-100 p-1">
                  {(
                    [
                      { id: 'homework', label: 'Deberes resueltos' },
                      { id: 'notes', label: 'Apuntes de estudio' },
                      { id: 'analysis', label: 'Análisis' },
                      {
                        id: 'attachments',
                        label: `Documentación (${selectedTask.attachments.length})`,
                      },
                    ] as const
                  ).map((tab) => (
                    <button
                      key={tab.id}
                      type="button"
                      onClick={() => setActiveTab(tab.id)}
                      className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                        activeTab === tab.id
                          ? 'bg-white text-slate-900 shadow-xs'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>

                {selectedTask.deliverables && activeTab !== 'attachments' && (
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        const txt =
                          activeTab === 'homework'
                            ? selectedTask.deliverables!.homeworkSolutionMd
                            : activeTab === 'notes'
                            ? selectedTask.deliverables!.studyNotesMd
                            : selectedTask.deliverables!.requirementAnalysisMd;
                        void handleCopy(txt, activeTab);
                      }}
                      className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
                    >
                      {copiedKey === activeTab ? (
                        <>
                          <Check className="h-3.5 w-3.5 text-emerald-600" />
                          Copiado
                        </>
                      ) : (
                        <>
                          <Copy className="h-3.5 w-3.5" />
                          Copiar
                        </>
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const txt =
                          activeTab === 'homework'
                            ? selectedTask.deliverables!.homeworkSolutionMd
                            : activeTab === 'notes'
                            ? selectedTask.deliverables!.studyNotesMd
                            : selectedTask.deliverables!.requirementAnalysisMd;
                        const fname =
                          activeTab === 'homework'
                            ? '03_deberes_resueltos.md'
                            : activeTab === 'notes'
                            ? '02_apuntes_estudio.md'
                            : '01_analisis_requisitos.md';
                        handleDownloadMd(fname, txt);
                      }}
                      className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
                    >
                      <Download className="h-3.5 w-3.5" />
                      .md
                    </button>
                  </div>
                )}
              </div>

              <div className="max-h-[420px] overflow-y-auto p-6">
                {activeTab === 'attachments' ? (
                  <div className="space-y-4">
                    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-dashed border-slate-300 bg-slate-50/70 px-4 py-3">
                      <div>
                        <p className="text-xs font-semibold text-slate-800">
                          ¿Necesita contexto extra? Adjunta archivos HTML, PDF o DOCX
                        </p>
                        <p className="text-xs text-slate-500">
                          Groq leerá su contenido al resolver o regenerar la tarea y también se
                          subirán a Drive.
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        disabled={busyTaskId === selectedTask.id}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap shrink-0"
                      >
                        <Paperclip className="h-3.5 w-3.5" />
                        Seleccionar archivo
                      </button>
                    </div>

                    {selectedTask.attachments.length === 0 ? (
                      <p className="text-sm text-slate-500">
                        Esta tarea aún no tiene archivos adjuntos de Aules ni subidos por ti.
                      </p>
                    ) : (
                      <div className="divide-y divide-slate-100">
                        {selectedTask.attachments.map((att) => (
                          <div key={att.id} className="py-3 first:pt-0 last:pb-0">
                            <div className="flex items-center justify-between gap-3">
                              <div className="flex items-center gap-2 min-w-0">
                                <FileText className="h-4 w-4 shrink-0 text-slate-400" />
                                <span className="truncate text-sm font-medium text-slate-900">
                                  {att.name}
                                </span>
                                <span className="text-xs text-slate-500 whitespace-nowrap shrink-0">
                                  · {attachmentSourceLabel(att.sourceType)}
                                </span>
                              </div>
                              <div className="flex items-center gap-2 shrink-0">
                                <span className="font-mono text-xs text-slate-500 tabular-nums">
                                  {att.byteSize > 0
                                    ? `${Math.max(1, Math.round(att.byteSize / 1024))} KB`
                                    : 'Pendiente'}
                                </span>
                                {att.sourceType === 'user_attachment' && (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      void handleDeleteUserAttachment(selectedTask.id, att.id)
                                    }
                                    disabled={busyTaskId === selectedTask.id}
                                    title="Eliminar archivo adjunto"
                                    className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
                                  >
                                    <Trash2 className="h-3.5 w-3.5" />
                                  </button>
                                )}
                              </div>
                            </div>
                            {att.extractedText && (
                              <pre className="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap rounded-lg border border-slate-200 bg-slate-50 p-3 font-mono text-xs text-slate-700">
                                {att.extractedText}
                              </pre>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ) : !selectedTask.deliverables ? (
                  <div className="py-10 text-center">
                    {selectedIsNoSubmission ? (
                      <>
                        <p className="text-sm font-medium text-slate-700">
                          Esta actividad no requiere entrega en línea en Aules.
                        </p>
                        <p className="mx-auto mt-1 max-w-md text-xs text-slate-500">
                          Normalmente corresponde a calificaciones de exámenes presenciales o tareas
                          evaluadas en clase.
                        </p>
                      </>
                    ) : selectedIsDone ? (
                      <>
                        <p className="text-sm font-medium text-slate-700">
                          Tarea entregada en Aules. Usada solo para aprender tu estilo en esta
                          asignatura.
                        </p>
                        <p className="mx-auto mt-1 max-w-md text-xs text-slate-500">
                          Revisa la pestaña Documentación para ver los archivos de tu entrega o
                          descargarlos.
                        </p>
                      </>
                    ) : (
                      <>
                        <p className="text-sm font-medium text-slate-700">
                          Esta tarea sin hacer aún no se ha resuelto con Groq ({selectedModel}).
                        </p>
                        <button
                          type="button"
                          onClick={() => void handleSolve(selectedTask.id)}
                          disabled={busyTaskId === selectedTask.id}
                          className="mt-4 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                        >
                          {busyTaskId === selectedTask.id
                            ? 'Generando...'
                            : 'Analizar y resolver ahora'}
                        </button>
                      </>
                    )}
                  </div>
                ) : (
                  <div className="space-y-3">
                    <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                      <span>Modelo: {selectedTask.deliverables.modelUsed}</span>
                      {selectedTask.deliverables.outputFormat && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span>
                            Formato óptimo: {selectedTask.deliverables.outputFormat.toUpperCase()}
                          </span>
                        </>
                      )}
                      <span aria-hidden="true">·</span>
                      <span className="font-mono tabular-nums">
                        {new Date(selectedTask.deliverables.generatedAt).toLocaleString('es-ES')}
                      </span>
                      {selectedTask.deliverables.contextSourcesUsed &&
                        selectedTask.deliverables.contextSourcesUsed.length > 0 && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span>
                              Contexto usado:{' '}
                              {selectedTask.deliverables.contextSourcesUsed.join(', ')}
                            </span>
                          </>
                        )}
                    </div>
                    <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed text-slate-800">
                      {activeTab === 'homework'
                        ? selectedTask.deliverables.homeworkSolutionMd
                        : activeTab === 'notes'
                        ? selectedTask.deliverables.studyNotesMd
                        : selectedTask.deliverables.requirementAnalysisMd}
                    </pre>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
