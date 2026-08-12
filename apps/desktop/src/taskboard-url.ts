import { promises as fs } from 'node:fs';
import path from 'node:path';

const maximumRuntimeDescriptorBytes = 4 * 1024;
const defaultTaskboardUrl = 'http://127.0.0.1:47823/';
type TaskboardFetch = (input: URL, init: RequestInit) => Promise<Pick<Response, 'ok'>>;

interface TaskboardRuntimeDescriptor { version: number; pid: number; url: string }
interface ResolveTaskboardUrlOptions {
  configuredUrl?: string;
  configuredRuntimeFile?: string;
  homeDirectory: string;
  platform: NodeJS.Platform;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '[::1]';
}

export function normalizeTaskboardUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'http:' || !isLoopbackHostname(url.hostname)) return null;
    if (url.username || url.password || url.hash) return null;
    if (!url.pathname.endsWith('/')) url.pathname += '/';
    return url.toString();
  } catch { return null; }
}

export function parseTaskboardRuntimeDescriptor(rawDescriptor: string, isProcessAlive: (pid: number) => boolean): string | null {
  try {
    const descriptor = JSON.parse(rawDescriptor) as Partial<TaskboardRuntimeDescriptor>;
    if (descriptor.version !== 1 || !Number.isSafeInteger(descriptor.pid) || Number(descriptor.pid) <= 0) return null;
    if (typeof descriptor.url !== 'string' || !isProcessAlive(Number(descriptor.pid))) return null;
    return normalizeTaskboardUrl(descriptor.url);
  } catch { return null; }
}

export function taskboardRuntimeCandidates(homeDirectory: string, platform: NodeJS.Platform, configuredRuntimeFile?: string): string[] {
  if (configuredRuntimeFile) return path.isAbsolute(configuredRuntimeFile) ? [configuredRuntimeFile] : [];
  const candidates = [path.join(homeDirectory, '.codex', 'dashi-taskboard', '.data', 'runtime.json')];
  if (platform === 'darwin') candidates.unshift(path.join(homeDirectory, 'Library', 'Application Support', 'Codex Taskboard', 'launcher-runtime.json'));
  return candidates;
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

async function readRuntimeDescriptor(filename: string): Promise<string | null> {
  try {
    const stats = await fs.stat(filename);
    if (!stats.isFile() || stats.size > maximumRuntimeDescriptorBytes) return null;
    return await fs.readFile(filename, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function isDefaultTaskboardReachable(): Promise<boolean> {
  try {
    const response = await fetch(new URL('health', defaultTaskboardUrl), { cache: 'no-store', signal: AbortSignal.timeout(750) });
    if (!response.ok) return false;
    const body = await response.json() as { status?: unknown };
    return body.status === 'ok';
  } catch { return false; }
}

export async function isTaskboardReachable(rawUrl: string, fetchTaskboard: TaskboardFetch = fetch): Promise<boolean> {
  const normalizedUrl = normalizeTaskboardUrl(rawUrl);
  if (!normalizedUrl) return false;
  try {
    const response = await fetchTaskboard(new URL(normalizedUrl), { cache: 'no-store', redirect: 'manual', signal: AbortSignal.timeout(750) });
    return response.ok;
  } catch { return false; }
}

export async function resolveTaskboardUrl(options: ResolveTaskboardUrlOptions): Promise<string | null> {
  if (options.configuredUrl !== undefined) {
    const configuredUrl = normalizeTaskboardUrl(options.configuredUrl);
    return configuredUrl && await isTaskboardReachable(configuredUrl) ? configuredUrl : null;
  }
  for (const filename of taskboardRuntimeCandidates(options.homeDirectory, options.platform, options.configuredRuntimeFile)) {
    const descriptor = await readRuntimeDescriptor(filename);
    if (!descriptor) continue;
    const runtimeUrl = parseTaskboardRuntimeDescriptor(descriptor, isProcessAlive);
    if (runtimeUrl && await isTaskboardReachable(runtimeUrl)) return runtimeUrl;
  }
  return await isDefaultTaskboardReachable() ? defaultTaskboardUrl : null;
}
