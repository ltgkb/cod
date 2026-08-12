import path from 'node:path';

export interface CommandInvocation {
  executable: string;
  args: string[];
}

const windowsCommandShims = new Set(['npm', 'pnpm']);
const unsafeWindowsShellCharacter = /[%!^&|<>()"]/;

/**
 * npm and pnpm are .cmd shims on Windows and cannot be launched by execFile
 * directly. Invoke only those fixed allowlisted names through cmd.exe, reject
 * shell metacharacters, and quote every already-parsed argument.
 */
export function resolveCommandInvocation(
  executable: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): CommandInvocation {
  if (platform !== 'win32' || !windowsCommandShims.has(executable)) return { executable, args };
  const unsafeArgument = args.find((argument) => unsafeWindowsShellCharacter.test(argument));
  if (unsafeArgument !== undefined) {
    throw new Error('Windows package-manager arguments cannot contain shell metacharacters.');
  }
  const configuredWindowsDirectory = environment.SystemRoot ?? environment.WINDIR ?? 'C:\\Windows';
  const windowsDirectory = path.win32.isAbsolute(configuredWindowsDirectory)
    ? configuredWindowsDirectory
    : 'C:\\Windows';
  const commandLine = [executable, ...args.map((argument) => `"${argument}"`)].join(' ');
  return {
    executable: path.win32.join(windowsDirectory, 'System32', 'cmd.exe'),
    args: ['/d', '/s', '/v:off', '/c', commandLine],
  };
}
