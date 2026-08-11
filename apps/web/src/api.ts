import type { AccountSummary, DeviceRecord, KnowledgeHit, ProductManifest, TaskStatus } from '@cod/contracts';
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
  kind: 'rental' | 'supply' | 'installment'; offerId?: string | null; company: string; contactName: string; contactPhone: string;
  city: string; gpuModel: string; quantity: number; durationHours?: number | null; termMonths?: number | null; requirements: string;
}

export interface ComputeRequest extends ComputeRequestInput {
  id: string; email: string; offerId: string | null; durationHours: number | null; termMonths: number | null;
  status: 'submitted' | 'contacting' | 'quoted' | 'closed'; createdAt: string; updatedAt: string;
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code: string, readonly retryAfterMs: number | null = null) {
    super(message);
  }
}

const maximumTaskClaimRetryDelayMs = 5_000;
const fatalTaskLeaseCodes = new Set(['task_lease_expired', 'task_lease_required', 'invalid_task_lease']);

function retryAfterMs(response: Response): number | null {
  const value=response.headers.get('retry-after')?.trim();
  if(!value)return null;
  if(/^\d+$/.test(value))return Number(value)*1_000;
  const date=Date.parse(value);
  return Number.isFinite(date)?Math.max(0,date-Date.now()):null;
}

function wait(milliseconds:number):Promise<void>{return milliseconds>0?new Promise((resolve)=>setTimeout(resolve,milliseconds)):Promise.resolve();}

export function createClientId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

const taskExecutionLeases = new Map<string, TaskExecutionLease>();
interface PendingTaskExecutionClaim { claimId: string; leaseToken: string; expectedVersion: number }
const pendingTaskExecutionClaims = new Map<string, PendingTaskExecutionClaim>();

function createSecureTaskToken(): string {
  if (typeof globalThis.crypto?.getRandomValues !== 'function') throw new ApiError('当前环境无法安全启动任务，请升级客户端后重试。', 500, 'secure_random_unavailable');
  const bytes=globalThis.crypto.getRandomValues(new Uint8Array(32));
  const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let encoded='';
  for(let index=0;index<bytes.length;index+=3){
    const first=bytes[index];const second=bytes[index+1];const third=bytes[index+2];
    encoded+=alphabet[first>>2];
    encoded+=alphabet[((first&3)<<4)|((second??0)>>4)];
    if(second!==undefined)encoded+=alphabet[((second&15)<<2)|((third??0)>>6)];
    if(third!==undefined)encoded+=alphabet[third&63];
  }
  return encoded;
}

