import type { AccountSummary, AdminComputeRequestPage, DeviceRecord, KnowledgeHit, ProductManifest, TaskStatus } from '@cod/contracts';
import { getCodRuntime } from './runtime';

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
export type PublicModelSourceInfo = Omit<ModelSourceInfo, 'commissionRateBps'>;

export interface CodSession {
  token: string;
  account: AccountSummary;
  sources: ModelSourceInfo[];
}

export interface RegistrationVerificationChallenge {
  challengeId: string;
  maskedDestination: string;
  expiresAt: string;
  resendAt: string;
}

export interface VerifiedRegistrationInput {
  challengeId: string;
  email: string;
  phone: string;
  password: string;
  inviteCode?: string;
}

export interface LegacyMigrationInput {
  email: string;
  password: string;
  legacyAccessCode: string;
}

interface AuthenticationRequestOptions {
  signal?: AbortSignal;
  idempotencyKey?: string;
}

export interface CapabilityReport {
  authentication: {
    mode: 'password'; registrationEnabled: boolean; legacyMigrationEnabled?: boolean; inviteCodeOptional: boolean; inviteCodeRequired: boolean;
    accessCodeRequired: false; turnstileSiteKey?: string; verificationMethods?: Array<'email_otp' | 'sms_otp'>; registrationWebOnly?: boolean;
    publicRegistrationUrl?: string;
  };
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

export interface TaskExecutionLease {
  executionId: string;
  leaseToken: string;
  leaseExpiresAt: string;
}

export interface LedgerEntry {
  id: string;
  type: 'topup' | 'usage' | 'pack_purchase' | 'credit_grant' | 'trial_credit' | 'opening_balance';
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
  kind: 'rental' | 'supply' | 'hosting' | 'installment'; offerId?: string | null; company: string; contactName: string; contactPhone: string;
  city: string; gpuModel: string; quantity: number; durationHours?: number | null; termMonths?: number | null; requirements: string;
  hostingPeriodMonths?: number | null; rackUnits?: number | null; powerKilowatts?: number | null; networkMbps?: number | null;
  availabilityNotes?: string | null; settlementPreference?: string | null; hostingRequirements?: string | null;
}

export interface ComputeRequest extends ComputeRequestInput {
  id: string; email: string; offerId: string | null; durationHours: number | null; termMonths: number | null;
  hostingPeriodMonths: number | null; rackUnits: number | null; powerKilowatts: number | null; networkMbps: number | null;
  availabilityNotes: string | null; settlementPreference: string | null; hostingRequirements: string | null;
  fulfillmentMode: 'manual-confirmation' | 'third-party-manual-match';
  status: 'submitted' | 'contacting' | 'quoted' | 'closed'; createdAt: string; updatedAt: string;
}

export interface AdminComputeRequestFilters {
  cursor?: string;
  kind?: ComputeRequest['kind'];
  status?: ComputeRequest['status'];
  q?: string;
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code: string, readonly retryAfterMs: number | null = null) {
    super(message);
  }
}

const maximumTaskClaimRetryDelayMs = 5_000;
const fatalTaskLeaseCodes = new Set(['task_lease_expired', 'task_lease_required', 'invalid_task_lease']);
const taskExecutionLeases = new Map<string, TaskExecutionLease>();

interface PendingTaskExecutionClaim {
  claimId: string;
  leaseToken: string;
  expectedVersion: number;
}

const pendingTaskExecutionClaims = new Map<string, PendingTaskExecutionClaim>();

