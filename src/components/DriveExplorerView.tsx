import React, { useEffect, useState } from 'react';
import { ExternalLink, FileText, Folder, RefreshCw } from 'lucide-react';
import { fetchDriveTree } from '../lib/api';
import type { DriveTreeNode } from '../types';
import { GoogleSignInButton } from './GoogleSignInButton';

interface DriveExplorerViewProps {
  isGoogleSignedIn: boolean;
  hasDriveToken: boolean;
  onGoogleLogin: () => void;
  isLoggingIn: boolean;
}

export const DriveExplorerView: React.FC<DriveExplorerViewProps> = ({
  isGoogleSignedIn,
  hasDriveToken,
  onGoogleLogin,
  isLoggingIn,
}) => {
  const [tree, setTree] = useState<DriveTreeNode[]>([]);
  const [rootLink, setRootLink] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadTree = async () => {
    if (!isGoogleSignedIn || !hasDriveToken) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetchDriveTree();
      setTree(res.tree);
      setRootLink(res.rootFolder.webViewLink);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo cargar el árbol de Google Drive.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isGoogleSignedIn && hasDriveToken) {
      void loadTree();
    }
  }, [isGoogleSignedIn, hasDriveToken]);

  if (!isGoogleSignedIn || !hasDriveToken) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-12 text-center">
        <h2 className="text-lg font-semibold text-slate-900">
          {isGoogleSignedIn
            ? 'Renueva el permiso de Google Drive para esta pestaña'
            : 'Conecta Google Drive para explorar tus carpetas sincronizadas'}
        </h2>
        <p className="mx-auto mt-2 max-w-md text-sm text-slate-600">
          {isGoogleSignedIn
            ? 'Tu sesión de Google sigue activa. Por seguridad, el acceso directo a Drive se confirma en un clic al recargar la página.'
            : 'Inicia sesión con Google para visualizar la carpeta raíz Aules Sync y acceder a las subcarpetas por asignatura y tarea.'}
        </p>
        <div className="mt-6 flex justify-center">
          {isGoogleSignedIn ? (
            <button
              type="button"
              onClick={onGoogleLogin}
              disabled={isLoggingIn}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
            >
              {isLoggingIn ? 'Autorizando Drive...' : 'Autorizar acceso a Google Drive'}
            </button>
          ) : (
            <GoogleSignInButton onClick={onGoogleLogin} disabled={isLoggingIn} />
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-slate-200 bg-white px-6 py-4">
        <div>
          <h2 className="text-base font-semibold text-slate-900">
            Estructura en Google Drive (Aules Sync)
          </h2>
          <p className="mt-0.5 text-xs text-slate-500">
            Carpeta raíz con subcarpetas por asignatura, memoria de aprendizaje y cada tarea
          </p>
        </div>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => void loadTree()}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap shrink-0"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            Actualizar
          </button>

          {rootLink && (
            <a
              href={rootLink}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-2 text-sm font-medium text-white hover:bg-blue-700 whitespace-nowrap shrink-0"
            >
              <ExternalLink className="h-4 w-4" />
              Abrir Aules Sync
            </a>
          )}
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-5 py-4 text-sm text-red-700">
          {error}
        </div>
      )}

      {loading && tree.length === 0 ? (
        <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-6">
          <div className="h-5 w-48 animate-pulse rounded bg-slate-200" />
          <div className="h-4 w-72 animate-pulse rounded bg-slate-100" />
          <div className="h-4 w-64 animate-pulse rounded bg-slate-100" />
        </div>
      ) : tree.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-10 text-center">
          <p className="text-sm font-medium text-slate-800">
            La carpeta Aules Sync todavía no contiene asignaturas.
          </p>
          <p className="mt-1 text-xs text-slate-500">
            Ejecuta el agente para crear automáticamente la estructura por asignatura y tarea.
          </p>
        </div>
      ) : (
        <div className="divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white">
          {tree.map((courseFolder) => (
            <div key={courseFolder.id} className="p-6">
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-2.5 min-w-0">
                  <Folder className="h-5 w-5 shrink-0 text-blue-600" />
                  <h3 className="truncate text-base font-semibold text-slate-900">
                    {courseFolder.name}
                  </h3>
                </div>
                {courseFolder.webViewLink && (
                  <a
                    href={courseFolder.webViewLink}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:underline whitespace-nowrap shrink-0"
                  >
                    Abrir asignatura
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                )}
              </div>

              {courseFolder.children && courseFolder.children.length > 0 && (
                <div className="mt-4 divide-y divide-slate-100 border-t border-slate-100 pt-2">
                  {courseFolder.children.map((subFolder) => (
                    <div key={subFolder.id} className="py-3">
                      <div className="flex items-center justify-between gap-4">
                        <div className="flex items-center gap-2 min-w-0">
                          <Folder className="h-4 w-4 shrink-0 text-slate-500" />
                          <span className="truncate text-sm font-medium text-slate-800">
                            {subFolder.name}
                          </span>
                          <span className="font-mono text-xs text-slate-400 tabular-nums shrink-0">
                            ({subFolder.files.length})
                          </span>
                        </div>
                        {subFolder.webViewLink && (
                          <a
                            href={subFolder.webViewLink}
                            target="_blank"
                            rel="noreferrer"
                            className="text-xs text-slate-600 hover:text-blue-600 hover:underline whitespace-nowrap shrink-0"
                          >
                            Ver carpeta
                          </a>
                        )}
                      </div>

                      {subFolder.files.length > 0 && (
                        <ul className="mt-2 ml-6 space-y-1.5">
                          {subFolder.files.map((file) => (
                            <li
                              key={file.id}
                              className="flex items-center justify-between gap-3 text-xs text-slate-600"
                            >
                              <div className="flex items-center gap-2 min-w-0">
                                <FileText className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                                <span className="truncate">{file.name}</span>
                              </div>
                              {file.webViewLink && (
                                <a
                                  href={file.webViewLink}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="text-blue-600 hover:underline whitespace-nowrap shrink-0"
                                >
                                  Abrir
                                </a>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
