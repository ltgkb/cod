import type { AccountSummary, DeviceRecord, KnowledgeHit, ProductManifest, TaskStatus } from '@cod/contracts';

const configuredControlPlaneUrl = import.meta.env.VITE_COD_CONTROL_PLANE_URL;
const sessionStorageKey = 'cod.session.token';

export interface ModelInfo {
  id: string;
  label: string;
  contextWindow: number;
  inputPricePerMillionCents?: number;
  outputPricePerMillionCents?: number;
}

export interface CodSession {
  token: string;
  account: AccountSummary;
  models: ModelInfo[];
}

export interface CapabilityReport {
  authentication: { mode: 'pilot'; accessCodeRequired: boolean };
  ai: { mode: 'live' | 'demo' | 'unavailable'; streaming: boolean };
  knowledge: { mode: 'live' | 'demo' };
  payments: { topupEnabled: boolean };
  synchronization: { transport: 'polling'; taskStatusVersioning: boolean };
}

export interface ApiErrorBody { error?: string; message?: string }

export interface RemoteTask {
  id: string;
  title: string;
  status: TaskStatus;
  deviceId: string;
  updatedAt: string;
  version: number;
}

export interface LedgerEntry {
  id: string;
  type: 'topup' | 'usage';
  amountCents: number;
  createdAt: string;
  reference: string;
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
  }
}

function storageGet(key: string): string | null {
  try { return window.localStorage.getItem(key); } catch { return null; }
}

function storageSet(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Private browser contexts may disable storage; the current session still works.
  }
}

export function getControlPlaneUrl(): string {
  if (configuredControlPlaneUrl) return configuredControlPlaneUrl.replace(/\/$/, '');
  if (window.location.protocol === 'file:') return window.codDesktop?.controlPlaneUrl?.replace(/\/$/, '') ?? '';
  return '';
}

async function request<T>(path: string, token?: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${getControlPlaneUrl()}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as ApiErrorBody;
    throw new ApiError(body.message ?? `Control plane request failed: ${response.status}`, response.status, body.error ?? 'request_failed');
  }
  return response.json() as Promise<T>;
}

async function hydrateSession(token: string): Promise<CodSession> {
  const [account, models] = await Promise.all([
    request<AccountSummary>('/api/account', token),
    request<ModelInfo[]>('/api/models', token),
  ]);
  return { token, account, models };
}

export async function getCapabilities(): Promise<CapabilityReport> {
  return request('/api/capabilities');
}

export async function resumeCodSession(): Promise<CodSession | null> {
  const token = storageGet(sessionStorageKey);
  if (!token) return null;
  try {
    return await hydrateSession(token);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) storageSet(sessionStorageKey, null);
    return null;
  }
}

export async function loginCod(email: string, accessCode: string): Promise<CodSession> {
  const login = await request<{ token: string }>('/api/auth/login', undefined, {
    method: 'POST',
    body: JSON.stringify({ email, accessCode }),
  });
  storageSet(sessionStorageKey, login.token);
  return hydrateSession(login.token);
}

export function logoutCod(): void {
  storageSet(sessionStorageKey, null);
}

export async function refreshAccount(token: string): Promise<AccountSummary> {
  return request('/api/account', token);
}

export async function listLedger(token: string): Promise<LedgerEntry[]> {
  return request('/api/ledger', token);
}

export async function topup(token: string, amountCents: number): Promise<AccountSummary> {
  const result = await request<{ account: AccountSummary }>('/api/topups', token, {
    method: 'POST',
    headers: { 'idempotency-key': crypto.randomUUID() },
    body: JSON.stringify({ amountCents, channel: 'mock' }),
  });
  return result.account;
}

export async function searchKnowledge(token: string, query: string): Promise<KnowledgeHit[]> {
  return request(`/api/knowledge/search?q=${encodeURIComponent(query)}`, token);
}

export async function listDevices(token: string): Promise<DeviceRecord[]> {
  return request('/api/devices', token);
}

export async function registerDevice(token: string, name: string, platform: DeviceRecord['platform']): Promise<DeviceRecord> {
  return request('/api/devices', token, { method: 'POST', body: JSON.stringify({ name, platform }) });
}

export async function heartbeatDevice(token: string, deviceId: string): Promise<DeviceRecord> {
  return request(`/api/devices/${encodeURIComponent(deviceId)}/heartbeat`, token, { method: 'POST' });
}

export async function listTasks(token: string): Promise<RemoteTask[]> {
  return request('/api/tasks', token);
}

export async function createRemoteTask(token: string, title: string, deviceId: string): Promise<RemoteTask> {
  return request('/api/tasks', token, { method: 'POST', body: JSON.stringify({ title, deviceId }) });
}

export async function updateRemoteTask(token: string, task: RemoteTask, status: TaskStatus): Promise<RemoteTask> {
  return request(`/api/tasks/${encodeURIComponent(task.id)}/status`, token, {
    method: 'POST',
    body: JSON.stringify({ status, expectedVersion: task.version }),
  });
}

export async function listProducts(token: string): Promise<ProductManifest[]> {
  return request('/api/products', token);
}

export async function sendChat(token: string, model: string, content: string): Promise<{ content: string; mode: 'live' | 'demo' }> {
  const result = await request<{ choices: Array<{ message: { content: string } }>; cod_mode?: 'demo' }>('/v1/chat/completions', token, {
    method: 'POST',
    body: JSON.stringify({ model, messages: [{ role: 'user', content }], stream: false }),
  });
  return { content: result.choices[0]?.message.content ?? 'COD 没有返回内容。', mode: result.cod_mode === 'demo' ? 'demo' : 'live' };
}
