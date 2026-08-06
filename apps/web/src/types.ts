import type { TaskStatus, WorkspaceFile } from '@cod/contracts';

export type WorkspaceMode = 'code' | 'chat';
export type InspectorTab = 'changes' | 'files' | 'terminal';

export interface TimelineItem {
  id: string;
  kind: 'thought' | 'tool' | 'message' | 'permission';
  title: string;
  detail: string;
  status?: TaskStatus;
}

export interface ProjectSnapshot {
  root: string;
  files: WorkspaceFile[];
  diff: string;
  selectedFile: string | null;
  selectedContent: string;
}
