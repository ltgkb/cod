import type { CodTask, WorkspaceFile } from '@cod/contracts';
import type { TimelineItem } from './types';

export const demoTasks: CodTask[] = [
  {
    id: 'cod-stage-one',
    title: '打磨 COD 桌面工作台',
    project: 'cod-project',
    status: 'running',
    updatedAt: '刚刚',
  },
  {
    id: 'checkout-audit',
    title: '检查充值页错误处理',
    project: 'kai-pay',
    status: 'waiting',
    updatedAt: '18 分钟前',
  },
  {
    id: 'wiki-summary',
    title: '整理产品 Wiki 摘要',
    project: 'product-notes',
    status: 'complete',
    updatedAt: '昨天',
  },
];

export const demoTimeline: TimelineItem[] = [
  {
    id: 'plan',
    kind: 'thought',
    title: '已制定实施计划',
    detail: '先统一工作台布局，再接入项目文件、Diff 和终端。',
    status: 'complete',
  },
  {
    id: 'inspect',
    kind: 'tool',
    title: '读取项目结构',
    detail: '发现 42 个源文件，主要改动集中在桌面壳和共享 UI。',
    status: 'complete',
  },
  {
    id: 'edit',
    kind: 'tool',
    title: '正在调整工作台',
    detail: '重构会话导航、执行时间线和审查面板。',
    status: 'running',
  },
  {
    id: 'approval',
    kind: 'permission',
    title: '等待终端权限',
    detail: '准备运行 npm test，不会修改项目之外的文件。',
    status: 'waiting',
  },
];

export const demoFiles: WorkspaceFile[] = [
  { name: 'apps', path: 'apps', kind: 'directory', depth: 0 },
  { name: 'web', path: 'apps/web', kind: 'directory', depth: 1 },
  { name: 'App.tsx', path: 'apps/web/src/App.tsx', kind: 'file', depth: 2 },
  { name: 'styles.css', path: 'apps/web/src/styles.css', kind: 'file', depth: 2 },
  { name: 'desktop', path: 'apps/desktop', kind: 'directory', depth: 1 },
  { name: 'main.ts', path: 'apps/desktop/src/main.ts', kind: 'file', depth: 2 },
  { name: 'packages', path: 'packages', kind: 'directory', depth: 0 },
  { name: 'contracts', path: 'packages/contracts', kind: 'directory', depth: 1 },
];

export const demoDiff = `diff --git a/apps/web/src/App.tsx b/apps/web/src/App.tsx
index 22f4b3a..51b231c 100644
--- a/apps/web/src/App.tsx
+++ b/apps/web/src/App.tsx
@@ -18,7 +18,9 @@ export function App() {
-  return <main className="workspace">...</main>
+  return (
+    <main className="workspace cod-workspace">...</main>
+  )
 }`;