function responseRetryAfterMs(response: Response): number | null {
  const value = response.headers.get('retry-after')?.trim();
  if (!value) return null;
  if (/^\d+$/.test(value)) return Number(value) * 1_000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

function localizedApiErrorMessage(code: string, fallback: string): string {
  if (code === 'invalid_task_claim') return '任务启动凭据无效，请刷新任务后重新执行。';
  if (code === 'invalid_task_lease') return '任务执行授权无效，请刷新任务后重新执行。';
  if (code === 'task_lease_required') return '任务执行授权已失效，请重新执行任务。';
  if (code === 'task_lease_expired') return '任务执行授权已过期，请重新执行任务。';
  if (code === 'invalid_verification_code') return '验证码不正确，请重新输入。';
  if (code === 'verification_code_expired') return '验证码已过期，请重新获取。';
  if (code === 'verification_attempts_exceeded') return '尝试次数过多，请重新获取验证码。';
  if (code === 'verification_resend_too_soon') return '请稍后再重新发送验证码。';
  if (code === 'registration_challenge_expired') return '本次注册验证已过期，请从邮箱验证开始重试。';
  if (code === 'registration_challenge_consumed') return '本次注册已完成，请直接登录。';
  if (code === 'registration_verification_required') return '请先完成邮箱和手机验证。';
  if (code === 'phone_already_registered') return '该手机号已绑定其他账号。';
  return fallback;
}

function apiError(body: ApiErrorBody, status: number, retryAfterMs: number | null = null): ApiError {
  const code = body.error ?? 'request_failed';
  const fallback = body.message ?? `Control plane request failed: ${status}`;
  return new ApiError(localizedApiErrorMessage(code, fallback), status, code, retryAfterMs);
}

function wait(milliseconds: number): Promise<void> {
  return milliseconds > 0 ? new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds)) : Promise.resolve();
}

function createSecureTaskToken(): string {
  if (typeof globalThis.crypto?.getRandomValues !== 'function') {
    throw new ApiError('当前环境无法安全启动任务，请升级客户端后重试。', 500, 'secure_random_unavailable');
  }
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let encoded = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index];
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    encoded += alphabet[first >> 2];
    encoded += alphabet[((first & 3) << 4) | ((second ?? 0) >> 4)];
    if (second !== undefined) encoded += alphabet[((second & 15) << 2) | ((third ?? 0) >> 6)];
    if (third !== undefined) encoded += alphabet[third & 63];
  }
  return encoded;
}

function validTaskExecutionLease(value: unknown, expectedToken?: string): value is TaskExecutionLease {
  if (!value || typeof value !== 'object') return false;
  const lease = value as Partial<TaskExecutionLease>;
  return typeof lease.executionId === 'string'
    && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(lease.executionId)
    && typeof lease.leaseToken === 'string'
    && /^[A-Za-z0-9_-]{43}$/.test(lease.leaseToken)
    && (!expectedToken || lease.leaseToken === expectedToken)
    && typeof lease.leaseExpiresAt === 'string'
    && Number.isFinite(Date.parse(lease.leaseExpiresAt));
}

export function getTaskExecutionLease(taskId: string): TaskExecutionLease | null {
  return taskExecutionLeases.get(taskId) ?? null;
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
  const configuredControlPlaneUrl = getCodRuntime().controlPlaneUrl;
  if (configuredControlPlaneUrl) return configuredControlPlaneUrl.replace(/\/$/, '');
  if (window.location.protocol === 'file:' && window.codDesktop) return window.codDesktop.controlPlaneUrl.replace(/\/$/, '');
  return '';
}

async function request<T>(path: string, token?: string, init?: RequestInit): Promise<T> {
  const method = (init?.method ?? 'GET').toUpperCase();
  const hasIdempotencyKey = new Headers(init?.headers).has('idempotency-key');
  const retrySafeSearch = method === 'POST' && path === '/api/admin/compute/requests/search';
  const retryDelays = method === 'GET' || retrySafeSearch || hasIdempotencyKey ? [100, 300] : [];
  let lastError: unknown;
  for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
    try {
      return await requestOnce<T>(path, token, init);
    } catch (error) {
      lastError = error;
      const aborted = init?.signal?.aborted || (error instanceof DOMException && error.name === 'AbortError');
      const transient = error instanceof ApiError
        ? error.status === 408 || error.status === 425 || error.status === 429 || error.status >= 500
        : error instanceof TypeError || error instanceof SyntaxError || error instanceof Error;
      if (aborted || !transient || attempt === retryDelays.length) throw error;
      await new Promise<void>((resolve) => window.setTimeout(resolve, retryDelays[attempt]));
    }
  }
  throw lastError;
}

