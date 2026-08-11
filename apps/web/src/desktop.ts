import type { ProjectSnapshot } from './types';

export const hasDesktopBridge = () => Boolean(window.codDesktop);

export async function selectProjectRoot(): Promise<string | null> {
  if (!window.codDesktop) return null;
  return window.codDesktop.selectProject();
}

export async function loadProjectFiles(root: string): Promise<ProjectSnapshot | null> {
  if (!window.codDesktop) return null;
  const files = await window.codDesktop.listFiles(root);
  return { root, files, diff: '', selectedFile: null, selectedContent: '' };
}

export async function loadProjectDiff(root: string): Promise<string | null> {
  if (!window.codDesktop) return null;
  return window.codDesktop.gitDiff(root);
}

export async function loadProject(root: string): Promise<ProjectSnapshot | null> {
  const snapshot = await loadProjectFiles(root);
  if (!snapshot) return null;
  const diff = await loadProjectDiff(root);
  return diff === null ? null : { ...snapshot, diff };
}

export async function readProjectFile(root: string, relativePath: string): Promise<string> {
  if (!window.codDesktop) throw new Error('Web 端无法读取本机文件');
  return window.codDesktop.readTextFile(root, relativePath);
}
