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
  upstreamSourceId: 'ai-kai' | 'demo';
  status: 'live' | 'catalog' | 'demo' | 'unavailable';
  callable: boolean;
  paymentDirection: string;
  commissionRateBps: number;
  models: ModelInfo[];
  note: string;
}

export interface CodSession {
  token: string;
  account: AccountSummary;
  sources: ModelSourceInfo[];
}

export interface CapabilityReport {
  authentication: { mode: 'password'; registrationEnabled: boolean; inviteCodeOptional: boolean; inviteCodeRequired: boolean; accessCodeRequired: false };
  ai: { mode: 'live' | 'demo' | 'unavailable'; streaming: boolean; streamingMode: 'buffered-sse' };
  knowledge: { mode: 'live' | 'demo' };
  payments: { topupEnabled: boolean; orderApi: boolean; channels?: Array<'wechat' | 'alipay'>; mode: 'pilot-credit' | 'verified-webhook' | 'official-merchant' | 'unavailable' };
  synchronization: { transport: 'polling'; taskStatusVersioning: boolean; taskCancellation?: boolean };
  remote: { feishu: 'live' | 'unavailable'; wecom: 'adapter' | 'unavailable' };
}

export interface ApiErrorBody { error?: string; message?: string }

export interface RemoteTask {
  id: string;
  title: string;
  status: TaskStatus;
  deviceId: string;
  updatedAt: string;
  version: number;
  result: string | null;
  error: string | null;
}

export interface LedgerEntry {
  id: string;
  type: 'topup' | 'usage' | 'pack_purchase' | 'credit_grant' | 'trial_credit';
  amountCents: number;
  walletAmountCents: number;
  creditAmountCents: number;
  createdAt: string;
  reference: string;
  sourceId: string | null;
  upstreamSourceId?: string | null;
  model: string | null;
  paymentDirection: string | null;
  commissionRateBps?: number;
  commissionCents?: number;
}

export interface CreditPackDefinition {
  id: 'starter' | 'standard' | 'pro' | 'team';
  name: string;
  priceCents: number;
  creditCents: number;
  bonusPercent: number;
  validityDays: 180;
}

export interface CreditGrant {
  id: string;
  packId: string;
  name: string;
  originalCents: number;
  remainingCents: number;
  purchasedAt: string;
  expiresAt: string;
  status: 'active' | 'depleted' | 'expired';
}

export interface ReferralSummary {
  inviteCode: string;
  referredUsers: number;
  commissionRateBps: number;
  pendingCommissionCents: number;
  settledCommissionCents: number;
}

export interface CreditPackState { packs: CreditPackDefinition[]; summary: { availableCents: number; grants: CreditGrant[] } }

