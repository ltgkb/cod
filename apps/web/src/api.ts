import type { AccountSummary, DeviceRecord, KnowledgeHit, ProductManifest, TaskStatus } from '@cod/contracts';

const configuredControlPlaneUrl = import.meta.env.VITE_COD_CONTROL_PLANE_URL;
const sessionStorageKey = 'cod.session.token';

export interface ModelInfo {
  id: string;
  label: string;
  contextWindow: number;
  inputPricePerMillionCents: number;
  outputPricePerMillionCents: number;
}

export interface ModelSourceInfo {
  id: string;
  label: string;
  status: 'live' | 'catalog' | 'demo' | 'unavailable';
  callable: boolean;
  paymentDirection: string;
  models: ModelInfo[];
  note: string;
}

export interface CodSession {
  token: string;
  account: AccountSummary;
  sources: ModelSourceInfo[];
}

export interface CapabilityReport {
  authentication: { mode: 'pilot'; accessCodeRequired: boolean };
  ai: { mode: 'live' | 'demo' | 'unavailable'; streaming: boolean };
  knowledge: { mode: 'live' | 'demo' };
  payments: { topupEnabled: boolean; mode: 'pilot-credit' | 'unavailable' };
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
  sourceId: string | null;
  model: string | null;
  paymentDirection: string | null;
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
  }
}

export function createClientId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
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
  const [account, sources] = await Promise.all([
    request<AccountSummary>('/api/account', token),
    request<ModelSourceInfo[]>('/api/model-sources', token),
  ]);
  return { token, account, sources };
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
    headers: { 'idempotency-key': createClientId() },
    body: JSON.stringify({ amountCents, channel: 'pilot' }),
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

export async function sendChat(token: string, source: string, model: string, content: string): Promise<{ content: string; mode: 'live' | 'demo'; source: string; paymentDirection: string; chargeCents: number }> {
  const result = await request<{ choices: Array<{ message: { content: string } }>; cod_mode?: 'demo'; cod_source?: string; cod_payment_direction?: string; cod_charge_cents?: number }>('/v1/chat/completions', token, {
    method: 'POST',
    body: JSON.stringify({ source, model, messages: [{ role: 'user', content }], max_tokens: 1024, stream: false }),
  });
  return { content: result.choices[0]?.message.content ?? 'COD 没有返回内容。', mode: result.cod_mode === 'demo' ? 'demo' : 'live', source: result.cod_source ?? source, paymentDirection: result.cod_payment_direction ?? '', chargeCents: result.cod_charge_cents ?? 0 };
}
