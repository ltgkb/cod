import type { AccountSummary, KnowledgeHit } from '@cod/contracts';

const controlPlaneUrl = import.meta.env.VITE_COD_CONTROL_PLANE_URL ?? 'http://127.0.0.1:8787';

export interface ModelInfo {
  id: string;
  label: string;
  contextWindow: number;
}

export interface CodSession {
  token: string;
  account: AccountSummary;
  models: ModelInfo[];
}

async function request<T>(path: string, token?: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${controlPlaneUrl}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
  });
  if (!response.ok) throw new Error(`Control plane request failed: ${response.status}`);
  return response.json() as Promise<T>;
}

export async function loadCodSession(): Promise<CodSession> {
  const login = await request<{ token: string }>('/api/auth/login', undefined, {
    method: 'POST',
    body: JSON.stringify({ email: 'developer@kai.com' }),
  });
  const [account, models] = await Promise.all([
    request<AccountSummary>('/api/account', login.token),
    request<ModelInfo[]>('/api/models', login.token),
  ]);
  return { token: login.token, account, models };
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
