import { promises as fs } from 'node:fs';
import path from 'node:path';

export const allowedCommands = new Set(['npm', 'pnpm', 'cargo', 'git', 'node', 'just']);

const blockedGitSubcommands = new Set([
  'am',
  'apply',
  'checkout',
  'cherry-pick',
  'clean',
  'config',
  'difftool',
  'init',
  'merge',
  'mergetool',
  'mv',
  'notes',
  'pull',
  'rebase',
  'replace',
  'reset',
  'restore',
  'revert',
  'rm',
  'stash',
  'submodule',
  'switch',
  'update-ref',
  'worktree',
]);

const blockedGitGlobalOptions = ['-C', '-c', '--config-env', '--exec-path', '--git-dir', '--work-tree'];
const pathValueOptions = new Set([
  '--cache',
  '--cache-dir',
  '--cwd',
  '--diagnostic-dir',
  '--dir',
  '--experimental-loader',
  '--global-bin-dir',
  '--global-dir',
  '--globalconfig',
  '--heap-prof-dir',
  '--import',
  '--justfile',
  '--loader',
  '--manifest-path',
  '--output',
  '--prefix',
  '--redirect-warnings',
  '--report-directory',
  '--require',
  '--state-dir',
  '--store-dir',
  '--target-dir',
  '--userconfig',
  '--virtual-store-dir',
  '--watch-path',
  '--working-directory',
  '--workspace',
  '--workspace-dir',
  '-C',
  '-d',
  '-f',
  '-r',
  '-w',
]);

export function parseCommand(rawCommand: string): string[] {
  if (/[\0\r\n]/.test(rawCommand)) throw new Error('Command contains invalid control characters');
  const parts: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;

  for (let index = 0; index < rawCommand.trim().length; index += 1) {
    const character = rawCommand.trim()[index];
    if (character === '\\' && quote !== "'") {
      const next = rawCommand.trim()[index + 1];
      if (next && (/\s/.test(next) || next === '\\' || next === '"' || next === "'")) {
        current += next;
        index += 1;
      } else {
        current += character;
      }
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      else current += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (current) {
        parts.push(current);
        current = '';
      }
      continue;
    }
    current += character;
  }
  if (quote) throw new Error('Command contains an unfinished quote');
  if (current) parts.push(current);
  return parts;
}

function optionMatches(argument: string, option: string): boolean {
  return argument === option
    || argument.startsWith(`${option}=`)
    || (option.length === 2 && argument.startsWith(option) && argument.length > 2);
}

function gitSubcommand(args: string[]): string | null {
  for (const argument of args) {
    if (argument === '--') return null;
    if (!argument.startsWith('-')) return argument;
  }
  return null;
}