export interface PaymentOrder {
  id: string;
  amountCents: number;
  currency: 'CNY';
  channel: 'wechat' | 'alipay';
  status: 'pending' | 'paid' | 'failed' | 'expired' | 'refunded';
  providerPaymentId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PaymentCheckout { kind: 'qr' | 'redirect'; url: string; expiresAt: string }
export interface PaymentOrderResult { order: PaymentOrder; checkout: PaymentCheckout }

export interface ComputeOffer {
  id: string; title: string; gpuModel: string; gpuMemoryGb: number; gpuCount: number; region: string; provider: string;
  priceCents: number | null; priceUnit: 'card-hour' | 'server-hour' | 'month' | 'quote'; minimumUnits: number;
  delivery: string; network: string; availability: 'ready' | 'limited' | 'quote'; verified: boolean; tags: string[];
}

export interface ComputeRequestInput {
  kind: 'rental' | 'supply' | 'installment'; offerId?: string | null; company: string; contactName: string; contactPhone: string;
  city: string; gpuModel: string; quantity: number; durationHours?: number | null; termMonths?: number | null; requirements: string;
}

export interface ComputeRequest extends ComputeRequestInput {
  id: string; email: string; offerId: string | null; durationHours: number | null; termMonths: number | null;
  status: 'submitted' | 'contacting' | 'quoted' | 'closed'; createdAt: string; updatedAt: string;
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
  const nativeRuntime = (window as Window & { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  if (nativeRuntime?.isNativePlatform?.() || window.location.protocol === 'capacitor:' || window.location.protocol === 'ionic:') {
    return 'https://cod.kai.com';
  }
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

export async function listModelCatalog(): Promise<ModelSourceInfo[]> {
  const catalog = await request<unknown>('/api/model-catalog');
  if (!Array.isArray(catalog)) throw new ApiError('模型目录返回格式无效', 502, 'invalid_model_catalog');
  return catalog as ModelSourceInfo[];
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

export async function loginCod(email: string, password: string): Promise<CodSession> {
  const login = await request<{ token: string }>('/api/auth/login', undefined, {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
  storageSet(sessionStorageKey, login.token);
  return hydrateSession(login.token);
}

export async function registerCod(input:{email:string;password:string;inviteCode?:string;legacyAccessCode?:string}):Promise<CodSession>{
  const registration=await request<{token:string}>('/api/auth/register',undefined,{method:'POST',body:JSON.stringify(input)});
  storageSet(sessionStorageKey,registration.token);
  return hydrateSession(registration.token);
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

export async function getReferralSummary(token: string): Promise<ReferralSummary> {
  return request('/api/referrals', token);
}

export async function getCreditPacks(token:string):Promise<CreditPackState>{return request('/api/credit-packs',token);}

export async function purchaseCreditPack(token:string,packId:string):Promise<{grant:CreditGrant;account:AccountSummary;summary:CreditPackState['summary']}>{
  return request(`/api/credit-packs/${encodeURIComponent(packId)}/purchase`,token,{method:'POST',headers:{'idempotency-key':createClientId()}});
}

export async function topup(token: string, amountCents: number): Promise<AccountSummary> {
  const result = await request<{ account: AccountSummary }>('/api/topups', token, {
    method: 'POST',
    headers: { 'idempotency-key': createClientId() },
    body: JSON.stringify({ amountCents, channel: 'pilot' }),
  });
  return result.account;
}

export async function createPaymentOrder(token: string, amountCents: number, channel: PaymentOrder['channel']): Promise<PaymentOrderResult> {
  return request('/api/payment-orders', token, {
    method: 'POST',
    headers: { 'idempotency-key': createClientId() },
    body: JSON.stringify({ amountCents, channel }),
  });
}

export async function getPaymentOrder(token: string, orderId: string): Promise<PaymentOrder> {
  return request(`/api/payment-orders/${encodeURIComponent(orderId)}`, token);
}

export async function listComputeOffers(): Promise<ComputeOffer[]> { return request('/api/compute/offers'); }

export async function listComputeRequests(token: string): Promise<ComputeRequest[]> { return request('/api/compute/requests', token); }

export async function createComputeRequest(token: string, input: ComputeRequestInput): Promise<ComputeRequest> {
  return request('/api/compute/requests', token, { method: 'POST', headers: { 'idempotency-key': createClientId() }, body: JSON.stringify(input) });
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

export async function updateRemoteTask(token: string, task: RemoteTask, status: TaskStatus, outcome: { result?: string | null; error?: string | null } = {}): Promise<RemoteTask> {
  return request(`/api/tasks/${encodeURIComponent(task.id)}/status`, token, {
    method: 'POST',
    body: JSON.stringify({ status, expectedVersion: task.version, ...outcome }),
  });
}

export async function cancelRemoteTask(token:string,task:RemoteTask):Promise<{task:RemoteTask;cancelledRequests:number}>{
  return request(`/api/tasks/${encodeURIComponent(task.id)}/cancel`,token,{method:'POST',body:JSON.stringify({expectedVersion:task.version})});
}

export async function listProducts(token: string): Promise<ProductManifest[]> {
  return request('/api/products', token);
}

export async function launchProduct(token: string, productId: string): Promise<{ url: string; expiresAt: string; mode: 'external' | 'signed-sso' }> {
  return request(`/api/products/${encodeURIComponent(productId)}/launch`, token, { method: 'POST' });
}

function requestSignal(parent:AbortSignal|undefined,timeoutMs:number):{signal:AbortSignal;dispose():void}{
  const controller=new AbortController();
  const timeout=globalThis.setTimeout(()=>controller.abort(new DOMException('Model request timed out','TimeoutError')),timeoutMs);
  const abort=()=>controller.abort(parent?.reason??new DOMException('Task cancelled','AbortError'));
  if(parent?.aborted)abort();else parent?.addEventListener('abort',abort,{once:true});
  return{signal:controller.signal,dispose(){globalThis.clearTimeout(timeout);parent?.removeEventListener('abort',abort);}};
}

function abortableDelay(milliseconds:number,signal?:AbortSignal):Promise<void>{
  if(signal?.aborted)return Promise.reject(signal.reason??new DOMException('Task cancelled','AbortError'));
  return new Promise((resolve,reject)=>{const timeout=globalThis.setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve();},milliseconds);const abort=()=>{globalThis.clearTimeout(timeout);reject(signal?.reason??new DOMException('Task cancelled','AbortError'));};signal?.addEventListener('abort',abort,{once:true});});
}

export async function sendChat(token: string, source: string, model: string, messages: Array<{ role: 'user' | 'assistant'; content: string }>, options: { taskId?: string; signal?: AbortSignal } = {}): Promise<{ content: string; mode: 'live' | 'demo'; source: string; model: string; upstreamSource: string; paymentDirection: string; inputTokens: number; outputTokens: number; usageEstimated: boolean; fallbackUsed: boolean }> {
  const sanitizedMessages = messages.filter((message) => typeof message.content === 'string' && message.content.trim().length > 0).slice(-20).map((message) => ({ ...message, content: message.content.trim() }));
  if (!sanitizedMessages.length) throw new ApiError('消息内容不能为空。', 400, 'empty_messages');
  const requestId = createClientId();
  let result: { model?: string; choices: Array<{ message: { content: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number; input_tokens?: number; output_tokens?: number }; cod_mode?: 'demo'; cod_source?: string; cod_upstream_source?: string; cod_payment_direction?: string; cod_usage_estimated?: boolean; cod_fallback_used?: boolean } | null = null;
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const attemptSignal=requestSignal(options.signal,255_000);
    try {
      result = await request('/v1/chat/completions', token, {
        method: 'POST', headers: { 'x-request-id': requestId },
        body: JSON.stringify({ source, model, messages: sanitizedMessages, max_tokens: 4_096, stream: false, ...(options.taskId?{task_id:options.taskId}:{}) }),
        signal: attemptSignal.signal,
      });
      break;
    } catch (error) {
      lastError = error;
      if(options.signal?.aborted)throw error;
      const retryable = !(error instanceof ApiError) || error.status === 429 || error.status >= 500;
      if (!retryable || attempt === 1) throw error;
      await abortableDelay(500,options.signal);
    } finally { attemptSignal.dispose(); }
  }
  if (!result) throw lastError instanceof Error ? lastError : new ApiError('模型请求失败，请重试。', 502, 'chat_failed');
  const content = result.choices[0]?.message.content?.trim();
  if (!content) throw new ApiError('模型返回了空内容，本次回复不可用，请重试或切换模型。', 502, 'empty_model_response');
  const inputTokens = Number(result.usage?.prompt_tokens ?? result.usage?.input_tokens);
  const outputTokens = Number(result.usage?.completion_tokens ?? result.usage?.output_tokens);
  if (![inputTokens, outputTokens].every((value) => Number.isInteger(value) && value >= 0)) throw new ApiError('模型没有返回有效的 Token 用量，请重试。', 502, 'invalid_model_usage');
  return { content, mode: result.cod_mode === 'demo' ? 'demo' : 'live', source: result.cod_source ?? source, model: result.model ?? model, upstreamSource: result.cod_upstream_source ?? (source === 'demo' ? 'demo' : 'ai-kai'), paymentDirection: result.cod_payment_direction ?? '', inputTokens, outputTokens, usageEstimated: Boolean(result.cod_usage_estimated), fallbackUsed: Boolean(result.cod_fallback_used) };
}