async function requestOnce<T>(path: string, token?: string, init?: RequestInit): Promise<T> {
  const url = `${getControlPlaneUrl()}${path}`;
  const headers = new Headers({
    'content-type': 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...Object.fromEntries(new Headers(init?.headers).entries()),
  });
  const runtime = getCodRuntime();
  const abortReason = () => {
    const reason = init?.signal?.reason;
    return reason instanceof DOMException
      ? reason
      : new DOMException(reason instanceof Error ? reason.message : 'Request cancelled', 'AbortError');
  };
  if (runtime.nativeRequest) {
    if (init?.body !== undefined && typeof init.body !== 'string') throw new TypeError('Native API requests require a string body');
    if (init?.signal?.aborted) throw abortReason();
    const id = createClientId();
    let rejectAbortedRequest: ((reason: DOMException) => void) | null = null;
    const abortedRequest = new Promise<never>((_resolve, reject) => { rejectAbortedRequest = reject; });
    const abort = () => {
      try {
        const cancellation = runtime.cancelNativeRequest?.(id);
        if (cancellation) void Promise.resolve(cancellation).catch(() => undefined);
      } catch {
        // Cancellation is best-effort. The abort race below still releases the caller.
      }
      rejectAbortedRequest?.(abortReason());
    };
    init?.signal?.addEventListener('abort', abort, { once: true });
    try {
      const nativeResponse = Promise.resolve().then(() => runtime.nativeRequest!({
        id,
        url,
        method: init?.method ?? 'GET',
        headers: Object.fromEntries(headers.entries()),
        ...(typeof init?.body === 'string' ? { body: init.body } : {}),
      }));
      // React Native's fetch cancellation is not guaranteed to settle the
      // original bridge promise. Race it with the DOM signal so callers never
      // remain blocked on a no-op or failed native cancellation.
      const response = init?.signal ? await Promise.race([nativeResponse, abortedRequest]) : await nativeResponse;
      if (init?.signal?.aborted) throw abortReason();
      let body: T | ApiErrorBody = {} as T;
      if (response.body) {
        try {
          body = JSON.parse(response.body) as T | ApiErrorBody;
        } catch {
          if (response.status >= 200 && response.status < 300) throw new ApiError('Control plane returned invalid JSON', 502, 'invalid_response');
        }
      }
      if (response.status < 200 || response.status >= 300) {
        const errorBody = body as ApiErrorBody;
        throw apiError(errorBody, response.status);
      }
      return body as T;
    } catch (error) {
      if (init?.signal?.aborted) throw abortReason();
      throw error;
    } finally {
      init?.signal?.removeEventListener('abort', abort);
    }
  }
  if (init?.signal?.aborted) throw abortReason();
  const response = await fetch(url, {
    ...init,
    headers,
  });
  if (init?.signal?.aborted) throw abortReason();
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as ApiErrorBody;
    throw apiError(body, response.status, responseRetryAfterMs(response));
  }
  return response.json() as Promise<T>;
}

export async function hydrateCodSession(token: string, signal?: AbortSignal): Promise<CodSession> {
  const [account, sources] = await Promise.all([
    request<AccountSummary>('/api/account', token, { signal }),
    listModelSources(token, signal),
  ]);
  return { token, account, sources };
}

export async function getCapabilities(): Promise<CapabilityReport> {
  return request('/api/capabilities');
}

