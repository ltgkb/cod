import { promises as fs } from 'node:fs';
import path from 'node:path';
import { isWithinRoot } from './command-policy.js';
import { commandTimedOut, executeGitCommand } from './git-command.js';

const untrackedFilePreviewLimitBytes = 256 * 1024;
const untrackedTotalPreviewLimitBytes = 1024 * 1024;
const untrackedContentPreviewLimit = 200;
const untrackedPathLimit = 1_000;
const untrackedOutputLimitBytes = 2 * 1024 * 1024;
const gitCommandTimeoutMilliseconds = 15_000;

interface CollectUntrackedDiffOptions {
  contentPreviewLimit?: number;
  outputLimitBytes?: number;
  pathLimit?: number;
}

export function unstagedGitDiffArguments(): string[] {
  return ['diff', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all', '--'];
}

export function stagedGitDiffArguments(): string[] {
  return ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all', '--'];
}

export function untrackedGitDiffArguments(emptyFile: string, relativePath: string): string[] {
  return ['diff', '--no-index', '--no-ext-diff', '--no-textconv', '--', emptyFile, relativePath];
}

function boundedLimit(value: number | undefined, fallback: number, maximum: number, minimum = 0): number {
  if (!Number.isInteger(value)) return fallback;
  return Math.max(minimum, Math.min(Number(value), maximum));
}

function quotedDiffPath(prefix: 'a' | 'b', relativePath: string): string {
  const normalized = relativePath.split(path.sep).join('/');
  return JSON.stringify(`${prefix}/${normalized}`);
}

function untrackedDiffPlaceholder(relativePath: string, reason: string): string {
  return [
    `diff --git ${quotedDiffPath('a', relativePath)} ${quotedDiffPath('b', relativePath)}`,
    'new file mode 100644',
    `# COD preview omitted: ${reason}`,
  ].join('\n');
}

export async function collectUntrackedDiff(root: string, options: CollectUntrackedDiffOptions = {}): Promise<string> {
  const contentPreviewLimit = boundedLimit(options.contentPreviewLimit, untrackedContentPreviewLimit, untrackedContentPreviewLimit);
  const pathLimit = boundedLimit(options.pathLimit, untrackedPathLimit, untrackedPathLimit, 1);
  const outputLimitBytes = boundedLimit(options.outputLimitBytes, untrackedOutputLimitBytes, untrackedOutputLimitBytes, 1_024);
  const summaryReserveBytes = 512;
  const entryOutputLimitBytes = outputLimitBytes - summaryReserveBytes;
  const { stdout } = await executeGitCommand(root, ['ls-files', '--others', '--exclude-standard', '-z', '--'], {
    maxBuffer: 16 * 1024 * 1024,
    timeoutMilliseconds: gitCommandTimeoutMilliseconds,
  });
  const relativePaths = stdout.split('\0').filter(Boolean);
  const diffs: string[] = [];
  let previewedBytes = 0;
  let previewedFiles = 0;
  let outputBytes = 0;
  let includedPaths = 0;

  const appendPathDiff = (diff: string): boolean => {
    const addition = `${diffs.length ? '\n' : ''}${diff}`;
    const additionBytes = Buffer.byteLength(addition, 'utf8');
    if (outputBytes + additionBytes > entryOutputLimitBytes) return false;
    diffs.push(diff);
    outputBytes += additionBytes;
    includedPaths += 1;
    return true;
  };

  for (const relativePath of relativePaths.slice(0, pathLimit)) {
    const target = path.resolve(root, relativePath);
    if (!isWithinRoot(root, target)) {
      if (!appendPathDiff(untrackedDiffPlaceholder(relativePath, 'path is outside the selected project'))) break;
      continue;
    }
    let stats;
    try {
      stats = await fs.lstat(target);
    } catch {
      if (!appendPathDiff(untrackedDiffPlaceholder(relativePath, 'file changed while the preview was loading'))) break;
      continue;
    }
    if (!stats.isFile()) {
      if (!appendPathDiff(untrackedDiffPlaceholder(relativePath, stats.isSymbolicLink() ? 'symbolic link content is not read' : 'not a regular file'))) break;
      continue;
    }
    if (stats.size > untrackedFilePreviewLimitBytes) {
      if (!appendPathDiff(untrackedDiffPlaceholder(relativePath, `file is larger than ${untrackedFilePreviewLimitBytes / 1024} KiB`))) break;
      continue;
    }
    if (previewedBytes + stats.size > untrackedTotalPreviewLimitBytes) {
      if (!appendPathDiff(untrackedDiffPlaceholder(relativePath, 'total untracked preview limit reached'))) break;
      continue;
    }
    if (previewedFiles >= contentPreviewLimit) {
      if (!appendPathDiff(untrackedDiffPlaceholder(relativePath, 'untracked content preview count reached'))) break;
      continue;
    }

    previewedBytes += stats.size;
    previewedFiles += 1;
    const emptyFile = process.platform === 'win32' ? 'NUL' : '/dev/null';
    try {
      const { stdout: diff } = await executeGitCommand(root, untrackedGitDiffArguments(emptyFile, relativePath), {
        maxBuffer: 2 * 1024 * 1024,
        timeoutMilliseconds: gitCommandTimeoutMilliseconds,
      });
      if (!appendPathDiff(diff || untrackedDiffPlaceholder(relativePath, 'empty file'))) break;
    } catch (error) {
      const details = error as Error & { code?: number | string; stdout?: string };
      if (commandTimedOut(error)) {
        appendPathDiff(untrackedDiffPlaceholder(relativePath, 'content preview timed out'));
        break;
      }
      const diff = (details.code === 1 || details.code === '1') && details.stdout
        ? details.stdout
        : untrackedDiffPlaceholder(relativePath, 'content preview failed');
      if (!appendPathDiff(diff)) break;
    }
  }
  const omittedPaths = relativePaths.length - includedPaths;
  if (omittedPaths > 0) diffs.push(`# 其余 ${omittedPaths} 个未跟踪路径已省略。`);
  return diffs.join('\n');
}

export async function collectGitDiff(root: string): Promise<string> {
  try {
    const { stdout } = await executeGitCommand(root, ['rev-parse', '--is-inside-work-tree'], {
      maxBuffer: 64 * 1024,
      timeoutMilliseconds: 3_000,
    });
    if (stdout.trim() !== 'true') return '当前目录不是 Git 工作区，暂无可显示的改动。';
  } catch (error) {
    if (commandTimedOut(error)) return 'Git 状态读取超时；项目文件仍可正常使用。可检查仓库元数据权限后重试。';
    return '当前目录不是 Git 仓库，暂无可显示的改动。初始化 Git 后即可在这里查看变更。';
  }

  try {
    const [{ stdout: unstaged }, { stdout: staged }, untracked] = await Promise.all([
      executeGitCommand(root, unstagedGitDiffArguments(), { maxBuffer: 2 * 1024 * 1024, timeoutMilliseconds: gitCommandTimeoutMilliseconds }),
      executeGitCommand(root, stagedGitDiffArguments(), { maxBuffer: 2 * 1024 * 1024, timeoutMilliseconds: gitCommandTimeoutMilliseconds }),
      collectUntrackedDiff(root),
    ]);
    return [
      unstaged && '# Unstaged changes\n' + unstaged,
      staged && '# Staged changes\n' + staged,
      untracked && '# Untracked files\n' + untracked,
    ].filter(Boolean).join('\n');
  } catch (error) {
    if (commandTimedOut(error)) return 'Git 改动读取超时；项目文件仍可正常使用。请缩小仓库范围或稍后重试。';
    return 'Git 改动读取失败；项目文件仍可正常使用。';
  }
}
