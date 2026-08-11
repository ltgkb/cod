import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const maximumOwnershipFileBytes = 16 * 1024;

export interface GooseOwnershipRecord {
  version: 1;
  ownerPid: number;
  sidecarPid: number;
  executablePath: string;
  port: number;
  createdAt: string;
}

interface ProcessIdentity {
  executablePath: string;
  commandLine: string;
}

interface CleanupAdapters {
  processExists(pid: number): Promise<boolean>;
  inspectProcess(pid: number): Promise<ProcessIdentity | null>;
  terminateProcess(pid: number): Promise<void>;
}

export type AbandonedSidecarCleanupResult = 'none' | 'active-owner' | 'terminated' | 'discarded';

function validPid(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 1 && Number(value) <= 0x7fffffff;
}

function parseOwnershipRecord(raw: string): GooseOwnershipRecord | null {
  try {
    const parsed = JSON.parse(raw) as Partial<GooseOwnershipRecord>;
    const createdAt = typeof parsed.createdAt === 'string' ? Date.parse(parsed.createdAt) : Number.NaN;
    if (parsed.version !== 1
      || !validPid(parsed.ownerPid)
      || !validPid(parsed.sidecarPid)
      || typeof parsed.executablePath !== 'string'
      || !path.isAbsolute(parsed.executablePath)
      || parsed.executablePath.length > 4_096
      || !Number.isInteger(parsed.port)
      || Number(parsed.port) < 1
      || Number(parsed.port) > 65_535
      || !Number.isFinite(createdAt)
      || createdAt > Date.now() + 5 * 60_000) return null;
    return parsed as GooseOwnershipRecord;
  } catch {
    return null;
  }
}

async function readOwnershipRecord(filePath: string): Promise<GooseOwnershipRecord | null> {
  try {
    const stats = await fs.lstat(filePath);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > maximumOwnershipFileBytes) return null;
    if (process.platform !== 'win32') await fs.chmod(filePath, 0o600);
    return parseOwnershipRecord(await fs.readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

export async function saveGooseOwnershipRecord(filePath: string, record: GooseOwnershipRecord): Promise<void> {
  if (!parseOwnershipRecord(JSON.stringify(record))) throw new Error('Invalid Goose ownership record');
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify(record)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    if (process.platform !== 'win32') await fs.chmod(temporaryPath, 0o600);
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function clearGooseOwnershipRecord(filePath: string, expectedSidecarPid?: number): Promise<void> {
  if (expectedSidecarPid !== undefined) {
    const record = await readOwnershipRecord(filePath);
    if (record && record.sidecarPid !== expectedSidecarPid) return;
  }
  await fs.rm(filePath, { force: true });
}

async function processExists(pid: number): Promise<boolean> {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

async function inspectProcess(pid: number): Promise<ProcessIdentity | null> {
  try {
    if (process.platform === 'linux') {
      const [executablePath, commandLine] = await Promise.all([
        fs.realpath(`/proc/${pid}/exe`),
        fs.readFile(`/proc/${pid}/cmdline`, 'utf8'),
      ]);
      return { executablePath, commandLine: commandLine.split('\0').filter(Boolean).join(' ') };
    }
    if (process.platform === 'darwin') {
      const [{ stdout: openFiles }, { stdout: commandLine }] = await Promise.all([
        execFileAsync('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'txt', '-Fn'], { maxBuffer: 256 * 1024 }),
        execFileAsync('/bin/ps', ['-p', String(pid), '-o', 'command='], { maxBuffer: 256 * 1024 }),
      ]);
      const executablePath = openFiles.split('\n').find((line) => line.startsWith('n'))?.slice(1) ?? '';
      return executablePath ? { executablePath, commandLine: commandLine.trim() } : null;
    }
    if (process.platform === 'win32') {
      const script = '$p = Get-CimInstance Win32_Process -Filter ("ProcessId = " + [int]$args[0]); if ($null -ne $p) { [Console]::Out.Write($p.ExecutablePath + [Environment]::NewLine + $p.CommandLine) }';
      const { stdout } = await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script, String(pid)], { maxBuffer: 256 * 1024 });
      const [executablePath = '', ...commandParts] = stdout.split(/\r?\n/);
      return executablePath ? { executablePath, commandLine: commandParts.join(' ').trim() } : null;
    }
  } catch {
    return null;
  }
  return null;
}

async function terminateProcess(pid: number): Promise<void> {
  try { process.kill(pid, 'SIGTERM'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return; else throw error; }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (!await processExists(pid)) return;
  }
  try { process.kill(pid, 'SIGKILL'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
}

function sameExecutablePath(actual: string, expected: string): boolean {
  const normalize = (value: string) => path.normalize(value).replace(/[/\\]+$/, '');
  return process.platform === 'win32'
    ? normalize(actual).toLocaleLowerCase('en-US') === normalize(expected).toLocaleLowerCase('en-US')
    : normalize(actual) === normalize(expected);
}

function matchesOwnership(identity: ProcessIdentity, record: GooseOwnershipRecord): boolean {
  if (!sameExecutablePath(identity.executablePath, record.executablePath)) return false;
  const commandLine = identity.commandLine;
  return /(?:^|\s)serve(?:\s|$)/.test(commandLine)
    && /(?:^|\s)--host(?:=|\s+)127\.0\.0\.1(?:\s|$)/.test(commandLine)
    && new RegExp(`(?:^|\\s)--port(?:=|\\s+)${record.port}(?:\\s|$)`).test(commandLine)
    && /(?:^|\s)--with-builtin(?:=|\s+)developer(?:\s|$)/.test(commandLine);
}

const defaultCleanupAdapters: CleanupAdapters = { processExists, inspectProcess, terminateProcess };

export async function cleanupAbandonedGooseSidecar(
  filePath: string,
  adapters: CleanupAdapters = defaultCleanupAdapters,
): Promise<AbandonedSidecarCleanupResult> {
  let record: GooseOwnershipRecord | null = null;
  try {
    const stats = await fs.lstat(filePath);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > maximumOwnershipFileBytes) {
      await clearGooseOwnershipRecord(filePath);
      return 'discarded';
    }
    record = await readOwnershipRecord(filePath);
  } catch {
    return 'none';
  }
  if (!record) {
    await clearGooseOwnershipRecord(filePath);
    return 'discarded';
  }
  if (record.ownerPid !== process.pid && await adapters.processExists(record.ownerPid)) return 'active-owner';
  if (!await adapters.processExists(record.sidecarPid)) {
    await clearGooseOwnershipRecord(filePath, record.sidecarPid);
    return 'discarded';
  }
  const firstIdentity = await adapters.inspectProcess(record.sidecarPid);
  const secondIdentity = firstIdentity && matchesOwnership(firstIdentity, record)
    ? await adapters.inspectProcess(record.sidecarPid)
    : null;
  if (!firstIdentity || !secondIdentity || !matchesOwnership(secondIdentity, record)) {
    await clearGooseOwnershipRecord(filePath, record.sidecarPid);
    return 'discarded';
  }
  await adapters.terminateProcess(record.sidecarPid);
  await clearGooseOwnershipRecord(filePath, record.sidecarPid);
  return 'terminated';
}
