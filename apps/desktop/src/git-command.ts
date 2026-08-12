import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const gitEnvironmentPattern = /^GIT_/i;

interface GitCommandOptions {
  maxBuffer: number;
  timeoutMilliseconds: number;
  executable?: string;
}

export async function executeGitCommand(root: string, args: string[], options: GitCommandOptions) {
  const executable = options.executable ?? 'git';
  const isGit = options.executable === undefined;
  const environment: NodeJS.ProcessEnv = isGit
    ? { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat' }
    : { ...process.env };
  if (isGit) {
    for (const name of Object.keys(environment)) {
      if (gitEnvironmentPattern.test(name)) delete environment[name];
    }
    environment.GIT_OPTIONAL_LOCKS = '0';
    environment.GIT_PAGER = 'cat';
  }
  const commandArguments = isGit
    ? ['--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', ...args]
    : args;
  return execFileAsync(executable, commandArguments, {
    cwd: root,
    env: environment,
    maxBuffer: options.maxBuffer,
    timeout: options.timeoutMilliseconds,
    killSignal: 'SIGKILL',
  });
}

export function commandTimedOut(error: unknown): boolean {
  const details = error as { killed?: boolean; code?: string };
  return details?.killed === true || details?.code === 'ETIMEDOUT';
}
