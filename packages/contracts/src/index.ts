export type TaskStatus = 'draft' | 'running' | 'waiting' | 'complete' | 'failed';

export interface CodTask {
  id: string;
  title: string;
  project: string;
  status: TaskStatus;
  updatedAt: string;
}

export interface WorkspaceFile {
  name: string;
  path: string;
  kind: 'file' | 'directory';
  depth: number;
}

export interface TerminalResult {
  command: string;
  output: string;
  exitCode: number | null;
}

export interface DesktopBridge {
  platform: string;
  selectProject(): Promise<string | null>;
  listFiles(root: string): Promise<WorkspaceFile[]>;
  readTextFile(root: string, relativePath: string): Promise<string>;
  gitDiff(root: string): Promise<string>;
  runCommand(root: string, command: string): Promise<TerminalResult>;
}

declare global {
  interface Window {
    codDesktop?: DesktopBridge;
  }
}
