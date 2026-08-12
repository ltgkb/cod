import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';
import type { WorkspaceFile } from '@cod/contracts';
import { isWithinRoot } from './command-policy.js';

const defaultMaximumNodes = 5_000;
const defaultMaximumEntriesPerDirectory = 200;
const defaultMaximumDepth = 4;
const maximumTextFileSizeBytes = 1024 * 1024;
const generatedDirectoryNames = new Set(['coverage', 'dist', 'node_modules', 'out', 'release', 'target']);

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
  return !name.startsWith('.') && !generatedDirectoryNames.has(name);
}

async function collectDirectory(root: string, directory: string, depth: number, budget: TraversalBudget): Promise<WorkspaceFile[]> {
  if (depth > budget.maximumDepth) return [];
  if (budget.remaining <= 0) {
    budget.truncated = true;
    return [];
  }

  const files: WorkspaceFile[] = [];
  const entries = (await fs.readdir(directory, { withFileTypes: true }))
    .filter((entry) => isVisibleEntry(entry.name))
    .sort((left, right) => {
      const directoryOrder = Number(right.isDirectory()) - Number(left.isDirectory());
      return directoryOrder || left.name.localeCompare(right.name, 'zh-CN', { numeric: true, sensitivity: 'base' });
    });
  if (entries.length > budget.maximumEntriesPerDirectory) budget.truncated = true;
  for (const entry of entries.slice(0, budget.maximumEntriesPerDirectory)) {
    if (budget.remaining <= 0) {
      budget.truncated = true;
      break;
    }
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

export async function readWorkspaceTextFile(root: string, relativePath: string): Promise<string> {
  if (typeof relativePath !== 'string'
    || !relativePath
    || relativePath.length > 4_096
    || /[\0\r\n]/.test(relativePath)
    || path.isAbsolute(relativePath)
    || path.win32.isAbsolute(relativePath)) {
    throw new Error('File path is invalid');
  }

  const realRoot = await fs.realpath(root);
  const lexicalTarget = path.resolve(realRoot, relativePath);
  if (!isWithinRoot(realRoot, lexicalTarget)) throw new Error('File is outside the selected project');
  const target = await fs.realpath(lexicalTarget);
  if (!isWithinRoot(realRoot, target)) throw new Error('File is outside the selected project');

  const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
  const handle = await fs.open(target, fsConstants.O_RDONLY | noFollow);
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new Error('Selected path is not a regular file');
    if (stats.size > maximumTextFileSizeBytes) throw new Error('File is larger than 1 MB');
    return await handle.readFile({ encoding: 'utf8' });
  } finally {
    await handle.close();
  }
}