export async function listModelCatalog(): Promise<PublicModelSourceInfo[]> {
  const catalog = await request<unknown>('/api/model-catalog');
  if (!Array.isArray(catalog)) throw new ApiError('模型目录返回格式无效', 502, 'invalid_model_catalog');
  return catalog as PublicModelSourceInfo[];
}

export async function listModelSources(token: string, signal?: AbortSignal): Promise<ModelSourceInfo[]> {
  const sources = await request<unknown>('/api/model-sources', token, { signal });
  if (!Array.isArray(sources)) throw new ApiError('模型源返回格式无效', 502, 'invalid_model_sources');
  return sources as ModelSourceInfo[];
}

export async function resumeCodSession(): Promise<CodSession | null> {
  const token = storageGet(sessionStorageKey);
  if (!token) return null;
  try {
    return await hydrateCodSession(token);
  } catch (error) {
    // A stale bootstrap request may finish after a fresh login has already
    // stored a different token. Never let the old 401 erase the new session.
    if (error instanceof ApiError && error.status === 401 && storageGet(sessionStorageKey) === token) {
      storageSet(sessionStorageKey, null);
    }
    return null;
  }
}

export async function loginCod(email: string, password: string, options: AuthenticationRequestOptions = {}): Promise<string> {
  const login = await request<{ token: string }>('/api/auth/login', undefined, {
    method: 'POST',
    body: JSON.stringify({ email, password }),
    signal: options.signal,
  });
  return login.token;
}

export async function startRegistrationEmail(email: string, humanChallengeToken?: string, signal?: AbortSignal): Promise<RegistrationVerificationChallenge> {
  return request('/api/auth/registration/email/start', undefined, {
    method: 'POST', body: JSON.stringify({ email, ...(humanChallengeToken ? { humanChallengeToken } : {}) }), signal,
  });
}

export async function verifyRegistrationEmail(challengeId: string, email: string, code: string, signal?: AbortSignal): Promise<{ verified: true }> {
  return request('/api/auth/registration/email/verify', undefined, {
    method: 'POST', body: JSON.stringify({ challengeId, email, code }), signal,
  });
}

export async function startRegistrationPhone(challengeId: string, email: string, phone: string, humanChallengeToken?: string, signal?: AbortSignal): Promise<RegistrationVerificationChallenge> {
  return request('/api/auth/registration/phone/start', undefined, {
    method: 'POST', body: JSON.stringify({ challengeId, email, phone, ...(humanChallengeToken ? { humanChallengeToken } : {}) }), signal,
  });
}

export async function verifyRegistrationPhone(challengeId: string, email: string, phone: string, code: string, signal?: AbortSignal): Promise<{ verified: true }> {
  return request('/api/auth/registration/phone/verify', undefined, {
    method: 'POST', body: JSON.stringify({ challengeId, email, phone, code }), signal,
  });
}

export async function registerCod(input: VerifiedRegistrationInput | LegacyMigrationInput, options: AuthenticationRequestOptions = {}): Promise<string> {
  const headers = options.idempotencyKey ? { 'idempotency-key': options.idempotencyKey } : undefined;
  const registration = await request<{ token: string }>('/api/auth/register', undefined, {
    method: 'POST', body: JSON.stringify(input), headers, signal: options.signal,
  });
  return registration.token;
}

export function persistCodSession(token:string):void{
  storageSet(sessionStorageKey,token);
}

