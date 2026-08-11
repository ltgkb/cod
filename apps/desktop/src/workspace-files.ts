import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { WorkspaceFile } from '@cod/contracts';

const defaultMaximumNodes = 5_000;
const defaultMaximumEntriesPerDirectory = 200;
const defaultMaximumDepth = 4;

interface WorkspaceFileOptions {
  maximumNodes?: number;
  maximumEntriesPerDirectory?: number;
  maximumDepth?: number;
}

interface TraversalBudget {
  remaining: number;
  truncated: boolean;
  maximumEntriesPerDirectory: number;
  maximumDepth: number;
}

function boundedOption(value: number | undefined, fallback: number, maximum: number, minimum: number): number {
  if (!Number.isInteger(value)) return fallback;
  return Math.max(minimum, Math.min(Number(value), maximum));
}

function isVisibleEntry(name: string): boolean {
  return !name.startsWith('.') && name !== 'node_modules' && name !== 'dist' && name !== 'target';
}

async function collectDirectory(root: string, directory: string, depth: number, budget: TraversalBudget): Promise<WorkspaceFile[]> {
  if (depth > budget.maximumDepth) return [];
  if (budget.remaining <= 0) {
    budget.truncated = true;
    return [];
  }

  const files: WorkspaceFile[] = [];
  const entries = await fs.opendir(directory);
  let visibleEntries = 0;
  for await (const entry of entries) {
    if (!isVisibleEntry(entry.name)) continue;
    if (visibleEntries >= budget.maximumEntriesPerDirectory || budget.remaining <= 0) {
      budget.truncated = true;
      break;
    }
    visibleEntries += 1;
    budget.remaining -= 1;
    const absolute = path.join(directory, entry.name);
    const relativePath = path.relative(root, absolute);
    const kind: WorkspaceFile['kind'] = entry.isDirectory() ? 'directory' : 'file';
    files.push({ name: entry.name, path: relativePath, kind, depth });
    if (kind === 'directory') files.push(...await collectDirectory(root, absolute, depth + 1, budget));
  }
  return files;
}

export async function collectWorkspaceFiles(root: string, options: WorkspaceFileOptions = {}): Promise<WorkspaceFile[]> {
  const maximumNodes = boundedOption(options.maximumNodes, defaultMaximumNodes, defaultMaximumNodes, 2);
  const budget: TraversalBudget = {
    remaining: maximumNodes - 1,
    truncated: false,
    maximumEntriesPerDirectory: boundedOption(
      options.maximumEntriesPerDirectory,
      defaultMaximumEntriesPerDirectory,
      defaultMaximumEntriesPerDirectory,
      1,
    ),
    maximumDepth: boundedOption(options.maximumDepth, defaultMaximumDepth, defaultMaximumDepth, 0),
  };
  const files = await collectDirectory(root, root, 0, budget);
  if (budget.truncated) {
    files.push({
      name: `… 其余文件已省略（最多显示 ${maximumNodes.toLocaleString('zh-CN')} 项）`,
      path: '',
      kind: 'directory',
      depth: 0,
    });
  }
  return files;
}
