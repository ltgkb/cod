import type { ProjectSnapshot } from './types';

export const hasDesktopBridge = () => Boolean(window.codDesktop);

export async function openProject(): Promise<ProjectSnapshot | null> {
  if (!window.codDesktop) return null;
  const root = await window.codDesktop.selectProject();
  if (!root) return null;
  return loadProject(root);
}

export async function loadProject(root: string): Promise<ProjectSnapshot | null> {
  if (!window.codDesktop) return null;
  const [files, diff] = await Promise.all([
    window.codDesktop.listFiles(root),
    window.codDesktop.gitDiff(root),
  ]);
  return { root, files, diff, selectedFile: null, selectedContent: '' };
}

export async function readProjectFile(root: string, relativePath: string): Promise<string> {
  if (!window.codDesktop) throw new Error('Web 端无法读取本机文件');
  return window.codDesktop.readTextFile(root, relativePath);
}
