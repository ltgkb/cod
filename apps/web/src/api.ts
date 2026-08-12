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
  authentication: { mode: 'password'; registrationEnabled: boolean; legacyMigrationEnabled: boolean; inviteCodeOptional: boolean; inviteCodeRequired: boolean; accessCodeRequired: false };
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
  constructor(message: string, readonly status: number, readonly code: string, readonly retryAfterMs: number | null = null, readonly sessionCredentialCleared = false) {
    super(message);
  }
}

const maximumTaskClaimRetryDelayMs = 5_000;
const fatalTaskLeaseCodes = new Set(['task_lease_expired', 'task_lease_required', 'invalid_task_lease']);
const maximumStoredSessionTokenLength = 8_192;
const mobileLogoutPendingStorageKey = 'cod.session.logout-pending';
const sessionInvalidatedListeners = new Set<(expectedToken: string) => void>();
let sessionPersistenceQueue: Promise<void> = Promise.resolve();

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

function validStoredSessionToken(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximumStoredSessionTokenLength && !/[\0-\x20\x7f]/.test(value);
}

function logoutRecoveryUnavailable(sessionCredentialCleared = false): ApiError {
  return new ApiError('安全凭据或本机数据未能清除，且无法记录自动重试。请在系统设置中清除 COD 应用数据后再使用。', 503, 'logout_recovery_unavailable', null, sessionCredentialCleared);
}

function afterCredentialCleared(error: unknown): ApiError {
  if (error instanceof ApiError) return new ApiError(error.message, error.status, error.code, error.retryAfterMs, true);
  return new ApiError('登录凭据已进入安全退出状态，但本机清理尚未完成。应用会保持退出并自动重试。', 503, 'logout_not_completed', null, true);
}

function removeMobilePlaintextSessionToken(): void {
  try {
    window.localStorage.removeItem(sessionStorageKey);
    if (window.localStorage.getItem(sessionStorageKey) !== null) throw new Error('Session removal was not persisted');
  } catch {
    throw new ApiError('无法清除移动端旧登录凭据，请清理应用数据后重新登录。', 503, 'plaintext_session_cleanup_failed');
  }
}

function setMobileLogoutPending(pending: boolean): void {
  try {
    if (pending) window.localStorage.setItem(mobileLogoutPendingStorageKey, '1');
    else window.localStorage.removeItem(mobileLogoutPendingStorageKey);
    const stored = window.localStorage.getItem(mobileLogoutPendingStorageKey);
    if (pending ? stored !== '1' : stored !== null) throw new Error('Logout marker was not persisted');
  } catch {
    throw new ApiError('无法记录本机退出状态，请保持应用打开并重试。', 503, 'logout_marker_unavailable');
  }
}

function readMobileLogoutPending(): boolean {
  try { return window.localStorage.getItem(mobileLogoutPendingStorageKey) !== null; }
  catch { throw new ApiError('无法读取本机退出状态；为保护账号，本次不会恢复登录。', 503, 'logout_marker_unavailable'); }
}

function clearLocalStoragePrefix(prefix: string): void {
  try {
    const keys: string[] = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key?.startsWith(prefix)) keys.push(key);
    }
    for (const key of keys) window.localStorage.removeItem(key);
    if (keys.some((key) => window.localStorage.getItem(key) !== null)) throw new Error('Local history removal was not persisted');
  } catch {
    throw new ApiError('无法清除移动端本机聊天记录，请清理应用数据后再使用。', 503, 'chat_history_cleanup_failed');
  }
}

function removeWebSessionToken(expectedToken?: string): boolean {
  try {
    const current = window.localStorage.getItem(sessionStorageKey);
    if (expectedToken !== undefined && current !== null && current !== expectedToken) return false;
    window.localStorage.removeItem(sessionStorageKey);
    if (window.localStorage.getItem(sessionStorageKey) !== null) throw new Error('Session removal was not persisted');
    return true;
  } catch {
    throw new ApiError('本机登录凭据未能删除，请检查浏览器存储权限后重试。', 503, 'session_cleanup_failed');
  }
}

