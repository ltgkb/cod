import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  createComputeRequest,
  getTaskExecutionLease,
  listAdminComputeRequests,
  loginCod,
  logoutCod,
  persistCodSession,
  registerCod,
  resumeCodSession,
  sendChat,
  startRegistrationEmail,
  startRegistrationPhone,
  updateAdminComputeRequestStatus,
  updateRemoteTask,
  verifyRegistrationEmail,
  verifyRegistrationPhone,
  type RemoteTask,
} from './api';
import { configureCodRuntime } from './runtime';

const account = {
  userId: 'usr_test',
  displayName: 'Test',
  balanceCents: 0,
  currency: 'CNY' as const,
  plan: 'developer' as const,
  role: 'member' as const,
  billingExempt: false,
};

describe('API session recovery', () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    const storage: Storage = {
      get length() { return values.size; },
      clear: () => values.clear(),
      getItem: (key) => values.get(key) ?? null,
      key: (index) => [...values.keys()][index] ?? null,
      removeItem: (key) => { values.delete(key); },
      setItem: (key, value) => { values.set(key, String(value)); },
    };
    Object.defineProperty(window, 'localStorage', { configurable: true, value: storage });
    window.localStorage.clear();
    configureCodRuntime({ controlPlaneUrl: 'https://cod.test' });
    logoutCod();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    configureCodRuntime({});
    logoutCod();
    window.localStorage.clear();
  });

  it('retries transient read failures and recovers the stored session', async () => {
    vi.useFakeTimers();
    let accountRequests = 0;
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/account')) {
        accountRequests += 1;
        return accountRequests < 3
          ? Response.json({ error: 'temporary' }, { status: 503 })
          : Response.json(account);
      }
      if (url.endsWith('/api/model-sources')) return Response.json([]);
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetcher);
    persistCodSession('stored-token');

    const recovery = resumeCodSession();
    await vi.runAllTimersAsync();
    await expect(recovery).resolves.toEqual({ token: 'stored-token', account, sources: [] });
    expect(accountRequests).toBe(3);
    expect(window.localStorage.getItem('cod.session.token')).toBe('stored-token');
  });

  it('removes only a definitively unauthorized stored token', async () => {
    const fetcher = vi.fn(async () => Response.json({ error: 'unauthorized' }, { status: 401 }));
    vi.stubGlobal('fetch', fetcher);
    persistCodSession('expired-token');

    await expect(resumeCodSession()).resolves.toBeNull();
    expect(window.localStorage.getItem('cod.session.token')).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('does not let a stale 401 erase a newly authenticated session', async () => {
    let rejectOldSession!: () => void;
    const oldSessionResponse = new Promise<Response>((resolve) => {
      rejectOldSession = () => resolve(Response.json({ error: 'unauthorized' }, { status: 401 }));
    });
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/api/account')) return oldSessionResponse;
      return Response.json([]);
    });
    vi.stubGlobal('fetch', fetcher);
    persistCodSession('old-token');

    const recovery = resumeCodSession();
    persistCodSession('new-token');
    rejectOldSession();

    await expect(recovery).resolves.toBeNull();
    expect(window.localStorage.getItem('cod.session.token')).toBe('new-token');
  });

  it('recovers a mobile native session after a transient bridge response', async () => {
    vi.useFakeTimers();
    let accountRequests = 0;
    const nativeRequest = vi.fn(async (request: import('./runtime').NativeHttpRequest) => {
      if (request.url.endsWith('/api/account')) {
        accountRequests += 1;
        return accountRequests === 1
          ? { status: 503, body: JSON.stringify({ error: 'temporary' }) }
          : { status: 200, body: JSON.stringify(account) };
      }
      if (request.url.endsWith('/api/model-sources')) return { status: 200, body: '[]' };
      throw new Error(`Unexpected request: ${request.url}`);
    });
    configureCodRuntime({ controlPlaneUrl: 'https://cod.test', hostPlatform: 'ios', nativeRequest });
    persistCodSession('native-token');

    const recovery = resumeCodSession();
    await vi.runAllTimersAsync();
    await expect(recovery).resolves.toEqual({ token: 'native-token', account, sources: [] });
    expect(accountRequests).toBe(2);
    expect(nativeRequest).toHaveBeenCalledTimes(3);
  });

  it('aborts a hanging native chat even when native cancellation is a no-op', async () => {
    const nativeRequest = vi.fn(() => new Promise<import('./runtime').NativeHttpResponse>(() => undefined));
    const cancelNativeRequest = vi.fn(async () => undefined);
    configureCodRuntime({ controlPlaneUrl: 'https://cod.test', hostPlatform: 'ios', nativeRequest, cancelNativeRequest });
    const controller = new AbortController();

    const chat = sendChat('native-token', 'ai-kai', 'model-1', [{ role: 'user', content: '停止这次回复' }], { signal: controller.signal });
    await vi.waitFor(() => expect(nativeRequest).toHaveBeenCalledTimes(1));
    controller.abort();

    await expect(Promise.race([
      chat,
      new Promise<never>((_resolve, reject) => globalThis.setTimeout(() => reject(new Error('native abort did not settle')), 250)),
    ])).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancelNativeRequest).toHaveBeenCalledTimes(1);
  });

  it('contains failed native cancellation and a late native rejection after abort', async () => {
    let rejectNative!: (reason: Error) => void;
    const nativeRequest = vi.fn(() => new Promise<import('./runtime').NativeHttpResponse>((_resolve, reject) => { rejectNative = reject; }));
    const cancelNativeRequest = vi.fn(async () => { throw new Error('native cancellation failed'); });
    configureCodRuntime({ controlPlaneUrl: 'https://cod.test', hostPlatform: 'android', nativeRequest, cancelNativeRequest });
    const controller = new AbortController();

    const chat = sendChat('native-token', 'ai-kai', 'model-1', [{ role: 'user', content: '停止这次回复' }], { signal: controller.signal });
    await vi.waitFor(() => expect(nativeRequest).toHaveBeenCalledTimes(1));
    controller.abort();

    await expect(Promise.race([
      chat,
      new Promise<never>((_resolve, reject) => globalThis.setTimeout(() => reject(new Error('native abort did not settle')), 250)),
    ])).rejects.toMatchObject({ name: 'AbortError' });
    rejectNative(new Error('late native transport failure'));
    await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
    expect(cancelNativeRequest).toHaveBeenCalledTimes(1);
  });

  it('keeps the stored token when transient reads remain unavailable', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async () => Response.json({ error: 'temporary' }, { status: 503 }));
    vi.stubGlobal('fetch', fetcher);
    persistCodSession('still-valid-token');

    const recovery = resumeCodSession();
    await vi.runAllTimersAsync();
    await expect(recovery).resolves.toBeNull();
    expect(window.localStorage.getItem('cod.session.token')).toBe('still-valid-token');
    expect(fetcher).toHaveBeenCalledTimes(6);
  });

  it('does not replay a failed credential submission', async () => {
    const fetcher = vi.fn(async () => Response.json({ error: 'temporary' }, { status: 503 }));
    vi.stubGlobal('fetch', fetcher);

    await expect(loginCod('user@kai.com', 'Password123')).rejects.toBeInstanceOf(ApiError);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('returns an issued registration token without persisting or hydrating it', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/auth/register')) return Response.json({ token: 'registered-token' }, { status: 201 });
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetcher);

    await expect(registerCod({ challengeId: 'challenge-1', email: 'new@kai.test', phone: '+8613800138000', password: 'Password123' }, { idempotencyKey: 'registration-attempt-1' })).resolves.toBe('registered-token');
    expect(window.localStorage.getItem('cod.session.token')).toBeNull();
    expect(fetcher.mock.calls.filter(([input]) => String(input).endsWith('/api/auth/register'))).toHaveLength(1);
  });

  it('uses the dual verification registration contract and keeps OTPs out of storage', async () => {
    const calls: Array<{ path: string; body: Record<string, unknown>; idempotencyKey: string | null }> = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {}, idempotencyKey: new Headers(init?.headers).get('idempotency-key') });
      if (path.endsWith('/email/start')) return Response.json({ challengeId: 'challenge-1', maskedDestination: 'n***@kai.test', expiresAt: '2026-08-12T10:10:00.000Z', resendAt: '2026-08-12T10:01:00.000Z' }, { status: 202 });
      if (path.endsWith('/email/verify') || path.endsWith('/phone/verify')) return Response.json({ verified: true });
      if (path.endsWith('/phone/start')) return Response.json({ challengeId: 'challenge-1', maskedDestination: '+86******8000', expiresAt: '2026-08-12T10:10:00.000Z', resendAt: '2026-08-12T10:01:00.000Z' }, { status: 202 });
      if (path.endsWith('/auth/register')) return Response.json({ token: 'registered-token' }, { status: 201 });
      if (path.endsWith('/account')) return Response.json(account);
      if (path.endsWith('/model-sources')) return Response.json([]);
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal('fetch', fetcher);

    await startRegistrationEmail('new@kai.test', 'turnstile-email');
    await verifyRegistrationEmail('challenge-1', 'new@kai.test', '123456');
    await startRegistrationPhone('challenge-1', 'new@kai.test', '+8613800138000', 'turnstile-phone');
    await verifyRegistrationPhone('challenge-1', 'new@kai.test', '+8613800138000', '654321');
    await expect(registerCod({ challengeId: 'challenge-1', email: 'new@kai.test', phone: '+8613800138000', password: 'Password123' }, { idempotencyKey: 'registration-attempt-1' })).resolves.toBe('registered-token');

    expect(calls.slice(0, 5)).toEqual([
      { path: '/api/auth/registration/email/start', body: { email: 'new@kai.test', humanChallengeToken: 'turnstile-email' }, idempotencyKey: null },
      { path: '/api/auth/registration/email/verify', body: { challengeId: 'challenge-1', email: 'new@kai.test', code: '123456' }, idempotencyKey: null },
      { path: '/api/auth/registration/phone/start', body: { challengeId: 'challenge-1', email: 'new@kai.test', phone: '+8613800138000', humanChallengeToken: 'turnstile-phone' }, idempotencyKey: null },
      { path: '/api/auth/registration/phone/verify', body: { challengeId: 'challenge-1', email: 'new@kai.test', phone: '+8613800138000', code: '654321' }, idempotencyKey: null },
      { path: '/api/auth/register', body: { challengeId: 'challenge-1', email: 'new@kai.test', phone: '+8613800138000', password: 'Password123' }, idempotencyKey: 'registration-attempt-1' },
    ]);
    expect(JSON.stringify([...Array(window.localStorage.length)].map((_, index) => window.localStorage.getItem(window.localStorage.key(index)!)))).not.toContain('123456');
    expect(window.localStorage.getItem('cod.session.token')).toBeNull();
  });

  it('aborts authentication issuance and never stores a token', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })));
    vi.stubGlobal('fetch', fetcher);
    const login = loginCod('user@kai.test', 'Password123', { signal: controller.signal });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    controller.abort(new DOMException('Dialog closed', 'AbortError'));
    await expect(login).rejects.toMatchObject({ name: 'AbortError' });
    expect(window.localStorage.getItem('cod.session.token')).toBeNull();
  });

  it('retries an idempotent compute submission with the same request key', async () => {
    vi.useFakeTimers();
    const requestKeys: string[] = [];
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestKeys.push(new Headers(init?.headers).get('idempotency-key') ?? '');
      if (requestKeys.length === 1) return Response.json({ error: 'temporary' }, { status: 503 });
      return Response.json({
        id: 'hosting-request-1', email: 'owner@example.com', status: 'submitted', fulfillmentMode: 'third-party-manual-match',
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
    });
    vi.stubGlobal('fetch', fetcher);

    const submission = createComputeRequest('member-token', {
      kind: 'hosting', company: '星港算力', contactName: '林工', contactPhone: '13800138000', city: '深圳',
      gpuModel: 'NVIDIA RTX 4090 24GB', quantity: 8, requirements: '需门禁记录、远程运维、设备保险及书面 SLA',
      hostingPeriodMonths: 12, availabilityNotes: '4U 双电源服务器，月底可进场', settlementPreference: '固定托管费（月结）',
      hostingRequirements: '需门禁记录、远程运维、设备保险及书面 SLA',
    });
    await vi.runAllTimersAsync();
    await expect(submission).resolves.toMatchObject({ id: 'hosting-request-1', status: 'submitted' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(requestKeys[0]).not.toBe('');
    expect(requestKeys[1]).toBe(requestKeys[0]);
  });

  it('keeps administrator compute search filters and contact identifiers out of the URL', async () => {
    let requestUrl = '';
    let requestBody: Record<string, unknown> = {};
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requestUrl = String(input);
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(init?.method).toBe('POST');
      return Response.json({ items: [], nextCursor: null });
    });
    vi.stubGlobal('fetch', fetcher);

    await expect(listAdminComputeRequests('admin-token', { cursor: 'opaque-cursor', kind: 'hosting', status: 'submitted', q: 'owner@example.com' })).resolves.toEqual({ items: [], nextCursor: null });
    expect(requestUrl).toBe('https://cod.test/api/admin/compute/requests/search');
    expect(requestUrl).not.toContain('owner');
    expect(requestUrl).not.toContain('opaque-cursor');
    expect(requestBody).toEqual({ limit: 50, cursor: 'opaque-cursor', kind: 'hosting', status: 'submitted', q: 'owner@example.com' });
  });

  it('uses GET for non-sensitive administrator list filters and sends optimistic status state', async () => {
    const calls:Array<{url:string;method:string;body:unknown}>=[];
    vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
      calls.push({url:String(input),method:init?.method??'GET',body:init?.body?JSON.parse(String(init.body)):null});
      if(String(input).includes('/status'))return Response.json({id:'request-1',status:'contacting'});
      return Response.json({items:[],nextCursor:null});
    }));

    await listAdminComputeRequests('admin-token',{cursor:'opaque-cursor',kind:'hosting',status:'submitted'});
    await updateAdminComputeRequestStatus('admin-token','request-1','contacting','submitted');

    expect(calls[0]).toEqual({url:'https://cod.test/api/admin/compute/requests?limit=50&cursor=opaque-cursor&kind=hosting&status=submitted',method:'GET',body:null});
    expect(calls[1]).toEqual({url:'https://cod.test/api/admin/compute/requests/request-1/status',method:'PATCH',body:{status:'contacting',expectedStatus:'submitted'}});
  });

  it('claims a task execution lease, binds chat and terminal status to it, then clears it', async () => {
    const task: RemoteTask = {
      id: '10000000-0000-4000-8000-000000000001', title: '租约任务', status: 'draft', deviceId: 'device-1',
      updatedAt: '2026-08-12T00:00:00.000Z', version: 1, result: null, error: null,
    };
    const executionId = '20000000-0000-4000-8000-000000000002';
    let claimBody: Record<string, unknown> = {};
    let chatHeaders = new Headers();
    let terminalBody: Record<string, unknown> = {};
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith(`/api/tasks/${task.id}/status`)) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        if (body.status === 'running') {
          claimBody = body;
          return Response.json({
            ...task, status: 'running', version: 2,
            execution: { executionId, leaseToken: body.leaseToken, leaseExpiresAt: '2026-08-12T00:05:00.000Z' },
          });
        }
        terminalBody = body;
        return Response.json({ ...task, status: 'complete', version: 3, result: '完成' });
      }
      if (url.endsWith('/v1/chat/completions')) {
        chatHeaders = new Headers(init?.headers);
        return Response.json({ choices: [{ message: { content: '租约回复' } }], usage: { prompt_tokens: 2, completion_tokens: 3 } });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));

    const running = await updateRemoteTask('token', task, 'running');
    expect(claimBody).toMatchObject({ status: 'running', expectedVersion: 1 });
    expect(claimBody.claimId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(claimBody.leaseToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(getTaskExecutionLease(task.id)).toMatchObject({ executionId, leaseToken: claimBody.leaseToken });

    await expect(sendChat('token', 'demo', 'demo-model', [{ role: 'user', content: '测试' }], { taskId: task.id })).resolves.toMatchObject({ content: '租约回复' });
    expect(chatHeaders.get('x-cod-task-execution')).toBe(executionId);
    expect(chatHeaders.get('x-cod-task-lease')).toBe(claimBody.leaseToken);

    await updateRemoteTask('token', running, 'complete', { result: '完成' });
    expect(terminalBody).toMatchObject({ status: 'complete', expectedVersion: 2, executionId, leaseToken: claimBody.leaseToken, result: '完成' });
    expect(getTaskExecutionLease(task.id)).toBeNull();
  });

  it('keeps the legacy task protocol usable when running succeeds without an execution lease', async () => {
    const task: RemoteTask = {
      id: '30000000-0000-4000-8000-000000000003', title: '旧协议任务', status: 'draft', deviceId: 'device-1',
      updatedAt: '2026-08-12T00:00:00.000Z', version: 1, result: null, error: null,
    };
    let chatHeaders = new Headers();
    let chatBody: Record<string, unknown> = {};
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith(`/api/tasks/${task.id}/status`)) {
        return Response.json({ ...task, status: 'running', version: 2 });
      }
      if (url.endsWith('/v1/chat/completions')) {
        chatHeaders = new Headers(init?.headers);
        chatBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({ choices: [{ message: { content: '旧后端回复' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));

    await expect(updateRemoteTask('token', task, 'running')).resolves.toMatchObject({ status: 'running' });
    expect(getTaskExecutionLease(task.id)).toBeNull();
    await expect(sendChat('token', 'demo', 'demo-model', [{ role: 'user', content: '测试' }], { taskId: task.id })).resolves.toMatchObject({ content: '旧后端回复' });
    expect(chatBody).toMatchObject({ task_id: task.id });
    expect(chatHeaders.has('x-cod-task-execution')).toBe(false);
    expect(chatHeaders.has('x-cod-task-lease')).toBe(false);
  });

  it('retries a task claim once with the same credentials and honors Retry-After', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-12T00:00:00.000Z'));
    const task: RemoteTask = {
      id: '40000000-0000-4000-8000-000000000004', title: '重试任务', status: 'draft', deviceId: 'device-1',
      updatedAt: '2026-08-12T00:00:00.000Z', version: 1, result: null, error: null,
    };
    const bodies: string[] = [];
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(String(init?.body));
      if (bodies.length === 1) return Response.json({ error: 'temporary', message: 'temporary' }, { status: 429, headers: { 'retry-after': '1' } });
      const body = JSON.parse(String(init?.body)) as { leaseToken: string };
      return Response.json({
        ...task, status: 'running', version: 2,
        execution: { executionId: '50000000-0000-4000-8000-000000000005', leaseToken: body.leaseToken, leaseExpiresAt: '2026-08-12T00:05:00.000Z' },
      });
    });
    vi.stubGlobal('fetch', fetcher);

    const pending = updateRemoteTask('token', task, 'running');
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toMatchObject({ status: 'running' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(bodies[1]).toBe(bodies[0]);
    expect(Date.now()).toBe(new Date('2026-08-12T00:00:01.000Z').getTime());
  });

  it('keeps Retry-After metadata and localizes task credential errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(
      { error: 'invalid_task_claim', message: 'Task execution claim is invalid' },
      { status: 400, headers: { 'retry-after': '2' } },
    )));

    await expect(updateAdminComputeRequestStatus('token', 'request-1', 'contacting', 'submitted')).rejects.toMatchObject({
      code: 'invalid_task_claim',
      message: '任务启动凭据无效，请刷新任务后重新执行。',
      retryAfterMs: 2_000,
    });
  });
});
