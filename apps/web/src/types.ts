import type { WorkspaceFile } from '@cod/contracts';

export type WorkspaceMode = 'code' | 'chat';
export type InspectorTab = 'changes' | 'files' | 'terminal';

export interface ProjectSnapshot {
  root: string;
  files: WorkspaceFile[];
  diff: string;
  selectedFile: string | null;
  selectedContent: string;
}
