import React, { useState } from 'react';
import { BookOpen, ExternalLink } from 'lucide-react';
import type { SubjectKnowledge } from '../types';

interface KnowledgeViewProps {
  knowledgeMap: Record<string, SubjectKnowledge>;
  onGoToProcess: () => void;
}

export const KnowledgeView: React.FC<KnowledgeViewProps> = ({
  knowledgeMap,
  onGoToProcess,
}) => {
  const subjects = Object.values(knowledgeMap);
  const [selectedCourseId, setSelectedCourseId] = useState<string>(
    subjects[0]?.courseId ?? ''
  );

  const activeSubject =
    subjects.find((s) => s.courseId === selectedCourseId) || subjects[0] || null;

  if (subjects.length === 0) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-12 text-center">
        <BookOpen className="mx-auto h-8 w-8 text-slate-400" />
        <h2 className="mt-4 text-lg font-semibold text-slate-900">
          La Base de Aprendizaje está vacía
        </h2>
        <p className="mx-auto mt-2 max-w-md text-sm text-slate-600">
          Cada vez que el agente analiza tus tareas y documentación de Aules, consolida aquí lo
          que ha aprendido por asignatura para resolver mejor las siguientes entregas.
        </p>
        <button
          type="button"
          onClick={onGoToProcess}
          className="mt-6 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700"
        >
          Ejecutar primer análisis
        </button>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
      {/* Subject List */}
      <div className="lg:col-span-4 rounded-xl border border-slate-200 bg-white overflow-hidden">
        <div className="border-b border-slate-200 px-5 py-4">
          <h2 className="text-sm font-semibold text-slate-900">
            Asignaturas con memoria ({subjects.length})
          </h2>
        </div>
        <div className="divide-y divide-slate-100">
          {subjects.map((sub) => {
            const isSelected = activeSubject?.courseId === sub.courseId;
            return (
              <button
                key={sub.courseId}
                type="button"
                onClick={() => setSelectedCourseId(sub.courseId)}
                className={`w-full px-5 py-4 text-left transition-colors ${
                  isSelected ? 'bg-blue-50/60' : 'hover:bg-slate-50'
                }`}
              >
                <p className="text-sm font-semibold text-slate-900">{sub.courseName}</p>
                <div className="mt-1 flex items-center gap-2 text-xs text-slate-500">
                  <span className="font-mono tabular-nums">
                    {sub.learnedTaskIds.length} tarea(s) integradas
                  </span>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono tabular-nums">
                    {sub.keyConcepts.length} conceptos
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Knowledge Detail */}
      {activeSubject && (
        <div className="lg:col-span-8 rounded-xl border border-slate-200 bg-white p-6 space-y-6">
          <div className="flex flex-col justify-between gap-4 border-b border-slate-200 pb-5 sm:flex-row sm:items-start">
            <div>
              <div className="flex items-center gap-2 text-xs text-slate-500">
                <span className="font-mono tabular-nums">
                  {activeSubject.learnedTaskIds.length} tareas aprendidas
                </span>
                <span aria-hidden="true">·</span>
                <span>
                  Actualizado el {new Date(activeSubject.updatedAt).toLocaleDateString('es-ES')}
                </span>
              </div>
              <h2 className="mt-1 text-xl font-semibold text-slate-900">
                {activeSubject.courseName}
              </h2>
            </div>

            {activeSubject.driveWebViewLink && (
              <a
                href={activeSubject.driveWebViewLink}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap shrink-0"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                Abrir memoria en Drive
              </a>
            )}
          </div>

          <div>
            <h3 className="text-sm font-semibold text-slate-900">
              Resumen de enfoque y temario
            </h3>
            <p className="mt-2 text-sm leading-relaxed text-slate-700">
              {activeSubject.summary}
            </p>
          </div>

          <div className="rounded-lg border border-slate-200 bg-slate-50/70 p-4 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-slate-900">
                Cómo trabajas en esta asignatura
              </h3>
              {activeSubject.studentPreferredFormats &&
                activeSubject.studentPreferredFormats.length > 0 && (
                  <span className="font-mono text-xs text-slate-600">
                    Formatos habituales:{' '}
                    {activeSubject.studentPreferredFormats
                      .map((f) => f.toUpperCase())
                      .join(' · ')}
                  </span>
                )}
            </div>
            <p className="text-sm leading-relaxed text-slate-700">
              {activeSubject.studentWorkStyle ||
                'Cuando el agente descargue tus tareas ya entregadas en esta asignatura, aprenderá aquí tu estructura, tono y formato habitual para aplicarlo en las pendientes.'}
            </p>
          </div>

          <div className="grid grid-cols-1 gap-6 border-t border-slate-200 pt-6 md:grid-cols-2">
            <div>
              <h3 className="text-sm font-semibold text-slate-900">Conceptos clave</h3>
              <ul className="mt-2.5 space-y-2 text-sm text-slate-700">
                {activeSubject.keyConcepts.length === 0 ? (
                  <li className="text-slate-500">Sin conceptos registrados aún.</li>
                ) : (
                  activeSubject.keyConcepts.map((c, idx) => (
                    <li key={idx} className="leading-snug">
                      {idx + 1}. {c}
                    </li>
                  ))
                )}
              </ul>
            </div>

            <div>
              <h3 className="text-sm font-semibold text-slate-900">
                Criterios de evaluación detectados
              </h3>
              <ul className="mt-2.5 space-y-2 text-sm text-slate-700">
                {activeSubject.evaluationCriteria.length === 0 ? (
                  <li className="text-slate-500">Sin criterios detectados aún.</li>
                ) : (
                  activeSubject.evaluationCriteria.map((c, idx) => (
                    <li key={idx} className="leading-snug">
                      {idx + 1}. {c}
                    </li>
                  ))
                )}
              </ul>
            </div>
          </div>

          {activeSubject.studyTips.length > 0 && (
            <div className="border-t border-slate-200 pt-6">
              <h3 className="text-sm font-semibold text-slate-900">
                Recomendaciones para próximas entregas
              </h3>
              <ul className="mt-2.5 space-y-2 text-sm text-slate-700">
                {activeSubject.studyTips.map((tip, idx) => (
                  <li key={idx} className="leading-snug">
                    {tip}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {activeSubject.glossary.length > 0 && (
            <div className="border-t border-slate-200 pt-6">
              <h3 className="text-sm font-semibold text-slate-900">Glosario técnico</h3>
              <dl className="mt-3 divide-y divide-slate-100">
                {activeSubject.glossary.map((item, idx) => (
                  <div key={idx} className="py-2.5 first:pt-0 last:pb-0">
                    <dt className="text-sm font-medium text-slate-900">{item.term}</dt>
                    <dd className="mt-0.5 text-sm text-slate-600">{item.definition}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
