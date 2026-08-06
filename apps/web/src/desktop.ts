import type { ProjectSnapshot } from './types';
import { demoDiff, demoFiles } from './demoData';

export const hasDesktopBridge = () => Boolean(window.codDesktop);

export async function openProject(): Promise<ProjectSnapshot | null> {
  if (!window.codDesktop) {
    return {
      root: '/home/ubuntu/cod-project/cod',
      files: demoFiles,
      diff: demoDiff,
      selectedFile: 'apps/web/src/App.tsx',
      selectedContent: 'export function App() {\n  return <main className="workspace" />;\n}\n',
    };
  }

  const root = await window.codDesktop.selectProject();
  if (!root) return null;
  const [files, diff] = await Promise.all([
    window.codDesktop.listFiles(root),
    window.codDesktop.gitDiff(root),
  ]);
  return { root, files, diff, selectedFile: null, selectedContent: '' };
}

export async function readProjectFile(root: string, relativePath: string): Promise<string> {
  if (!window.codDesktop) return '桌面预览模式不会读取本机文件。';
  return window.codDesktop.readTextFile(root, relativePath);
}
