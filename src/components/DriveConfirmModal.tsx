import React from 'react';
import { AlertTriangle, FileText, X } from 'lucide-react';
import type { DriveConflictItem } from '../types';

interface DriveConfirmModalProps {
  conflicts: DriveConflictItem[];
  isSubmitting: boolean;
  onConfirmOverwrite: (keys: string[]) => void;
  onSkipExisting: () => void;
  onClose: () => void;
}

export const DriveConfirmModal: React.FC<DriveConfirmModalProps> = ({
  conflicts,
  isSubmitting,
  onConfirmOverwrite,
  onSkipExisting,
  onClose,
}) => {
  if (conflicts.length === 0) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-[1px]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="drive-confirm-title"
    >
      <div className="w-full max-w-xl rounded-xl border border-slate-200 bg-white shadow-lg">
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-6 py-4">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
            <div>
              <h2 id="drive-confirm-title" className="text-base font-semibold text-slate-900">
                Confirmar actualización en Google Drive
              </h2>
              <p className="mt-1 text-sm text-slate-600">
                Se encontraron {conflicts.length} archivo(s) que ya existen en Google Drive. Confirma si
                deseas reemplazar su contenido con la versión más reciente.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            className="rounded-md p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
            aria-label="Cerrar"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="max-h-72 overflow-y-auto divide-y divide-slate-100 px-6 py-2">
          {conflicts.map((item) => (
            <div key={item.key} className="flex items-start gap-3 py-3">
              <FileText className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-slate-900">{item.fileName}</p>
                <p className="mt-0.5 text-xs text-slate-500">
                  {item.courseName}
                  {item.taskTitle ? ` · ${item.taskTitle}` : ' · Memoria de asignatura'}
                </p>
              </div>
            </div>
          ))}
        </div>

        <div className="flex flex-wrap items-center justify-end gap-3 border-t border-slate-200 bg-slate-50 px-6 py-4 rounded-b-xl">
          <button
            type="button"
            onClick={onSkipExisting}
            disabled={isSubmitting}
            className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap shrink-0"
          >
            Omitir existentes
          </button>
          <button
            type="button"
            onClick={() => onConfirmOverwrite(conflicts.map((c) => c.key))}
            disabled={isSubmitting}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50 whitespace-nowrap shrink-0"
          >
            {isSubmitting ? 'Actualizando...' : `Confirmar y sobrescribir (${conflicts.length})`}
          </button>
        </div>
      </div>
    </div>
  );
};
