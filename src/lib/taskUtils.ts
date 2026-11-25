import type { TaskRecord } from '../types';

function normalizeStatusText(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

export function isTaskNoSubmissionInAules(task: TaskRecord): boolean {
  if (task.requiresOnlineSubmission === false || task.status === 'no_submission') {
    return true;
  }
  const s = normalizeStatusText(task.submissionStatus || '');
  return (
    s.includes('no requereix que trameteu res') ||
    s.includes('no requereix cap tramesa') ||
    s.includes('no es requereix cap tramesa') ||
    s.includes('no requereix lliurament') ||
    s.includes('no requiere que envie') ||
    s.includes('no se requiere entrega') ||
    s.includes('no requiere entrega en linea') ||
    s.includes('no online submissions are required') ||
    s.includes('no submission required') ||
    s.includes('nothing is required to be submitted')
  );
}

export function isTaskDoneInAules(task: TaskRecord): boolean {
  if (isTaskNoSubmissionInAules(task)) {
    return false;
  }
  if (typeof task.isSubmittedInAules === 'boolean') {
    return task.isSubmittedInAules;
  }
  if (task.status === 'reference') {
    return true;
  }
  const s = normalizeStatusText(task.submissionStatus || '');
  const notSubmitted =
    s.includes('sin entrega') ||
    s.includes('no entregado') ||
    s.includes('no enviado') ||
    s.includes('sense lliuraments') ||
    s.includes('sense tramesa') ||
    s.includes('no submission') ||
    s.includes('nothing has been submitted') ||
    s.includes('not submitted') ||
    s.includes('borrador') ||
    s.includes('esborrany') ||
    s.includes('draft') ||
    s === 'pendiente';
  if (notSubmitted) return false;

  const submitted =
    s.includes('enviado') ||
    s.includes('enviada') ||
    s.includes('entregado') ||
    s.includes('entregada') ||
    s.includes('tramesa per a qualificar') ||
    s.includes('tramesa realitzada') ||
    s.includes('lliurat') ||
    s.includes('submitted') ||
    s.includes('calificado') ||
    s.includes('qualificat') ||
    s.includes('graded');

  return (
    submitted ||
    Boolean(task.submittedWorkText && task.submittedWorkText.length > 20) ||
    task.attachments.some((a) => a.sourceType === 'student_submission')
  );
}

export function isTaskActionableTodo(task: TaskRecord): boolean {
  return !isTaskNoSubmissionInAules(task) && !isTaskDoneInAules(task);
}