export function commandPolicyViolation(executable: string, args: string[]): string | null {
  if (!allowedCommands.has(executable)) return 'Command is not in the COD allowlist.';
  if (args.some((argument) => /[\0\r\n]/.test(argument))) return 'Command contains invalid control characters.';

  if (executable === 'node') {
    if (args.some((argument) => argument === '-e'
      || argument === '-p'
      || argument === '--eval'
      || argument === '--print'
      || argument.startsWith('--eval=')
      || argument.startsWith('--print=')
      || /^-[ep].+/.test(argument))) {
      return 'Inline Node.js evaluation is blocked in the embedded terminal.';
    }
    if (args.some((argument) => argument === '--run' || argument.startsWith('--run='))) {
      return 'Node.js package-script shortcuts are blocked in the embedded terminal.';
    }
    if (args.some((argument, index) => {
      const value = argument.includes('=') ? argument.slice(argument.indexOf('=') + 1) : args[index + 1];
      return (argument === '--import'
          || argument === '--loader'
          || argument === '--experimental-loader'
          || argument.startsWith('--import=')
          || argument.startsWith('--loader=')
          || argument.startsWith('--experimental-loader='))
        && typeof value === 'string'
        && /^[a-z][a-z0-9+.-]*:/i.test(value);
    })) return 'URL-based Node.js preload modules are blocked in the embedded terminal.';
  }

  if (executable === 'npm') {
    if (args.some((argument) => ['exec', 'x', 'explore', 'edit'].includes(argument))) {
      return 'npm command-execution shortcuts are blocked in the embedded terminal.';
    }
    if (args.some((argument) => (argument.startsWith('-c') && !argument.startsWith('--'))
      || argument === '--call'
      || argument.startsWith('--call='))) {
      return 'npm shell-call options are blocked in the embedded terminal.';
    }
  }

  if (executable === 'pnpm' && args.some((argument) => ['exec', 'dlx', 'create'].includes(argument))) {
    return 'pnpm command-execution shortcuts are blocked in the embedded terminal.';
  }

  if (executable !== 'git') return null;
  if (args.some((argument) => blockedGitGlobalOptions.some((option) => optionMatches(argument, option)))) {
    return 'Git repository redirection and configuration overrides are blocked in the embedded terminal.';
  }
  const subcommand = gitSubcommand(args);
  if (!subcommand) return null;
  if (blockedGitSubcommands.has(subcommand)) return `Git ${subcommand} is blocked in the embedded terminal.`;
  if (args.some((argument) => argument === '--ext-diff'
    || argument === '--textconv'
    || argument === '--extcmd'
    || argument.startsWith('--extcmd=')
    || argument === '--open-files-in-pager'
    || argument.startsWith('--open-files-in-pager='))) {
    return 'Git external helper execution is blocked in the embedded terminal.';
  }
  if (subcommand === 'branch' && args.some((argument) => /^-[dDmMcCfF](?:.+)?$/.test(argument)
    || ['--delete', '--move', '--copy', '--force'].includes(argument))) {
    return 'Destructive Git branch operations are blocked in the embedded terminal.';
  }
  if (subcommand === 'tag' && args.some((argument) => /^-[df](?:.+)?$/.test(argument)
    || argument === '--delete'
    || argument === '--force')) {
    return 'Destructive Git tag operations are blocked in the embedded terminal.';
  }
  if (subcommand === 'push' && args.some((argument) => /^-[^-]*f/.test(argument)
    || argument === '--force'
    || argument.startsWith('--force-with-lease')
    || argument === '--delete'
    || argument === '--mirror'
    || argument === '--prune')) {
    return 'Destructive Git push operations are blocked in the embedded terminal.';
  }
  return null;
}

function valueAfterEquals(argument: string): string | null {
  const separator = argument.indexOf('=');
  return separator >= 0 ? argument.slice(separator + 1) : null;
}

function looksLikeExplicitPath(value: string): boolean {
  return path.isAbsolute(value)
    || path.win32.isAbsolute(value)
    || value.startsWith('./')
    || value.startsWith('.\\')
    || value.includes('/')
    || value.includes('\\')
    || value.split(/[\\/]+/).includes('..')
    || value.startsWith('file:');
}

export function commandPathCandidates(_executable: string, args: string[]): string[] {
  const candidates = new Set<string>();
  const consumed = new Set<number>();

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    for (const option of pathValueOptions) {
      if (argument === option && args[index + 1]) {
        candidates.add(args[index + 1]);
        consumed.add(index + 1);
      } else if (argument.startsWith(`${option}=`)) {
        const value = valueAfterEquals(argument);
        if (value) candidates.add(value);
      } else if (option.length === 2 && argument.startsWith(option) && argument.length > 2) {
        candidates.add(argument.slice(2));
      }
    }

    const assignedValue = valueAfterEquals(argument);
    if (assignedValue && looksLikeExplicitPath(assignedValue)) candidates.add(assignedValue);
    else if (looksLikeExplicitPath(argument)) candidates.add(argument);
  }

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (consumed.has(index) || argument === '--' || argument.startsWith('-')) continue;
    candidates.add(argument);
  }
  return [...candidates].filter(Boolean);
}

export function isWithinRoot(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export async function validateCommandPath(root: string, candidate: string): Promise<void> {
  if (candidate.startsWith('file:')) throw new Error('File URLs are blocked in the embedded terminal.');
  if (path.win32.isAbsolute(candidate) && !path.isAbsolute(candidate)) {
    throw new Error(`Command path is outside the selected project: ${candidate}`);
  }

  const realRoot = await fs.realpath(root);
  const absoluteTarget = path.resolve(realRoot, candidate);
  if (!isWithinRoot(realRoot, absoluteTarget)) throw new Error(`Command path is outside the selected project: ${candidate}`);

  let probe = absoluteTarget;
  const missingSegments: string[] = [];
  while (true) {
    try {
      const realProbe = await fs.realpath(probe);
      const resolvedTarget = path.resolve(realProbe, ...missingSegments);
      if (!isWithinRoot(realRoot, resolvedTarget)) throw new Error(`Command path escapes the selected project: ${candidate}`);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
      const parent = path.dirname(probe);
      if (parent === probe) throw error;
      missingSegments.unshift(path.basename(probe));
      probe = parent;
    }
  }
}
