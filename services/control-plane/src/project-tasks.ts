import { HttpError } from './errors.js';

export type ProjectTaskStatus = 'todo' | 'in_progress' | 'in_review' | 'blocked' | 'done' | 'cancelled';
export type ProjectTaskPriority = 'low' | 'medium' | 'high' | 'urgent';
export type ProjectTaskCommentAuthor = 'user' | 'agent' | 'system';

export interface ProjectTask {
  id: string;
  projectId: string;
  title: string;
  description: string;
  priority: ProjectTaskPriority | null;
  status: ProjectTaskStatus;
  version: number;
  claimedByThreadId: string | null;
  claimedByAgentId: string | null;
  branch: string | null;
  worktreePath: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectTaskComment {
  id: string;
  taskId: string;
  body: string;
  authorType: ProjectTaskCommentAuthor;
  authorId: string | null;
  threadId: string | null;
  createdAt: string;
}

export interface ProjectTaskCreateInput {
  title: string;
  description: string;
  priority: ProjectTaskPriority | null;
}

export interface ProjectTaskTransitionInput {
  status: ProjectTaskStatus;
  ifVersion: number;
  threadId: string | null;
  userAccepted: boolean;
}

export interface ProjectTaskCommentInput {
  body: string;
  threadId: string | null;
  ifVersion: number;
}

const statuses = new Set<ProjectTaskStatus>(['todo', 'in_progress', 'in_review', 'blocked', 'done', 'cancelled']);
const priorities = new Set<ProjectTaskPriority>(['low', 'medium', 'high', 'urgent']);
const transitions: Record<ProjectTaskStatus, ReadonlySet<ProjectTaskStatus>> = {
  todo: new Set(['in_progress', 'cancelled']),
  in_progress: new Set(['in_review', 'blocked', 'cancelled']),
  in_review: new Set(['in_progress', 'done', 'cancelled']),
  blocked: new Set(['in_progress', 'cancelled']),
  done: new Set(),
  cancelled: new Set(),
};

function record(value: unknown, allowedKeys: readonly string[], code: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError('Taskboard request is invalid', 400, code);
  if (Object.keys(value).some((key) => !allowedKeys.includes(key))) throw new HttpError('Taskboard request contains unsupported fields', 400, code);
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string, maxLength: number, required: boolean): string {
  if (typeof value !== 'string') {
    if (!required && value === undefined) return '';
    throw new HttpError(`${field} is invalid`, 400, 'invalid_project_task');
  }
  const normalized = value.trim();
  if ((required && !normalized) || normalized.length > maxLength) throw new HttpError(`${field} is invalid`, 400, 'invalid_project_task');
  return normalized;
}

function version(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new HttpError('Task version is invalid', 400, 'invalid_task_version');
  return Number(value);
}

function threadId(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(value)) throw new HttpError('Task thread is invalid', 400, 'invalid_task_thread');
  return value;
}

export function validateProjectId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(value)) throw new HttpError('Project ID is invalid', 400, 'invalid_project_id');
  return value;
}

export function validateProjectTaskCreateInput(value: unknown): ProjectTaskCreateInput {
  const input = record(value, ['title', 'description', 'priority'], 'invalid_project_task');
  const priority = input.priority === undefined || input.priority === null || input.priority === '' ? null : input.priority;
  if (priority !== null && (typeof priority !== 'string' || !priorities.has(priority as ProjectTaskPriority))) throw new HttpError('Task priority is invalid', 400, 'invalid_task_priority');
  return {
    title: text(input.title, 'Task title', 500, true),
    description: text(input.description, 'Task description', 50_000, false),
    priority: priority as ProjectTaskPriority | null,
  };
}

export function validateProjectTaskTransitionInput(value: unknown): ProjectTaskTransitionInput {
  const input = record(value, ['status', 'ifVersion', 'threadId', 'userAccepted'], 'invalid_task_transition');
  if (typeof input.status !== 'string' || !statuses.has(input.status as ProjectTaskStatus)) throw new HttpError('Task status is invalid', 400, 'invalid_task_status');
  if (input.userAccepted !== undefined && typeof input.userAccepted !== 'boolean') throw new HttpError('Task acceptance is invalid', 400, 'invalid_task_acceptance');
  return {
    status: input.status as ProjectTaskStatus,
    ifVersion: version(input.ifVersion),
    threadId: threadId(input.threadId),
    userAccepted: input.userAccepted === true,
  };
}

export function validateProjectTaskCommentInput(value: unknown): ProjectTaskCommentInput {
  const input = record(value, ['body', 'threadId', 'ifVersion', 'authorType'], 'invalid_task_comment');
  if (input.authorType !== undefined && input.authorType !== 'user') throw new HttpError('Comment author is invalid', 400, 'invalid_comment_author');
  return {
    body: text(input.body, 'Comment body', 50_000, true),
    threadId: threadId(input.threadId),
    ifVersion: version(input.ifVersion),
  };
}

export function assertProjectTaskTransition(current: ProjectTaskStatus, input: ProjectTaskTransitionInput): void {
  if (!transitions[current].has(input.status)) throw new HttpError('Task status transition is invalid', 409, 'invalid_task_transition');
  if (input.status === 'in_progress' && !input.threadId) throw new HttpError('A thread is required to claim this task', 400, 'task_thread_required');
  if (input.status === 'done' && !input.userAccepted) throw new HttpError('User acceptance is required to complete a task', 409, 'task_acceptance_required');
  if (input.status !== 'done' && input.userAccepted) throw new HttpError('Task acceptance is only valid when completing a task', 400, 'invalid_task_acceptance');
}