function serializedSessionPersistence<T>(operation: () => Promise<T>): Promise<T> {
  const result=sessionPersistenceQueue.then(operation,operation);
  sessionPersistenceQueue=result.then(()=>undefined,()=>undefined);
  return result;
}

function mobileSessionRuntime() {
  const runtime = getCodRuntime();
  if (!runtime.hostPlatform) return null;
  if (!runtime.loadSessionCleanupPending || !runtime.loadSessionToken || !runtime.saveSessionToken || !runtime.clearSessionToken) {
    throw new ApiError('移动端安全存储桥不可用，请重启应用后重新登录。', 503, 'secure_session_storage_unavailable');
  }
  return runtime as Required<Pick<typeof runtime, 'loadSessionCleanupPending' | 'loadSessionToken' | 'saveSessionToken' | 'clearSessionToken'>> & typeof runtime;
}

type MobileSessionRuntime = NonNullable<ReturnType<typeof mobileSessionRuntime>>;

async function clearMobileSession(
  runtime: MobileSessionRuntime,
  expectedToken: string | undefined,
  clearHistory: boolean,
  writeAheadMarker = true,
): Promise<boolean> {
  let markerWritten = false;
  let plaintextAlreadyRemoved = false;
  if(writeAheadMarker){
    try { setMobileLogoutPending(true); markerWritten = true; }
    catch {
      try { removeMobilePlaintextSessionToken(); plaintextAlreadyRemoved = true; }
      catch { /* The native tombstone can still make logout durable. */ }
      try { setMobileLogoutPending(true); markerWritten = true; }
      catch { /* Continue so SecureStore still gets a chance to persist logout. */ }
    }
  }

  let cleared: boolean;
  try { cleared = await runtime.clearSessionToken(expectedToken); }
  catch (secureStoreError) {
    if(!writeAheadMarker)throw secureStoreError;
    if (!markerWritten) {
      if (!plaintextAlreadyRemoved) {
        try { removeMobilePlaintextSessionToken(); plaintextAlreadyRemoved = true; }
        catch { /* Report the unrecoverable combination below. */ }
      }
      try { setMobileLogoutPending(true); markerWritten = true; }
      catch { /* Report the unrecoverable combination below. */ }
    }
    if (!markerWritten) throw logoutRecoveryUnavailable();
    throw secureStoreError;
  }

  if (!cleared) {
    if (markerWritten) setMobileLogoutPending(false);
    return false;
  }

  let plaintextError: unknown = null;
  if (!plaintextAlreadyRemoved) {
    try { removeMobilePlaintextSessionToken(); }
    catch (error) { plaintextError = error; }
  }
  let historyError: unknown = null;
  if (clearHistory) {
    try { clearLocalStoragePrefix('cod.messages.'); }
    catch (error) { historyError = error; }
  }
  const localCleanupError = plaintextError ?? historyError;
  if (localCleanupError) {
    try { setMobileLogoutPending(true); } catch { /* The SecureStore tombstone is authoritative. */ }
    throw afterCredentialCleared(localCleanupError);
  }
  try { setMobileLogoutPending(false); }
  catch (error) { throw afterCredentialCleared(error); }
  return true;
}

function markMobileCleanupPendingWithoutBridge(clearHistory: boolean): never {
  let markerWritten = false;
  try { setMobileLogoutPending(true); }
  catch { /* Removing a plaintext token may release enough quota to retry. */ }
  try { markerWritten = readMobileLogoutPending(); } catch { markerWritten = false; }
  let cleanupError: unknown = null;
  try { removeMobilePlaintextSessionToken(); }
  catch (error) { cleanupError = error; }
  if (!markerWritten) {
    try { setMobileLogoutPending(true); markerWritten = true; }
    catch { /* Report the unrecoverable combination below. */ }
  }
  if (clearHistory && markerWritten) {
    try { clearLocalStoragePrefix('cod.messages.'); }
    catch (error) { cleanupError ??= error; }
  }
  if (!markerWritten || cleanupError) throw logoutRecoveryUnavailable();
  throw new ApiError('移动端安全存储桥不可用；应用会保持退出并在桥恢复后继续清理。', 503, 'secure_session_storage_unavailable');
}

