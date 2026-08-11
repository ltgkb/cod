import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

interface GitCommandOptions {
  maxBuffer: number;
  timeoutMilliseconds: number;
  executable?: string;
}

export async function executeGitCommand(root: string, args: string[], options: GitCommandOptions) {
  return execFileAsync(options.executable ?? 'git', args, {
    cwd: root,
    maxBuffer: options.maxBuffer,
    timeout: options.timeoutMilliseconds,
    killSignal: 'SIGKILL',
  });
}

export function commandTimedOut(error: unknown): boolean {
  const details = error as { killed?: boolean; code?: string };
  return details?.killed === true || details?.code === 'ETIMEDOUT';
}