export function logoutCod(): void {
  storageSet(sessionStorageKey, null);
  taskExecutionLeases.clear();
  pendingTaskExecutionClaims.clear();
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

export async function listAdminComputeRequests(token: string, filters: AdminComputeRequestFilters = {}): Promise<AdminComputeRequestPage> {
  const q=filters.q?.trim();
  if(q)return request('/api/admin/compute/requests/search', token, {
    method: 'POST',
    body: JSON.stringify({ limit: 50, ...(filters.cursor ? { cursor: filters.cursor } : {}), ...(filters.kind ? { kind: filters.kind } : {}), ...(filters.status ? { status: filters.status } : {}), q }),
  });
  const query=new URLSearchParams({limit:'50'});
  if(filters.cursor)query.set('cursor',filters.cursor);
  if(filters.kind)query.set('kind',filters.kind);
  if(filters.status)query.set('status',filters.status);
  return request(`/api/admin/compute/requests?${query}`,token);
}

export async function getAdminComputeRequest(token: string, requestId: string): Promise<ComputeRequest> {
  return request(`/api/admin/compute/requests/${encodeURIComponent(requestId)}`, token);
}

export async function updateAdminComputeRequestStatus(token: string, requestId: string, status: ComputeRequest['status'], expectedStatus: ComputeRequest['status']): Promise<ComputeRequest> {
  return request(`/api/admin/compute/requests/${encodeURIComponent(requestId)}/status`, token, {
    method: 'PATCH',
    body: JSON.stringify({ status, expectedStatus }),
  });
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

export async function heartbeatDevice(token: string, deviceId: string, activeTaskId?: string): Promise<DeviceRecord> {
  const execution = activeTaskId ? taskExecutionLeases.get(activeTaskId) : undefined;
  try {
    return await request(`/api/devices/${encodeURIComponent(deviceId)}/heartbeat`, token, {
      method: 'POST',
      body: JSON.stringify(activeTaskId && execution ? {
        taskId: activeTaskId,
        executionId: execution.executionId,
        leaseToken: execution.leaseToken,
      } : {}),
    });
  } catch (error) {
    if (activeTaskId && error instanceof ApiError && fatalTaskLeaseCodes.has(error.code)) {
      taskExecutionLeases.delete(activeTaskId);
      pendingTaskExecutionClaims.delete(activeTaskId);
    }
    throw error;
  }
}

export async function listTasks(token: string): Promise<RemoteTask[]> {
  const tasks = await request<RemoteTask[]>('/api/tasks', token);
  const activeIds = new Set(tasks.filter((task) => task.status === 'running' || task.status === 'waiting').map((task) => task.id));
  for (const taskId of taskExecutionLeases.keys()) {
    if (!activeIds.has(taskId)) taskExecutionLeases.delete(taskId);
  }
  for (const [taskId, claim] of pendingTaskExecutionClaims) {
    const task = tasks.find((item) => item.id === taskId);
    if (!task || (!activeIds.has(taskId) && task.version !== claim.expectedVersion)) pendingTaskExecutionClaims.delete(taskId);
  }
  return tasks;
}

export async function createRemoteTask(token: string, title: string, deviceId: string): Promise<RemoteTask> {
  return request('/api/tasks', token, { method: 'POST', body: JSON.stringify({ title, deviceId }) });
}

export async function updateRemoteTask(token: string, task: RemoteTask, status: TaskStatus, outcome: { result?: string | null; error?: string | null } = {}): Promise<RemoteTask> {
  const execution = taskExecutionLeases.get(task.id);
  let claim: PendingTaskExecutionClaim | undefined;
  if (status === 'running' && !execution) {
    claim = pendingTaskExecutionClaims.get(task.id);
    if (!claim || ((task.status !== 'running' && task.status !== 'waiting') && claim.expectedVersion !== task.version)) {
      claim = { claimId: createSecureTaskToken(), leaseToken: createSecureTaskToken(), expectedVersion: task.version };
      pendingTaskExecutionClaims.set(task.id, claim);
    }
  }

  const submit = () => request<RemoteTask & { execution?: unknown }>(`/api/tasks/${encodeURIComponent(task.id)}/status`, token, {
    method: 'POST',
    body: JSON.stringify({
      status,
      expectedVersion: claim?.expectedVersion ?? task.version,
      ...outcome,
      ...(claim
        ? { claimId: claim.claimId, leaseToken: claim.leaseToken }
        : execution
          ? { executionId: execution.executionId, leaseToken: execution.leaseToken }
          : {}),
    }),
  });

  let result: RemoteTask & { execution?: unknown };
  try {
    result = await submit();
  } catch (error) {
    const retryable = Boolean(claim) && (!(error instanceof ApiError) || error.status === 429 || error.status >= 500);
    if (!retryable) {
      if (claim && error instanceof ApiError && error.status < 500 && error.status !== 429) pendingTaskExecutionClaims.delete(task.id);
      if (execution && error instanceof ApiError && fatalTaskLeaseCodes.has(error.code)) taskExecutionLeases.delete(task.id);
      throw error;
    }
    const delay = error instanceof ApiError ? Math.min(error.retryAfterMs ?? 0, maximumTaskClaimRetryDelayMs) : 0;
    await wait(delay);
    try {
      result = await submit();
    } catch (retryError) {
      if (retryError instanceof ApiError && retryError.status < 500 && retryError.status !== 429) pendingTaskExecutionClaims.delete(task.id);
      throw retryError;
    }
  }

  if (status === 'running') {
    if (result.execution !== undefined) {
      if (!validTaskExecutionLease(result.execution, claim?.leaseToken)) {
        pendingTaskExecutionClaims.delete(task.id);
        taskExecutionLeases.delete(task.id);
        throw new ApiError('服务端未返回有效的任务执行授权。', 502, 'invalid_task_lease_response');
      }
      taskExecutionLeases.set(task.id, result.execution);
    }
    // A legacy control plane accepts the claim fields but does not return an
    // execution object. Keep that protocol usable and send task chat without
    // lease headers rather than rejecting an otherwise successful transition.
    pendingTaskExecutionClaims.delete(task.id);
  } else if (status === 'complete' || status === 'failed' || status === 'cancelled') {
    taskExecutionLeases.delete(task.id);
    pendingTaskExecutionClaims.delete(task.id);
  }

  return {
    id: result.id,
    title: result.title,
    status: result.status,
    deviceId: result.deviceId,
    updatedAt: result.updatedAt,
    version: result.version,
    result: result.result,
    error: result.error,
  };
}

export async function cancelRemoteTask(token:string,task:RemoteTask):Promise<{task:RemoteTask;cancelledRequests:number}>{
  const result = await request<{task:RemoteTask;cancelledRequests:number}>(`/api/tasks/${encodeURIComponent(task.id)}/cancel`,token,{method:'POST',body:JSON.stringify({expectedVersion:task.version})});
  taskExecutionLeases.delete(task.id);
  pendingTaskExecutionClaims.delete(task.id);
  return result;
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
  const execution = options.taskId ? taskExecutionLeases.get(options.taskId) : undefined;
  let result: { model?: string; choices: Array<{ message: { content: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number; input_tokens?: number; output_tokens?: number }; cod_mode?: 'demo'; cod_source?: string; cod_upstream_source?: string; cod_payment_direction?: string; cod_usage_estimated?: boolean; cod_fallback_used?: boolean } | null = null;
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const attemptSignal=requestSignal(options.signal,255_000);
    try {
      result = await request('/v1/chat/completions', token, {
        method: 'POST', headers: {
          'x-request-id': requestId,
          ...(execution ? {
            'x-cod-task-execution': execution.executionId,
            'x-cod-task-lease': execution.leaseToken,
          } : {}),
        },
        body: JSON.stringify({ source, model, messages: sanitizedMessages, max_tokens: 4_096, stream: false, ...(options.taskId?{task_id:options.taskId}:{}) }),
        signal: attemptSignal.signal,
      });
      break;
    } catch (error) {
      lastError = error;
      if (options.taskId && error instanceof ApiError && fatalTaskLeaseCodes.has(error.code)) {
        taskExecutionLeases.delete(options.taskId);
        pendingTaskExecutionClaims.delete(options.taskId);
      }
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