async function loadPersistedSessionToken(): Promise<string | null> {
  return serializedSessionPersistence(async()=>{
    const legacyToken = storageGet(sessionStorageKey);
    let runtime: MobileSessionRuntime | null;
    try { runtime = mobileSessionRuntime(); }
    catch { return markMobileCleanupPendingWithoutBridge(true); }
    if (!runtime) return validStoredSessionToken(legacyToken) ? legacyToken : null;
    let logoutPending: boolean;
    try { logoutPending=readMobileLogoutPending(); }
    catch (error) {
      let secureLogoutRecorded=false;
      try { secureLogoutRecorded=await runtime.clearSessionToken(); } catch { /* Retry through the local marker below. */ }
      try { removeMobilePlaintextSessionToken(); } catch { /* The native tombstone remains authoritative if it was written. */ }
      let markerRecorded=false;
      try { setMobileLogoutPending(true); markerRecorded=true; } catch { /* The marker storage may still be unavailable. */ }
      try { clearLocalStoragePrefix('cod.messages.'); } catch { /* Keep the original fail-closed marker error. */ }
      if(!secureLogoutRecorded&&!markerRecorded)throw logoutRecoveryUnavailable();
      throw error;
    }
    let secureLogoutPending: boolean;
    try { secureLogoutPending=await runtime.loadSessionCleanupPending(); }
    catch {
      try { await clearMobileSession(runtime,undefined,true); }
      catch (cleanupError) { if(cleanupError instanceof ApiError)throw cleanupError; }
      throw new ApiError('移动端安全存储暂不可用；应用会保持退出并继续重试。',503,'secure_session_storage_unavailable');
    }
    if(logoutPending||secureLogoutPending){
      try {
        if(!await clearMobileSession(runtime,undefined,true))throw new Error('Pending logout could not clear the secure session');
        return null;
      } catch(error) {
        if(error instanceof ApiError)throw error;
        throw new ApiError('移动端安全存储暂不可用；应用会保持退出并继续重试。',503,'secure_session_storage_unavailable');
      }
    }
    try {
      const secureToken = await runtime.loadSessionToken();
      if (secureToken !== null) {
        if (!validStoredSessionToken(secureToken)) {
          await runtime.clearSessionToken().catch(() => false);
          removeMobilePlaintextSessionToken();
          throw new ApiError('移动端登录凭据无效，请重新登录。', 401, 'invalid_stored_session');
        }
        removeMobilePlaintextSessionToken();
        return secureToken;
      }
      if (!legacyToken) { removeMobilePlaintextSessionToken(); return null; }
      if (!validStoredSessionToken(legacyToken)) {
        removeMobilePlaintextSessionToken();
        return null;
      }
      await runtime.saveSessionToken(legacyToken);
      if (await runtime.loadSessionToken() !== legacyToken) throw new Error('Secure session verification failed');
      removeMobilePlaintextSessionToken();
      return legacyToken;
    } catch (error) {
      try {
        if(!await clearMobileSession(runtime,undefined,false))throw logoutRecoveryUnavailable();
      }
      catch (cleanupError) {
        if (cleanupError instanceof ApiError) throw cleanupError;
      }
      if (error instanceof ApiError) throw error;
      throw new ApiError('移动端安全存储暂不可用，请重新登录。', 503, 'secure_session_storage_unavailable');
    }
  });
}

export function observeCodSessionInvalidated(listener: (expectedToken: string) => void): () => void {
  sessionInvalidatedListeners.add(listener);
  return () => sessionInvalidatedListeners.delete(listener);
}

async function invalidateCodSession(expectedToken: string): Promise<void> {
  let cleared = false;
  try { cleared = await logoutCod(expectedToken,{writeAheadMarker:false}); }
  catch (error) {
    if(error instanceof ApiError&&error.sessionCredentialCleared)cleared=true;
    else return;
  }
  if (!cleared) return;
  for (const listener of sessionInvalidatedListeners) {
    try { listener(expectedToken); } catch { /* One UI observer must not prevent secure credential cleanup. */ }
  }
}