export function getTaskExecutionLease(taskId: string): TaskExecutionLease | null {
  return taskExecutionLeases.get(taskId) ?? null;
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
  const url = `${getControlPlaneUrl()}${path}`;
  const headers = new Headers({
    'content-type': 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...Object.fromEntries(new Headers(init?.headers).entries()),
  });
  const runtime = getCodRuntime();
  if (runtime.nativeRequest) {
    if (init?.body !== undefined && typeof init.body !== 'string') throw new TypeError('Native API requests require a string body');
    if (init?.signal?.aborted) throw init.signal.reason ?? new DOMException('Request cancelled', 'AbortError');
    const id = createClientId();
    const abort = () => { void runtime.cancelNativeRequest?.(id); };
    init?.signal?.addEventListener('abort', abort, { once: true });
    try {
      const response = await runtime.nativeRequest({
        id,
        url,
        method: init?.method ?? 'GET',
        headers: Object.fromEntries(headers.entries()),
        ...(typeof init?.body === 'string' ? { body: init.body } : {}),
      });
      if (init?.signal?.aborted) throw init.signal.reason ?? new DOMException('Request cancelled', 'AbortError');
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
        throw new ApiError(errorBody.message ?? `Control plane request failed: ${response.status}`, response.status, errorBody.error ?? 'request_failed');
      }
      return body as T;
    } catch (error) {
      if (init?.signal?.aborted) throw init.signal.reason ?? new DOMException('Request cancelled', 'AbortError');
      throw error;
    } finally {
      init?.signal?.removeEventListener('abort', abort);
    }
  }
  const response = await fetch(url, {
    ...init,
    headers,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as ApiErrorBody;
    throw new ApiError(body.message ?? `Control plane request failed: ${response.status}`, response.status, body.error ?? 'request_failed', retryAfterMs(response));
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

export async function listModelCatalog(): Promise<PublicModelSourceInfo[]> {
  const catalog = await request<unknown>('/api/model-catalog');
  if (!Array.isArray(catalog)) throw new ApiError('模型目录返回格式无效', 502, 'invalid_model_catalog');
  return catalog as PublicModelSourceInfo[];
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
  return hydrateSession(login.token);
}

export async function registerCod(input:{email:string;password:string;inviteCode?:string;legacyAccessCode?:string}):Promise<CodSession>{
  const registration=await request<{token:string}>('/api/auth/register',undefined,{method:'POST',body:JSON.stringify(input)});
  return hydrateSession(registration.token);
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
  const execution=activeTaskId?taskExecutionLeases.get(activeTaskId):undefined;
  if(activeTaskId&&!execution)throw new ApiError('任务执行租约已丢失，已停止续租。',409,'task_lease_required');
  try {
    return await request(`/api/devices/${encodeURIComponent(deviceId)}/heartbeat`, token, { method: 'POST', body: JSON.stringify(activeTaskId&&execution?{taskId:activeTaskId,executionId:execution.executionId,leaseToken:execution.leaseToken}:{}) });
  } catch(error) {
    if(activeTaskId&&error instanceof ApiError&&fatalTaskLeaseCodes.has(error.code)){taskExecutionLeases.delete(activeTaskId);pendingTaskExecutionClaims.delete(activeTaskId);}
    throw error;
  }
}

export async function listTasks(token: string): Promise<RemoteTask[]> {
  const tasks=await request<RemoteTask[]>('/api/tasks', token);const activeIds=new Set(tasks.filter((task)=>task.status==='running'||task.status==='waiting').map((task)=>task.id));for(const taskId of taskExecutionLeases.keys())if(!activeIds.has(taskId))taskExecutionLeases.delete(taskId);for(const [taskId,claim]of pendingTaskExecutionClaims){const task=tasks.find((item)=>item.id===taskId);if(!task||(!activeIds.has(taskId)&&task.version!==claim.expectedVersion))pendingTaskExecutionClaims.delete(taskId);}return tasks;
}

export async function createRemoteTask(token: string, title: string, deviceId: string): Promise<RemoteTask> {
  return request('/api/tasks', token, { method: 'POST', body: JSON.stringify({ title, deviceId }) });
}

export async function updateRemoteTask(token: string, task: RemoteTask, status: TaskStatus, outcome: { result?: string | null; error?: string | null } = {}): Promise<RemoteTask> {
  const execution=taskExecutionLeases.get(task.id);
  let claim:PendingTaskExecutionClaim|undefined;
  if(status==='running'&&!execution){
    claim=pendingTaskExecutionClaims.get(task.id);
    if(!claim||((task.status!=='running'&&task.status!=='waiting')&&claim.expectedVersion!==task.version)){
      claim={claimId:createSecureTaskToken(),leaseToken:createSecureTaskToken(),expectedVersion:task.version};pendingTaskExecutionClaims.set(task.id,claim);
    }
  }
  const submit=()=>request<RemoteTask & {execution?:TaskExecutionLease}>(`/api/tasks/${encodeURIComponent(task.id)}/status`, token, {
    method: 'POST',
    body: JSON.stringify({ status, expectedVersion: claim?.expectedVersion??task.version, ...outcome, ...(claim?{claimId:claim.claimId,leaseToken:claim.leaseToken}:execution?{executionId:execution.executionId,leaseToken:execution.leaseToken}:{}) }),
  });
  let result:RemoteTask & {execution?:TaskExecutionLease};
  try{result=await submit();}catch(error){
    const retryable=claim&&(!(error instanceof ApiError)||error.status===429||error.status>=500);
    if(retryable){
      const delay=error instanceof ApiError?Math.min(error.retryAfterMs??0,maximumTaskClaimRetryDelayMs):0;
      await wait(delay);
      try{result=await submit();}catch(retryError){if(retryError instanceof ApiError&&retryError.status<500&&retryError.status!==429)pendingTaskExecutionClaims.delete(task.id);throw retryError;}
    }else{if(claim&&error instanceof ApiError&&error.status<500&&error.status!==429)pendingTaskExecutionClaims.delete(task.id);throw error;}
  }
  if(status==='running'){
    if(result.execution){if(!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(result.execution.executionId)||!/^[A-Za-z0-9_-]{43}$/.test(result.execution.leaseToken)||!Number.isFinite(Date.parse(result.execution.leaseExpiresAt))||(claim&&result.execution.leaseToken!==claim.leaseToken))throw new ApiError('服务端未返回有效的任务执行租约。',502,'invalid_task_lease_response');taskExecutionLeases.set(task.id,result.execution);pendingTaskExecutionClaims.delete(task.id);}
    else if(!execution)throw new ApiError('服务端未返回有效的任务执行租约。',502,'invalid_task_lease_response');
  }else if(status==='complete'||status==='failed'||status==='cancelled'){taskExecutionLeases.delete(task.id);pendingTaskExecutionClaims.delete(task.id);}
  return{id:result.id,title:result.title,status:result.status,deviceId:result.deviceId,updatedAt:result.updatedAt,version:result.version,result:result.result,error:result.error};
}

export async function cancelRemoteTask(token:string,task:RemoteTask):Promise<{task:RemoteTask;cancelledRequests:number}>{
  const result=await request<{task:RemoteTask;cancelledRequests:number}>(`/api/tasks/${encodeURIComponent(task.id)}/cancel`,token,{method:'POST',body:JSON.stringify({expectedVersion:task.version})});taskExecutionLeases.delete(task.id);pendingTaskExecutionClaims.delete(task.id);return result;
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
  const execution=options.taskId?taskExecutionLeases.get(options.taskId):undefined;
  if(options.taskId&&!execution)throw new ApiError('任务执行租约已失效，请重新执行。',409,'task_lease_required');
  let result: { model?: string; choices: Array<{ message: { content: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number; input_tokens?: number; output_tokens?: number }; cod_mode?: 'demo'; cod_source?: string; cod_upstream_source?: string; cod_payment_direction?: string; cod_usage_estimated?: boolean; cod_fallback_used?: boolean } | null = null;
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const attemptSignal=requestSignal(options.signal,255_000);
    try {
      result = await request('/v1/chat/completions', token, {
        method: 'POST', headers: { 'x-request-id': requestId, ...(execution?{'x-cod-task-execution':execution.executionId,'x-cod-task-lease':execution.leaseToken}:{}) },
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
