export type PipelineStageIndex = 1 | 2 | 3 | 4 | 5 | 6;

export type PipelineStatus =
  | 'idle'
  | 'running'
  | 'awaiting_confirmation'
  | 'completed'
  | 'cancelled'
  | 'error';

export type DeliverableFormat = 'html' | 'pdf' | 'docx' | 'md';

export type TaskStatus =
  | 'detected'
  | 'downloaded'
  | 'analyzed'
  | 'solved'
  | 'synced'
  | 'awaiting_drive_confirm'
  | 'reference'
  | 'no_submission'
  | 'error';

export interface AulesProfile {
  baseUrl: string;
  username: string;
  fullName: string;
  lastConnectedAt: string;
}

export interface AulesSession {
  baseUrl: string;
  username: string;
  fullName: string;
  cookies: Record<string, string>;
  sesskey: string | null;
  connectedAt: string;
}

export interface AttachmentRecord {
  id: string;
  name: string;
  sourceUrl: string;
  mimeType: string;
  byteSize: number;
  downloaded: boolean;
  localCacheKey?: string;
  extractedText: string;
  driveFileId?: string;
  driveWebViewLink?: string;
  sourceType: 'assignment' | 'course_resource' | 'student_submission' | 'user_attachment';
}

export interface TaskDeliverables {
  requirementAnalysisMd: string;
  studyNotesMd: string;
  homeworkSolutionMd: string;
  outputFormat?: DeliverableFormat;
  deliverableHtml?: string;
  contextSourcesUsed?: string[];
  generatedAt: string;
  modelUsed: string;
}

export interface TaskRecord {
  id: string;
  courseId: string;
  courseName: string;
  title: string;
  url: string;
  dueDate: string | null;
  submissionStatus: string;
  isSubmittedInAules?: boolean;
  requiresOnlineSubmission?: boolean;
  submittedWorkText?: string;
  exportFormats?: DeliverableFormat[];
  descriptionText: string;
  attachments: AttachmentRecord[];
  deliverables?: TaskDeliverables;
  status: TaskStatus;
  errorMessage?: string;
  driveFolderId?: string;
  driveFolderLink?: string;
  driveFiles?: Array<{
    name: string;
    fileId: string;
    webViewLink: string;
    updatedAt: string;
  }>;
  updatedAt: string;
}

export interface CourseRecord {
  id: string;
  name: string;
  shortname: string;
  url: string;
  resourceCount: number;
  taskCount: number;
  lastScannedAt: string;
}

export interface SubjectKnowledge {
  courseId: string;
  courseName: string;
  summary: string;
  studentWorkStyle?: string;
  studentPreferredFormats?: string[];
  keyConcepts: string[];
  evaluationCriteria: string[];
  studyTips: string[];
  glossary: Array<{ term: string; definition: string }>;
  learnedTaskIds: string[];
  updatedAt: string;
  driveFileId?: string;
  driveWebViewLink?: string;
}

export interface PipelineLogEntry {
  id: string;
  timestamp: string;
  stage: PipelineStageIndex;
  level: 'info' | 'success' | 'warning' | 'error';
  message: string;
  detail?: string;
}

export interface DriveConflictItem {
  key: string;
  taskId?: string;
  courseId: string;
  courseName: string;
  taskTitle?: string;
  folderId: string;
  existingFileId: string;
  fileName: string;
  mimeType: string;
  reason: string;
}

export interface PipelineStageState {
  index: PipelineStageIndex;
  title: string;
  description: string;
  status: 'pending' | 'active' | 'completed' | 'error' | 'paused';
  completedItems: number;
  totalItems: number;
}

export interface PipelineRun {
  id: string;
  uid: string;
  status: PipelineStatus;
  currentStage: PipelineStageIndex;
  overallProgress: number;
  currentItemLabel: string;
  startedAt: string;
  finishedAt?: string;
  stages: PipelineStageState[];
  logs: PipelineLogEntry[];
  pendingConfirmations: DriveConflictItem[];
  errorMessage?: string;
}

export interface UserAgentStore {
  uid: string;
  email: string;
  aulesProfile: AulesProfile | null;
  encryptedAulesSession?: string;
  selectedModel: string;
  autoSyncEnabled: boolean;
  autoSyncIntervalMinutes: number;
  driveRootFolderId: string | null;
  driveRootFolderLink: string | null;
  courses: CourseRecord[];
  courseResources?: Record<string, AttachmentRecord[]>;
  tasks: TaskRecord[];
  knowledge: Record<string, SubjectKnowledge>;
  runs: PipelineRun[];
}