async function throwResponseError(status: number, body: ApiErrorBody, token: string | undefined, retryDelay: number | null = null): Promise<never> {
  const error = new ApiError(body.message ?? `Control plane request failed: ${status}`, status, body.error ?? 'request_failed', retryDelay);
  // Only COD's authentication middleware may invalidate the local session. A
  // model provider or webhook can also return 401, but that must never sign the
  // user out of COD (especially during a multi-model comparison).
  if (token && status === 401 && body.error === 'unauthorized') await invalidateCodSession(token);
  throw error;
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
        return throwResponseError(response.status, errorBody, token);
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
    return throwResponseError(response.status, body, token, retryAfterMs(response));
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
  const token = await loadPersistedSessionToken();
  if (!token) return null;
  try {
    return await hydrateSession(token);
  } catch {
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

export async function persistCodSession(token:string):Promise<void>{
  if (!validStoredSessionToken(token)) throw new ApiError('登录凭据格式无效。', 500, 'invalid_session_token');
  return serializedSessionPersistence(async()=>{
    let runtime: MobileSessionRuntime | null;
    try { runtime=mobileSessionRuntime(); }
    catch { return markMobileCleanupPendingWithoutBridge(false); }
    if(!runtime){storageSet(sessionStorageKey,token);return;}
    try{
      const localCleanupPending=readMobileLogoutPending();
      const secureCleanupPending=await runtime.loadSessionCleanupPending();
      if(localCleanupPending||secureCleanupPending){
        if(!await clearMobileSession(runtime,undefined,true))throw logoutRecoveryUnavailable();
      }
      removeMobilePlaintextSessionToken();
    }catch(error){
      if(error instanceof ApiError)throw error;
      throw new ApiError('登录前的本机退出清理尚未完成，请重试。',503,'secure_session_storage_unavailable');
    }
    try{
      await runtime.saveSessionToken(token);
      if(await runtime.loadSessionToken()!==token)throw new Error('Secure session verification failed');
    }catch{
      try {
        if (!await clearMobileSession(runtime,token,false)) throw logoutRecoveryUnavailable();
      } catch (cleanupError) {
        if (cleanupError instanceof ApiError && cleanupError.code !== 'secure_session_storage_unavailable') throw cleanupError;
      }
      throw new ApiError('无法安全保存移动端登录状态，请重试。',503,'secure_session_storage_unavailable');
    }
  });
}

export async function logoutCod(expectedToken?:string, options: { explicit?: boolean; clearMobileHistory?: boolean; writeAheadMarker?: boolean } = {}): Promise<boolean> {
  const mobile=Boolean(getCodRuntime().hostPlatform);
  const clearMobileHistory=options.clearMobileHistory ?? true;
  if(options.explicit){
    taskExecutionLeases.clear();
    pendingTaskExecutionClaims.clear();
  }
  return serializedSessionPersistence(async()=>{
    let cleared: boolean;
    if (mobile) {
      let runtime: MobileSessionRuntime | null;
      try { runtime=mobileSessionRuntime(); }
      catch { return markMobileCleanupPendingWithoutBridge(clearMobileHistory); }
      if (!runtime) throw new Error('Mobile runtime unexpectedly missing');
      cleared=await clearMobileSession(runtime,expectedToken,clearMobileHistory,options.writeAheadMarker??true);
    } else cleared=removeWebSessionToken(expectedToken);
    if(!cleared){
      if(options.explicit)throw new ApiError('安全退出尚未完成，应用会保持退出并继续重试。',409,'logout_not_completed');
      return false;
    }
    taskExecutionLeases.clear();
    pendingTaskExecutionClaims.clear();
    return true;
  });
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
      const retryable = !(error instanceof ApiError) || error.status === 429 || (error.status >= 500 && error.code !== 'ai_upstream_auth_failed');
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
