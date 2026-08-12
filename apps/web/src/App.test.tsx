import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminComputeRequestSummary, WorkspaceFile } from '@cod/contracts';
import { App } from './App';
import { createClientId, getControlPlaneUrl, sendChat, type ComputeRequest } from './api';
import { configureCodRuntime, dispatchCodNativeBack } from './runtime';

beforeEach(() => {
  delete window.codDesktop;
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
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  delete window.codDesktop;
  delete (window as Window & { turnstile?: unknown }).turnstile;
  configureCodRuntime({});
  try { window.localStorage?.clear(); } catch { /* Node can expose localStorage without a backing file. */ }
  vi.unstubAllGlobals();
});

const capabilities = {
  authentication: { mode: 'password', registrationEnabled: true, inviteCodeOptional: true, inviteCodeRequired: false, accessCodeRequired: false },
  ai: { mode: 'demo', streaming: false, streamingMode: 'buffered-sse' as const },
  knowledge: { mode: 'demo' },
  payments: { topupEnabled: false, orderApi: false, mode: 'unavailable' as const },
  synchronization: { transport: 'polling', taskStatusVersioning: true },
  remote: { feishu: 'unavailable' as const, wecom: 'unavailable' as const },
};
const creditPacks = { packs: [{ id: 'starter', name: '入门额度包', priceCents: 2000, creditCents: 2000, bonusPercent: 0, validityDays: 180 }], summary: { availableCents: 1000, grants: [{ id: 'trial', packId: 'trial', name: '新用户试用金', originalCents: 1000, remainingCents: 1000, purchasedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 30 * 86400000).toISOString(), status: 'active' }] } };

const adminComputeRequests = [
  {
    id: 'compute-hosting-1', email: 'owner@example.com', kind: 'hosting', offerId: null, company: '星港算力', contactName: '林工', contactPhone: 'wx_gpu_owner', city: '深圳',
    gpuModel: 'NVIDIA RTX 4090 24GB', quantity: 8, durationHours: null, termMonths: null, requirements: '需要第三方机房托管与书面 SLA',
    hostingPeriodMonths: 12, rackUnits: 4, powerKilowatts: 6.5, networkMbps: 1000, availabilityNotes: '4U 双电源服务器，月底可进场',
    settlementPreference: '固定托管费（月结）', hostingRequirements: '门禁记录、远程运维、设备保险', fulfillmentMode: 'third-party-manual-match',
    status: 'submitted', createdAt: '2026-08-11T08:00:00.000Z', updatedAt: '2026-08-11T08:00:00.000Z',
  },
  {
    id: 'compute-rental-1', email: 'renter@example.com', kind: 'rental', offerId: 'cod-h100', company: '海岸模型', contactName: '周工', contactPhone: '13800138000', city: '上海',
    gpuModel: 'NVIDIA H100 80GB', quantity: 2, durationHours: 500, termMonths: null, requirements: '下周开始训练', hostingPeriodMonths: null, rackUnits: null,
    powerKilowatts: null, networkMbps: null, availabilityNotes: null, settlementPreference: null, hostingRequirements: null, fulfillmentMode: 'manual-confirmation',
    status: 'contacting', createdAt: '2026-08-10T08:00:00.000Z', updatedAt: '2026-08-10T09:00:00.000Z',
  },
  {
    id: 'compute-installment-1', email: 'buyer@example.com', kind: 'installment', offerId: null, company: '远景研究', contactName: '陈工', contactPhone: '13900139000', city: '北京',
    gpuModel: 'NVIDIA B200', quantity: 4, durationHours: null, termMonths: 24, requirements: '需要正式报价', hostingPeriodMonths: null, rackUnits: null,
    powerKilowatts: null, networkMbps: null, availabilityNotes: null, settlementPreference: null, hostingRequirements: null, fulfillmentMode: 'manual-confirmation',
    status: 'quoted', createdAt: '2026-08-09T08:00:00.000Z', updatedAt: '2026-08-09T10:00:00.000Z',
  },
] as const;

function adminComputeRequestSummary(request: ComputeRequest): AdminComputeRequestSummary {
  const { id, kind, company, gpuModel, quantity, status, createdAt, updatedAt } = request;
  return { id, kind, company, gpuModel, quantity, status, createdAt, updatedAt };
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

describe('COD workspace', () => {
  it('creates client IDs when randomUUID is unavailable on HTTP origins', () => {
    vi.stubGlobal('crypto', { getRandomValues: (bytes: Uint8Array) => { bytes.fill(7); return bytes; } });
    expect(createClientId()).toBe('07'.repeat(16));
  });

  it('uses the native transport and injected control plane inside Expo DOM', async () => {
    let nativeRequest: import('./runtime').NativeHttpRequest | undefined;
    configureCodRuntime({
      controlPlaneUrl: 'https://mobile.cod.example/',
      hostPlatform: 'android',
      nativeRequest: async (request) => {
        nativeRequest = request;
        return { status: 200, body: JSON.stringify({ choices: [{ message: { content: '原生响应' } }], usage: { prompt_tokens: 2, completion_tokens: 3 } }) };
      },
    });
    expect(getControlPlaneUrl()).toBe('https://mobile.cod.example');
    expect(await sendChat('token', 'demo', 'demo-model', [{ role: 'user', content: '测试' }])).toMatchObject({ content: '原生响应', inputTokens: 2, outputTokens: 3 });
    expect(nativeRequest).toMatchObject({ url: 'https://mobile.cod.example/v1/chat/completions', method: 'POST' });
    expect(nativeRequest?.headers.authorization).toBe('Bearer token');
  });

  it('sends recent multi-turn context to the model gateway', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void input; void init;
      return json({ choices: [{ message: { content: '继续回答' } }], usage: { prompt_tokens: 12, completion_tokens: 34 }, cod_source: 'ai-kai' });
    });
    vi.stubGlobal('fetch', fetchMock);
    expect(await sendChat('token', 'ai-kai', 'model-1', [{ role: 'user', content: '第一问' }, { role: 'assistant', content: '   ' }, { role: 'assistant', content: '第一答' }, { role: 'user', content: '继续' }])).toMatchObject({ inputTokens: 12, outputTokens: 34 });
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { messages: Array<{ role: string; content: string }>; max_tokens: number };
    expect(body.messages).toEqual([{ role: 'user', content: '第一问' }, { role: 'assistant', content: '第一答' }, { role: 'user', content: '继续' }]);
    expect(body).toMatchObject({ max_tokens: 4_096 });
    expect(body).not.toHaveProperty('task_id');
  });

  it('rejects empty model responses instead of rendering a blank reply', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ choices: [{ message: { content: '   ' } }], usage: { prompt_tokens: 12, completion_tokens: 34 }, cod_source: 'ai-kai', cod_charge_cents: 4 })));
    await expect(sendChat('token', 'ai-kai', 'glm-5.2', [{ role: 'user', content: '问题' }])).rejects.toMatchObject({ code: 'empty_model_response' });
  });

  it('keeps explicit task-bound model requests bound and aborts without retrying when cancelled',async()=>{
    let requestSignal:AbortSignal|undefined;let requestBody:Record<string,unknown>|null=null;let started:()=>void=()=>undefined;const requestStarted=new Promise<void>((resolve)=>{started=resolve;});
    const fetchMock=vi.fn(async(_input:RequestInfo|URL,init?:RequestInit):Promise<Response>=>{requestSignal=init?.signal??undefined;requestBody=JSON.parse(String(init?.body)) as Record<string,unknown>;started();return new Promise<Response>((_resolve,reject)=>requestSignal?.addEventListener('abort',()=>reject(requestSignal?.reason),{once:true}));});
    vi.stubGlobal('fetch',fetchMock);const controller=new AbortController();const pending=sendChat('token','ai-kai','model-1',[{role:'user',content:'长任务'}],{taskId:'task-1',signal:controller.signal});await requestStarted;controller.abort(new DOMException('Task cancelled','AbortError'));await expect(pending).rejects.toMatchObject({name:'AbortError'});expect(requestSignal?.aborted).toBe(true);expect(requestBody).toMatchObject({task_id:'task-1'});expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('shows the workspace first and opens login when the first message is sent', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(capabilities)));
    render(<App />);
    expect(await screen.findByRole('heading', { name: '新对话' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '休息一下，把任务交给 COD' })).toBeInTheDocument();
    expect(screen.getByText('Ctrl / ⌘ Enter 发送', { selector: '.composer-footer > span' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    const composer = screen.getByPlaceholderText('问 COD 任何问题...');
    fireEvent.change(composer, { target: { value: '这是我的第一条消息' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    const dialog = await screen.findByRole('dialog', { name: '登录后继续' });
    expect(within(dialog).getByLabelText('密码')).toBeRequired();
    expect(composer).toHaveValue('这是我的第一条消息');
  });

  it('starts and completes a mobile model conversation without an online Desktop or task-bound chat claim', async () => {
    window.localStorage.setItem('cod.session.token', 'mobile-token');
    configureCodRuntime({ hostPlatform: 'ios' });
    let taskVersion = 1;
    let registeredDevice: Record<string, unknown> | null = null;
    let chatBody: Record<string, unknown> | null = null;
    const account = { userId: 'mobile-user', displayName: 'mobile member', balanceCents: 5000, currency: 'CNY', plan: 'developer', role: 'member', billingExempt: false };
    const source = { id: 'ai-kai', label: 'AI.KAI.COM', status: 'live', callable: true, paymentDirection: '钱包 → ai.kai.com', note: '已连接', models: [{ id: 'mobile-model', label: '移动对话模型', contextWindow: 128000, inputPricePerMillionCents: 100, outputPricePerMillionCents: 200 }] };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/capabilities')) return json({ ...capabilities, ai: { ...capabilities.ai, mode: 'live' } });
      if (url.endsWith('/api/model-catalog')) return json([source]);
      if (url.endsWith('/api/account')) return json(account);
      if (url.endsWith('/api/model-sources')) return json([source]);
      if (url.endsWith('/api/devices') && init?.method === 'POST') {
        registeredDevice = JSON.parse(String(init.body)) as Record<string, unknown>;
        return json({ id: 'mobile-device', name: 'COD Mobile', platform: 'mobile', status: 'online', lastSeenAt: new Date().toISOString() }, 201);
      }
      if (url.endsWith('/api/devices')) return json([]);
      if (url.endsWith('/api/tasks') && init?.method === 'POST') {
        return json({ id: 'mobile-conversation', title: '移动端你好', status: 'draft', deviceId: 'mobile-device', updatedAt: new Date().toISOString(), version: taskVersion }, 201);
      }
      if (url.endsWith('/api/tasks')) return json([]);
      if (/\/api\/tasks\/mobile-conversation\/status$/.test(url)) {
        const body = JSON.parse(String(init?.body)) as { status: 'running' | 'complete' };
        taskVersion += 1;
        return json({ id: 'mobile-conversation', title: '移动端你好', status: body.status, deviceId: 'mobile-device', updatedAt: new Date().toISOString(), version: taskVersion, result: body.status === 'complete' ? '移动端模型回复正常' : null, error: null });
      }
      if (url.endsWith('/v1/chat/completions')) {
        chatBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return json({ choices: [{ message: { content: '移动端模型回复正常' } }], usage: { prompt_tokens: 5, completion_tokens: 7 }, cod_source: 'ai-kai' });
      }
      if (url.endsWith('/api/compute/offers') || url.endsWith('/api/compute/requests') || url.endsWith('/api/products') || url.endsWith('/api/ledger')) return json([]);
      if (url.endsWith('/api/credit-packs')) return json(creditPacks);
      if (url.endsWith('/api/referrals')) return json({ inviteCode: 'MOBILE', referredUsers: 0, commissionRateBps: 0, pendingCommissionCents: 0, settledCommissionCents: 0 });
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const { container } = render(<App />);
    const conversationScroll = container.querySelector('.conversation-scroll') as HTMLDivElement;
    Object.defineProperty(conversationScroll, 'scrollHeight', { configurable: true, value: 640 });

    await waitFor(() => expect(screen.getByRole('combobox', { name: '模型' })).toHaveValue('mobile-model'));
    fireEvent.click(screen.getByTitle('打开任务栏'));
    const sidebar = container.querySelector('.sidebar');
    expect(sidebar).not.toBeNull();
    fireEvent.click(within(sidebar as HTMLElement).getByRole('button', { name: '新对话' }));
    expect(screen.queryByRole('dialog', { name: '新建任务' })).not.toBeInTheDocument();

    const composer = screen.getByPlaceholderText('问 COD 任何问题...');
    fireEvent.change(composer, { target: { value: '移动端你好' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    expect(await screen.findByText('移动端模型回复正常')).toBeInTheDocument();
    await waitFor(() => expect(conversationScroll.scrollTop).toBe(640));
    expect(registeredDevice).toMatchObject({ name: 'COD Mobile', platform: 'mobile' });
    expect(chatBody).toMatchObject({ source: 'ai-kai', model: 'mobile-model', messages: [{ role: 'user', content: '移动端你好' }] });
    expect(chatBody).not.toHaveProperty('task_id');
  });

  it('requires both verification codes before showing the optional invite code', async () => {
    const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), window.location.href).pathname;
      if (path === '/api/capabilities') return json(capabilities);
      if (path === '/api/model-catalog' || path === '/api/compute/offers') return json([]);
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      requests.push({ path, body });
      if (path.endsWith('/registration/email/start')) return json({ challengeId: 'challenge-1', maskedDestination: 't***@kai.test', expiresAt: new Date(Date.now() + 600_000).toISOString(), resendAt: new Date(Date.now() + 60_000).toISOString() }, 202);
      if (path.endsWith('/registration/email/verify') || path.endsWith('/registration/phone/verify')) return json({ verified: true });
      if (path.endsWith('/registration/phone/start')) return json({ challengeId: 'challenge-1', maskedDestination: '+86******8000', expiresAt: new Date(Date.now() + 600_000).toISOString(), resendAt: new Date(Date.now() + 60_000).toISOString() }, 202);
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    await screen.findByRole('heading', { name: '新对话' });
    fireEvent.click(screen.getByTitle('登录'));
    const dialog = await screen.findByRole('dialog', { name: '登录 COD' });
    fireEvent.click(within(dialog).getByRole('tab', { name: '注册账号' }));
    expect(screen.getByRole('dialog', { name: '注册 COD' })).toBe(dialog);
    expect(within(dialog).queryByLabelText('邀请码')).not.toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('邮箱'), { target: { value: 'tester@kai.test' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '发送邮箱验证码' }));
    const emailCode = await within(dialog).findByLabelText('邮箱验证码');
    expect(emailCode).toHaveAttribute('inputmode', 'numeric');
    expect(emailCode).toHaveAttribute('autocomplete', 'one-time-code');
    fireEvent.change(emailCode, { target: { value: '12a3456' } });
    expect(emailCode).toHaveValue('123456');
    fireEvent.click(within(dialog).getByRole('button', { name: '验证邮箱' }));
    const phone = await within(dialog).findByLabelText('手机号');
    expect(phone).toHaveAttribute('type', 'tel');
    expect(phone).toHaveAttribute('autocomplete', 'tel');
    fireEvent.change(phone, { target: { value: '+86 138 0013 8000' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '发送手机验证码' }));
    const phoneCode = await within(dialog).findByLabelText('手机验证码');
    fireEvent.change(phoneCode, { target: { value: '654321' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '验证手机' }));
    await within(dialog).findByLabelText('邀请码');
    expect(within(dialog).getByLabelText('邀请码')).not.toBeRequired();
    expect(requests).toEqual(expect.arrayContaining([
      { path: '/api/auth/registration/email/start', body: { email: 'tester@kai.test' } },
      { path: '/api/auth/registration/email/verify', body: { challengeId: 'challenge-1', email: 'tester@kai.test', code: '123456' } },
      { path: '/api/auth/registration/phone/start', body: { challengeId: 'challenge-1', email: 'tester@kai.test', phone: '+8613800138000' } },
      { path: '/api/auth/registration/phone/verify', body: { challengeId: 'challenge-1', email: 'tester@kai.test', phone: '+8613800138000', code: '654321' } },
    ]));
    fireEvent.click(within(dialog).getByRole('tab', { name: '密码登录' }));
    expect(screen.getByRole('dialog', { name: '登录 COD' })).toBe(dialog);
  });

  it('opens a capability-gated registration deep link and consumes its URL intent', async () => {
    window.history.replaceState({}, '', '/app/?auth=register');
    vi.stubGlobal('fetch', vi.fn(async () => json(capabilities)));
    render(<App />);

    const dialog = await screen.findByRole('dialog', { name: '注册 COD' });
    expect(within(dialog).getByRole('tab', { name: '注册账号' })).toHaveAttribute('aria-selected', 'true');
    expect(within(dialog).getByLabelText('邮箱')).toHaveAttribute('autocomplete', 'email');
    expect(within(dialog).queryByLabelText('邀请码')).not.toBeInTheDocument();
    expect(window.location.pathname).toBe('/app/');
    expect(window.location.search).toBe('');
  });

  it('renders Turnstile only on Web and sends its token without storing it', async () => {
    const remove = vi.fn();
    const renderTurnstile = vi.fn((_container: HTMLElement, options: { callback: (token: string) => void }) => {
      options.callback('human-token');
      return 'widget-1';
    });
    (window as Window & { turnstile?: unknown }).turnstile = { render: renderTurnstile, remove };
    let startBody: Record<string, unknown> | null = null;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), window.location.href).pathname;
      if (path === '/api/capabilities') return json({ ...capabilities, authentication: { ...capabilities.authentication, turnstileSiteKey: 'site-key' } });
      if (path === '/api/model-catalog' || path === '/api/compute/offers') return json([]);
      if (path.endsWith('/registration/email/start')) {
        startBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return json({ challengeId: 'challenge-1', maskedDestination: 't***@kai.test', expiresAt: new Date(Date.now() + 600_000).toISOString(), resendAt: new Date(Date.now() + 60_000).toISOString() }, 202);
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    await screen.findByRole('heading', { name: '新对话' });
    fireEvent.click(screen.getByTitle('登录'));
    const dialog = await screen.findByRole('dialog', { name: '登录 COD' });
    fireEvent.click(within(dialog).getByRole('tab', { name: '注册账号' }));
    await waitFor(() => expect(renderTurnstile).toHaveBeenCalledTimes(1));
    fireEvent.change(within(dialog).getByLabelText('邮箱'), { target: { value: 'tester@kai.test' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '发送邮箱验证码' }));
    await within(dialog).findByLabelText('邮箱验证码');
    expect(startBody).toEqual({ email: 'tester@kai.test', humanChallengeToken: 'human-token' });
    expect(window.localStorage.getItem('humanChallengeToken')).toBeNull();
    expect(remove).toHaveBeenCalledWith('widget-1');
  });

  it('hands native registration to the secure web flow without calling OTP endpoints', async () => {
    const openExternalUrl = vi.fn(async () => undefined);
    configureCodRuntime({ hostPlatform: 'ios', openExternalUrl });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), window.location.href).pathname;
      if (path === '/api/capabilities') return json({ ...capabilities, authentication: { ...capabilities.authentication, turnstileSiteKey: 'site-key', registrationWebOnly: true, publicRegistrationUrl: 'https://cod.kai.com/app/?auth=register' } });
      if (path === '/api/model-catalog' || path === '/api/compute/offers') return json([]);
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    await screen.findByRole('heading', { name: '新对话' });
    fireEvent.click(screen.getByTitle('登录'));
    const dialog = await screen.findByRole('dialog', { name: '登录 COD' });
    fireEvent.click(within(dialog).getByRole('tab', { name: '注册账号' }));
    expect(within(dialog).getByText('请先在网页完成注册')).toBeInTheDocument();
    expect(within(dialog).queryByLabelText('邮箱')).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: /打开网页注册/ }));
    expect(openExternalUrl).toHaveBeenCalledWith('https://cod.kai.com/app/?auth=register');
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/api/auth/registration/'))).toBe(false);
  });

  it('clears a registration deep-link mode when Android back closes authentication', async () => {
    configureCodRuntime({ hostPlatform: 'android' });
    window.history.replaceState({}, '', '/app/?auth=register');
    vi.stubGlobal('fetch', vi.fn(async () => json(capabilities)));
    render(<App />);

    await screen.findByRole('dialog', { name: '注册 COD' });
    act(() => { expect(dispatchCodNativeBack()).toBe(true); });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    fireEvent.click(screen.getByTitle('登录'));
    expect(await screen.findByRole('dialog', { name: '登录 COD' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '密码登录' })).toHaveAttribute('aria-selected', 'true');
  });

  it('fails a registration deep link closed when public registration is disabled', async () => {
    window.history.replaceState({}, '', '/app/?auth=register');
    const closedCapabilities = {
      ...capabilities,
      authentication: { ...capabilities.authentication, registrationEnabled: false },
    };
    vi.stubGlobal('fetch', vi.fn(async () => json(closedCapabilities)));
    render(<App />);

    const dialog = await screen.findByRole('dialog', { name: '登录 COD' });
    expect(within(dialog).queryByRole('tab', { name: '注册账号' })).not.toBeInTheDocument();
    expect(within(dialog).getByText(/新注册暂未开放/)).toBeInTheDocument();
    expect(window.location.search).toBe('');
  });

  it('does not interrupt an existing session with a registration deep link', async () => {
    window.history.replaceState({}, '', '/app/?auth=register');
    window.localStorage.setItem('cod.session.token', 'member-token');
    const account = { userId: 'member-user', displayName: 'member', balanceCents: 0, currency: 'CNY', plan: 'developer', role: 'member', billingExempt: false };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/capabilities')) return json(capabilities);
      if (url.endsWith('/api/account')) return json(account);
      if (url.endsWith('/api/model-sources') || url.endsWith('/api/model-catalog') || url.endsWith('/api/devices') || url.endsWith('/api/tasks') || url.endsWith('/api/products') || url.endsWith('/api/ledger') || url.endsWith('/api/compute/offers') || url.endsWith('/api/compute/requests')) return json([]);
      if (url.endsWith('/api/credit-packs')) return json({ packs: [], summary: { availableCents: 0, grants: [] } });
      if (url.endsWith('/api/referrals')) return json({ inviteCode: 'MEMBER', referredUsers: 0, commissionRateBps: 0, pendingCommissionCents: 0, settledCommissionCents: 0 });
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);

    await waitFor(() => expect(screen.getByTitle('账户')).toBeInTheDocument());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(window.location.search).toBe('');
  });

  it('offers only one-time legacy migration when new registration is disabled', async () => {
    const migrationCapabilities = {
      ...capabilities,
      authentication: {
        ...capabilities.authentication,
        registrationEnabled: false,
        legacyMigrationEnabled: true,
      },
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/capabilities')) return json(migrationCapabilities);
      if (url.endsWith('/api/model-catalog') || url.endsWith('/api/compute/offers')) return json([]);
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    await screen.findByRole('heading', { name: '新对话' });

    fireEvent.click(screen.getByTitle('登录'));
    const dialog = await screen.findByRole('dialog', { name: '登录 COD' });
    expect(within(dialog).getByRole('tab', { name: '旧账号迁移' })).toBeInTheDocument();
    expect(within(dialog).queryByRole('tab', { name: '注册账号' })).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('tab', { name: '旧账号迁移' }));

    expect(within(dialog).getByRole('heading', { name: '迁移旧账号' })).toBeInTheDocument();
    expect(within(dialog).getByLabelText('确认密码')).toBeRequired();
    expect(within(dialog).getByLabelText('旧试点访问码')).toBeRequired();
    expect(within(dialog).queryByLabelText('邀请码')).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '迁移旧账号' })).toBeInTheDocument();
  });

  it('fails closed without exposing registration when capabilities are unavailable', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/capabilities')) return json({ error: 'temporarily_unavailable' }, 503);
      if (url.endsWith('/api/model-catalog') || url.endsWith('/api/compute/offers')) return json([]);
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    await screen.findByRole('heading', { name: '新对话' });

    fireEvent.click(screen.getByTitle('登录'));
    const dialog = await screen.findByRole('dialog', { name: '登录 COD' });
    expect(within(dialog).getByRole('tab', { name: '密码登录' })).toHaveAttribute('aria-selected', 'true');
    expect(within(dialog).queryByRole('tab', { name: '注册账号' })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('tab', { name: '旧账号迁移' })).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText('邀请码')).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText('旧试点访问码')).not.toBeInTheDocument();
    expect(await within(dialog).findByText('控制平面暂不可达，请检查网络或服务状态。')).toBeInTheDocument();
    expect(within(dialog).getByText(/新注册暂未开放/)).toBeInTheDocument();
  });

  it('closes dialogs with Escape, traps keyboard focus, and restores the trigger', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(capabilities)));
    render(<App />);
    await screen.findByRole('heading', { name: '新对话' });
    const trigger = screen.getByTitle('登录');
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = await screen.findByRole('dialog', { name: '登录 COD' });
    const close = within(dialog).getByRole('button', { name: '关闭' });
    close.focus();
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    expect(document.activeElement).not.toBe(close);
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '登录 COD' })).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it('keeps authentication bootstrap alive when the login dialog is closed before it finishes', async () => {
    let resolveCapabilities!: (response: Response) => void;
    let resolveCatalog!: (response: Response) => void;
    const pendingCapabilities = new Promise<Response>((resolve) => { resolveCapabilities = resolve; });
    const pendingCatalog = new Promise<Response>((resolve) => { resolveCatalog = resolve; });
    const fetchMock = vi.fn((input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.endsWith('/api/capabilities')) return pendingCapabilities;
      if (url.endsWith('/api/model-catalog')) return pendingCatalog;
      if (url.endsWith('/api/compute/offers')) return Promise.resolve(json([]));
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);

    expect(screen.getByText('正在连接 COD…')).toBeInTheDocument();
    fireEvent.click(screen.getByTitle('登录'));
    const dialog = await screen.findByRole('dialog', { name: '登录 COD' });
    fireEvent.click(within(dialog).getByRole('button', { name: '关闭' }));

    await act(async () => {
      resolveCapabilities(json(capabilities));
      resolveCatalog(json([]));
      await Promise.resolve();
    });

    expect(await screen.findByText('输入消息即可开始')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: '模型源' })).toHaveTextContent('登录后选择模型源');
  });

  it('lets bootstrap finish when Android back cancels a pending login attempt', async () => {
    configureCodRuntime({ hostPlatform: 'android' });
    let resolveCapabilities!: (response: Response) => void;
    let resolveCatalog!: (response: Response) => void;
    let resolveLogin!: (response: Response) => void;
    const pendingCapabilities = new Promise<Response>((resolve) => { resolveCapabilities = resolve; });
    const pendingCatalog = new Promise<Response>((resolve) => { resolveCatalog = resolve; });
    const pendingLogin = new Promise<Response>((resolve) => { resolveLogin = resolve; });
    const fetchMock = vi.fn((input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.endsWith('/api/capabilities')) return pendingCapabilities;
      if (url.endsWith('/api/model-catalog')) return pendingCatalog;
      if (url.endsWith('/api/auth/login')) return pendingLogin;
      if (url.endsWith('/api/account')) return Promise.resolve(json({ userId: 'cancelled-login', displayName: 'cancelled', balanceCents: 0, currency: 'CNY', plan: 'developer' }));
      if (url.endsWith('/api/model-sources')) return Promise.resolve(json([]));
      if (url.endsWith('/api/compute/offers')) return Promise.resolve(json([]));
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);

    fireEvent.click(screen.getByTitle('登录'));
    const dialog = await screen.findByRole('dialog', { name: '登录 COD' });
    fireEvent.change(within(dialog).getByLabelText('邮箱'), { target: { value: 'cancelled@kai.com' } });
    fireEvent.change(within(dialog).getByLabelText('密码'), { target: { value: 'Password123' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '登录' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/api/auth/login'))).toBe(true));

    act(() => { expect(dispatchCodNativeBack()).toBe(true); });
    expect(screen.queryByRole('dialog', { name: '登录 COD' })).not.toBeInTheDocument();
    await act(async () => {
      resolveCapabilities(json(capabilities));
      resolveCatalog(json([]));
      await Promise.resolve();
    });
    expect(await screen.findByText('输入消息即可开始')).toBeInTheDocument();

    await act(async () => {
      resolveLogin(json({ token: 'cancelled-token' }));
      await Promise.resolve();
    });
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)); });
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/api/model-sources'))).toBe(false);
    expect(window.localStorage.getItem('cod.session.token')).toBeNull();
    expect(screen.getByRole('heading', { name: '新对话' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: '模型源' })).toBeDisabled();
  });

  it('keeps five primary mobile rail actions and moves secondary tools into More', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(capabilities)));
    const { container } = render(<App />);
    await screen.findByRole('heading', { name: '新对话' });
    const rail = container.querySelector('.rail');
    expect(rail).not.toBeNull();
    expect(rail?.querySelectorAll('.mobile-rail-primary')).toHaveLength(4);
    expect(rail?.querySelectorAll('.mobile-rail-more')).toHaveLength(1);
    expect(rail?.querySelectorAll('.mobile-rail-secondary').length).toBeGreaterThanOrEqual(3);
    fireEvent.click(screen.getByRole('button', { name: '更多功能' }));
    const dialog = await screen.findByRole('dialog', { name: '更多功能' });
    expect(within(dialog).getByRole('button', { name: /算力市场/ })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /命令面板/ })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /使用深色模式/ })).toBeInTheDocument();
  });

  it('keeps only two primary mobile context items outside the more disclosure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(capabilities)));
    const { container } = render(<App />);
    await screen.findByRole('heading', { name: '新对话' });
    const strip = container.querySelector('.context-strip');
    expect(strip).not.toBeNull();
    expect(strip?.querySelectorAll('.mobile-context-primary')).toHaveLength(2);
    expect(strip?.querySelectorAll('.mobile-context-secondary')).toHaveLength(3);
    const toggle = screen.getByRole('button', { name: '展开更多上下文信息，共 3 项' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(strip).toHaveClass('mobile-expanded');
    expect(screen.getByRole('button', { name: '收起上下文信息' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('keeps a valid session when non-auth workspace services are temporarily unavailable', async () => {
    window.localStorage.setItem('cod.session.token', 'valid-token');
    const account = { userId: 'user', displayName: 'member', balanceCents: 0, currency: 'CNY', plan: 'developer', role: 'member', billingExempt: false };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/capabilities')) return json(capabilities);
      if (url.endsWith('/api/model-catalog')) return json([]);
      if (url.endsWith('/api/compute/offers')) return json([]);
      if (url.endsWith('/api/account')) return json(account);
      if (url.endsWith('/api/model-sources')) return json([]);
      if (url.endsWith('/api/devices') || url.endsWith('/api/tasks')) return json({ error: 'temporary' }, 503);
      if (url.endsWith('/api/products') || url.endsWith('/api/ledger')) return json([]);
      if (url.endsWith('/api/credit-packs')) return json(creditPacks);
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    expect(await screen.findByRole('heading', { name: '新建或选择任务' })).toBeInTheDocument();
    expect((await screen.findAllByText(/已登录；设备同步、任务暂未加载/)).length).toBeGreaterThan(0);
    expect(window.localStorage.getItem('cod.session.token')).toBe('valid-token');
    expect(screen.getByTitle('账户')).toBeInTheDocument();
  });

  it('recovers mobile device registration after a transient cold-start failure and sends taskless chat', async () => {
    window.localStorage.setItem('cod.session.token', 'mobile-recovery-token');
    window.localStorage.setItem('cod.device.id', 'stale-device');
    configureCodRuntime({ hostPlatform: 'ios' });
    const account = { userId: 'mobile-user', displayName: 'mobile member', balanceCents: 5000, currency: 'CNY', plan: 'developer', role: 'member', billingExempt: false };
    const source = { id: 'ai-kai', label: 'AI.KAI.COM', status: 'live', callable: true, paymentDirection: '钱包 → ai.kai.com', note: '已连接', models: [{ id: 'mobile-model', label: '移动对话模型', contextWindow: 128000, inputPricePerMillionCents: 100, outputPricePerMillionCents: 200 }] };
    let deviceServiceAvailable = false;
    let deviceRegistrations = 0;
    let taskVersion = 1;
    let createdTaskBody: Record<string, unknown> | null = null;
    let chatBody: Record<string, unknown> | null = null;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/capabilities')) return json({ ...capabilities, ai: { ...capabilities.ai, mode: 'live' } });
      if (url.endsWith('/api/model-catalog')) return json([source]);
      if (url.endsWith('/api/account')) return json(account);
      if (url.endsWith('/api/model-sources')) return json([source]);
      if (url.endsWith('/api/devices') && init?.method === 'POST') {
        deviceRegistrations += 1;
        return json({ id: 'recovered-mobile-device', name: 'COD Mobile', platform: 'mobile', status: 'online', lastSeenAt: new Date().toISOString() }, 201);
      }
      if (url.endsWith('/api/devices/stale-device/heartbeat')) return json({ error: 'device_not_found' }, 404);
      if (url.endsWith('/api/devices')) return deviceServiceAvailable ? json([]) : json({ error: 'temporary' }, 503);
      if (url.endsWith('/api/tasks') && init?.method === 'POST') {
        createdTaskBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        return json({ id: 'recovered-chat-task', title: '恢复后发送', status: 'draft', deviceId: 'recovered-mobile-device', updatedAt: new Date().toISOString(), version: taskVersion }, 201);
      }
      if (url.endsWith('/api/tasks')) return json([]);
      if (/\/api\/tasks\/recovered-chat-task\/status$/.test(url)) {
        const body = JSON.parse(String(init?.body)) as { status: 'running' | 'complete' };
        taskVersion += 1;
        return json({ id: 'recovered-chat-task', title: '恢复后发送', status: body.status, deviceId: 'recovered-mobile-device', updatedAt: new Date().toISOString(), version: taskVersion, result: body.status === 'complete' ? '设备恢复后的回复' : null, error: null });
      }
      if (url.endsWith('/v1/chat/completions')) {
        chatBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return json({ choices: [{ message: { content: '设备恢复后的回复' } }], usage: { prompt_tokens: 4, completion_tokens: 6 }, cod_source: 'ai-kai' });
      }
      if (url.endsWith('/api/compute/requests') || url.endsWith('/api/products') || url.endsWith('/api/ledger')) return json([]);
      if (url.endsWith('/api/credit-packs')) return json(creditPacks);
      if (url.endsWith('/api/referrals')) return json({ inviteCode: 'RECOVER', referredUsers: 0, commissionRateBps: 0, pendingCommissionCents: 0, settledCommissionCents: 0 });
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);

    expect((await screen.findAllByText(/已登录；设备同步暂未加载/)).length).toBeGreaterThan(0);
    expect(window.localStorage.getItem('cod.device.id')).toBe('stale-device');
    deviceServiceAvailable = true;
    fireEvent.click(screen.getByTitle('刷新工作区'));
    await waitFor(() => expect(window.localStorage.getItem('cod.device.id')).toBe('recovered-mobile-device'));
    expect(deviceRegistrations).toBe(1);

    const composer = screen.getByPlaceholderText('问 COD 任何问题...');
    fireEvent.change(composer, { target: { value: '恢复后发送' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    expect(await screen.findByText('设备恢复后的回复')).toBeInTheDocument();
    expect(createdTaskBody).toMatchObject({ title: '恢复后发送', deviceId: 'recovered-mobile-device' });
    expect(chatBody).toMatchObject({ source: 'ai-kai', model: 'mobile-model', messages: [{ role: 'user', content: '恢复后发送' }] });
    expect(chatBody).not.toHaveProperty('task_id');
  });

  it('refreshes the mobile workspace and clears a conversation whose task was removed', async () => {
    window.localStorage.setItem('cod.session.token', 'valid-token');
    window.localStorage.setItem('cod.device.id', 'web-device');
    window.localStorage.setItem('cod.messages.task-stale', JSON.stringify([{ id: 'message-stale', role: 'assistant', content: '不应残留的旧回复', createdAt: new Date().toISOString() }]));
    const account = { userId: 'user', displayName: 'member', balanceCents: 0, currency: 'CNY', plan: 'developer', role: 'member', billingExempt: false };
    let taskReads = 0;
    let capabilityReads = 0;
    let modelSourceReads = 0;
    const demoSource = { id: 'demo', label: 'COD DEMO', status: 'demo', callable: true, paymentDirection: '测试钱包 → COD Demo', note: '', models: [{ id: 'coder-pro', label: 'KAI Coder Pro', contextWindow: 0, inputPricePerMillionCents: 260, outputPricePerMillionCents: 1040 }] };
    const liveSource = { id: 'ai-kai', label: 'AI.KAI.COM', status: 'live', callable: true, paymentDirection: '钱包 → ai.kai.com', note: '已连接', models: [{ id: 'glm-5.2', label: 'glm-5.2', contextWindow: 0, inputPricePerMillionCents: 824, outputPricePerMillionCents: 2884 }] };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/capabilities')) {
        capabilityReads += 1;
        return json(capabilityReads === 1 ? capabilities : { ...capabilities, ai: { ...capabilities.ai, mode: 'live' } });
      }
      if (url.endsWith('/api/model-catalog')) return json([]);
      if (url.endsWith('/api/account')) return json(account);
      if (url.endsWith('/api/model-sources')) {
        modelSourceReads += 1;
        return json(modelSourceReads === 1 ? [demoSource] : [liveSource]);
      }
      if (url.endsWith('/api/tasks')) {
        taskReads += 1;
        return json(taskReads === 1 ? [{ id: 'task-stale', title: '即将移除的任务', status: 'complete', deviceId: 'web-device', updatedAt: new Date().toISOString(), version: 1 }] : []);
      }
      if (url.endsWith('/api/devices/web-device/heartbeat') && init?.method === 'POST') return json({ id: 'web-device', name: 'COD Web', platform: 'web', status: 'online', lastSeenAt: new Date().toISOString() });
      if (url.endsWith('/api/devices')) return json([{ id: 'web-device', name: 'COD Web', platform: 'web', status: 'online', lastSeenAt: new Date().toISOString() }]);
      if (url.endsWith('/api/compute/requests')) return json([]);
      if (url.endsWith('/api/referrals')) return json({ inviteCode: 'TESTCODE', referredUsers: 0, commissionCents: 0 });
      if (url.endsWith('/api/products') || url.endsWith('/api/ledger')) return json([]);
      if (url.endsWith('/api/credit-packs')) return json(creditPacks);
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    expect(await screen.findByRole('heading', { name: '即将移除的任务' })).toBeInTheDocument();
    expect(await screen.findByText('不应残留的旧回复')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: '模型源' })).toHaveValue('demo');
    fireEvent.click(screen.getByTitle('刷新工作区'));
    expect(await screen.findByRole('heading', { name: '新建或选择任务' })).toBeInTheDocument();
    expect(screen.queryByText('不应残留的旧回复')).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: '模型源' })).toHaveValue('ai-kai');
    expect(screen.getByRole('combobox', { name: '模型' })).toHaveValue('glm-5.2');
    expect((await screen.findAllByText('工作区已刷新。')).length).toBeGreaterThan(0);
  });

  it('provides an explicit mobile sidebar close target and supports Escape', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(capabilities)));
    render(<App />);
    await screen.findByRole('heading', { name: '新对话' });

    fireEvent.click(screen.getByTitle('打开任务栏'));
    fireEvent.click(screen.getByRole('button', { name: '关闭任务栏' }));
    expect(screen.queryByRole('button', { name: '关闭任务栏' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByTitle('打开任务栏'));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('button', { name: '关闭任务栏' })).not.toBeInTheDocument();
  });

  it('dismisses Android DOM layers before releasing hardware back to the system', async () => {
    const availability: boolean[] = [];
    configureCodRuntime({
      hostPlatform: 'android',
      setNativeBackAvailable: async (available) => {
        availability.push(available);
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => json(capabilities)));
    render(<App />);
    await screen.findByRole('heading', { name: '新对话' });
    expect(screen.queryByTitle('查看项目文件')).not.toBeInTheDocument();
    expect(screen.getByText('发送', { selector: '.composer-footer > span' })).toBeInTheDocument();
    await waitFor(() => expect(availability.at(-1)).toBe(false));
    expect(dispatchCodNativeBack()).toBe(false);

    fireEvent.click(screen.getByTitle('模型库'));
    expect(await screen.findByRole('dialog', { name: '模型库' })).toBeInTheDocument();
    await waitFor(() => expect(availability.at(-1)).toBe(true));
    expect(dispatchCodNativeBack()).toBe(true);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '模型库' })).not.toBeInTheDocument());

    fireEvent.click(screen.getByTitle('打开任务栏'));
    expect(screen.getByRole('button', { name: '关闭任务栏' })).toBeInTheDocument();
    await waitFor(() => expect(availability.at(-1)).toBe(true));
    expect(dispatchCodNativeBack()).toBe(true);
    await waitFor(() => expect(screen.queryByRole('button', { name: '关闭任务栏' })).not.toBeInTheDocument());
    await waitFor(() => expect(availability.at(-1)).toBe(false));
    expect(dispatchCodNativeBack()).toBe(false);
  });

  it('shows public model prices before login', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/capabilities')) return json(capabilities);
      if (url.endsWith('/api/model-catalog')) return json([{ id: 'ai-kai', label: 'AI.KAI.COM', status: 'live', callable: true, paymentDirection: '钱包 → ai.kai.com', note: '已连接', models: [{ id: 'glm-5.2', label: 'GLM 5.2', contextWindow: 128000, inputPricePerMillionCents: 836, outputPricePerMillionCents: 2926 }] }]);
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    await screen.findByRole('heading', { name: '新对话' });
    fireEvent.click(screen.getByTitle('模型库'));
    const dialog = await screen.findByRole('dialog', { name: '模型库' });
    expect(within(dialog).getByText('GLM 5.2')).toBeInTheDocument();
    expect(within(dialog).getByText('¥ 8.36')).toBeInTheDocument();
    expect(within(dialog).getByText('¥ 29.26')).toBeInTheDocument();
    expect(within(dialog).getByText('可调用')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '登录后使用模型' })).toBeInTheDocument();
  });

  it('shows the H100 card-hour market and keeps financing as a compliant application flow', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/capabilities')) return json(capabilities);
      if (url.endsWith('/api/model-catalog')) return json([]);
      if (url.endsWith('/api/compute/offers')) return json([{ id: 'cod-h100-pcie-card-hour', title: 'H100 80GB 单卡算力', gpuModel: 'NVIDIA H100 PCIe 80GB', gpuMemoryGb: 80, gpuCount: 1, region: '国内合规机房', provider: 'COD 机房直供', priceCents: 1880, priceUnit: 'card-hour', minimumUnits: 10, delivery: '人工确认后开通', network: '按需报价', availability: 'ready', verified: true, tags: ['按卡时'] }]);
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    await screen.findByRole('heading', { name: '新对话' });
    fireEvent.click(screen.getByTitle('算力市场'));
    const dialog = await screen.findByRole('dialog', { name: 'COD 算力市场 · 租赁 / 上架 / 托管 / 分期' });
    expect(within(dialog).getByText('H100 80GB 单卡算力')).toBeInTheDocument();
    expect(within(dialog).getByText('¥18.80')).toBeInTheDocument();
    expect(within(dialog).getByText('/ 卡时起')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: /显卡分期/ }));
    expect(within(dialog).getByText(/COD 仅撮合申请，不自行授信或放款/)).toBeInTheDocument();
    expect(within(dialog).getByText(/具备相应资质的合作机构独立审核/)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '登录后提交需求' })).toBeInTheDocument();
  });

  it('submits a third-party GPU hosting request with explicit custody and settlement boundaries', async () => {
    window.localStorage.setItem('cod.session.token', 'hosting-test-token');
    const account = { userId: 'user', displayName: 'gpu-owner', balanceCents: 5000, currency: 'CNY', plan: 'developer', role: 'member', billingExempt: false };
    let submitted: Record<string, unknown> | null = null;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/capabilities')) return json(capabilities);
      if (url.endsWith('/api/model-catalog')) return json([]);
      if (url.endsWith('/api/account')) return json(account);
      if (url.endsWith('/api/model-sources')) return json([]);
      if (url.endsWith('/api/compute/offers')) return json([]);
      if (url.endsWith('/api/compute/requests') && init?.method === 'POST') {
        submitted = JSON.parse(String(init.body)) as Record<string, unknown>;
        return json({ ...submitted, id: 'hosting-request-1', email: 'owner@example.com', status: 'submitted', fulfillmentMode: 'third-party-manual-match', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, 201);
      }
      if (url.endsWith('/api/compute/requests')) return json([]);
      if (url.endsWith('/api/devices') && init?.method === 'POST') return json({ id: 'web-device', name: 'COD Web', platform: 'web', status: 'online', lastSeenAt: new Date().toISOString() }, 201);
      if (url.endsWith('/api/devices') || url.endsWith('/api/tasks')) return json([]);
      if (url.endsWith('/api/products') || url.endsWith('/api/ledger')) return json([]);
      if (url.endsWith('/api/credit-packs')) return json(creditPacks);
      if (url.endsWith('/api/referrals')) return json({ inviteCode: 'TESTCODE', referredUsers: 0, commissionRateBps: 0, pendingCommissionCents: 0, settledCommissionCents: 0 });
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    await screen.findByRole('heading', { name: '新建或选择任务' });
    fireEvent.click(screen.getByTitle('算力市场'));
    const dialog = await screen.findByRole('dialog', { name: 'COD 算力市场 · 租赁 / 上架 / 托管 / 分期' });
    fireEvent.click(within(dialog).getByRole('button', { name: /第三方托管/ }));

    expect(within(dialog).getByRole('button', { name: /第三方托管/ })).toHaveAttribute('aria-pressed', 'true');
    expect(within(dialog).getByRole('list', { name: '第三方托管办理流程' })).toBeInTheDocument();
    expect(within(dialog).getByText(/COD 仅提供需求撮合与过程记录/)).toBeInTheDocument();
    expect(within(dialog).getByText(/设备验收、机房合同、SLA、保险和费用结算/)).toBeInTheDocument();
    expect(within(dialog).getByLabelText('设备与可用条件')).toBeRequired();
    expect(within(dialog).getByLabelText('机房与服务要求')).toBeRequired();
    expect(within(dialog).getByLabelText('手机或微信')).toHaveAttribute('pattern', String.raw`(?:[0-9+\(\)\-\s]{6,40}|[A-Za-z][A-Za-z0-9_\-]{5,39})`);

    fireEvent.change(within(dialog).getByLabelText('公司或团队'), { target: { value: '星港算力' } });
    fireEvent.change(within(dialog).getByLabelText('联系人'), { target: { value: '林工' } });
    fireEvent.change(within(dialog).getByLabelText('手机或微信'), { target: { value: '13800138000' } });
    fireEvent.change(within(dialog).getByLabelText('所在城市'), { target: { value: '深圳' } });
    fireEvent.change(within(dialog).getByLabelText('GPU 型号'), { target: { value: 'NVIDIA RTX 4090 24GB' } });
    fireEvent.change(within(dialog).getByLabelText('卡数'), { target: { value: '8' } });
    fireEvent.change(within(dialog).getByLabelText('托管周期'), { target: { value: '6' } });
    fireEvent.change(within(dialog).getByLabelText('机架空间'), { target: { value: '4' } });
    expect(within(dialog).getByLabelText('设备与可用条件')).not.toBeRequired();
    fireEvent.change(within(dialog).getByLabelText('预计功耗'), { target: { value: '6.5' } });
    fireEvent.change(within(dialog).getByLabelText('所需带宽'), { target: { value: '1000' } });
    fireEvent.change(within(dialog).getByLabelText('设备与可用条件'), { target: { value: '4U 双电源服务器，月底可进场' } });
    fireEvent.change(within(dialog).getByLabelText('期望结算方式'), { target: { value: '算力收益分成（月结）' } });
    fireEvent.change(within(dialog).getByLabelText('机房与服务要求'), { target: { value: '需门禁记录、远程运维、设备保险及书面 SLA' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '提交托管需求' }));

    await waitFor(() => expect(submitted).not.toBeNull());
    expect(submitted).toMatchObject({
      kind: 'hosting', offerId: null, company: '星港算力', contactName: '林工', contactPhone: '13800138000', city: '深圳',
      gpuModel: 'NVIDIA RTX 4090 24GB', quantity: 8, durationHours: null, termMonths: null, requirements: '需门禁记录、远程运维、设备保险及书面 SLA',
      hostingPeriodMonths: 6, rackUnits: 4, powerKilowatts: 6.5, networkMbps: 1000, availabilityNotes: '4U 双电源服务器，月底可进场',
      settlementPreference: '算力收益分成（月结）', hostingRequirements: '需门禁记录、远程运维、设备保险及书面 SLA',
    });
    expect(within(dialog).getByText('第三方托管 · NVIDIA RTX 4090 24GB')).toBeInTheDocument();
    expect(within(dialog).getByText(/托管 6 个月/)).toBeInTheDocument();
    expect(await screen.findAllByText(/托管需求已记录，COD 将匹配第三方托管商/)).not.toHaveLength(0);
  });

  it('lets only administrators inspect, filter, copy, paginate, update, and return from compute requests', async () => {
    window.localStorage.setItem('cod.session.token', 'admin-token');
    window.localStorage.setItem('cod.device.id', 'web-device');
    const copyText = vi.fn(async () => undefined);
    configureCodRuntime({ hostPlatform: 'android', copyText });
    const account = { userId: 'admin', displayName: 'admin', balanceCents: 0, currency: 'CNY', plan: 'developer', role: 'admin', billingExempt: true };
    const requests = adminComputeRequests.map((request) => ({ ...request })) as ComputeRequest[];
    const adminSearches: Array<{ url: string; method: 'GET' | 'POST'; filters: { limit: number; cursor?: string; kind?: string; status?: string; q?: string } }> = [];
    let patchedStatus = '';
    const hostingPatchBodies: Array<{ status: ComputeRequest['status']; expectedStatus: ComputeRequest['status'] }> = [];
    let hostingPatchMode: 'success' | 'conflict' = 'success';
    let adminReadMode: 'normal' | 'error' | 'empty' = 'normal';
    let detailReadMode: 'normal' | 'error' = 'normal';
    let detailReads = 0;
    let holdInitialDetail = true;
    let resolveInitialDetail!: (response: Response) => void;
    const initialDetail = new Promise<Response>((resolve) => { resolveInitialDetail = resolve; });
    let rentalPatchRequested = false;
    let resolveRentalPatch!: (response: Response) => void;
    const rentalPatch = new Promise<Response>((resolve) => { resolveRentalPatch = resolve; });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const parsed = new URL(url, 'https://cod.test');
      const method = init?.method ?? 'GET';
      if (parsed.pathname === '/api/admin/compute/requests/compute-rental-1/status' && method === 'PATCH') {
        rentalPatchRequested = true;
        return rentalPatch;
      }
      if (parsed.pathname === '/api/admin/compute/requests/compute-hosting-1/status' && method === 'PATCH') {
        const body = JSON.parse(String(init?.body)) as { status: ComputeRequest['status']; expectedStatus: ComputeRequest['status'] };
        hostingPatchBodies.push(body);
        patchedStatus = body.status;
        const index = requests.findIndex((request) => request.id === 'compute-hosting-1');
        if (hostingPatchMode === 'conflict') {
          requests[index] = { ...requests[index], status: 'closed', updatedAt: '2026-08-11T10:00:00.000Z' };
          return json({ error: 'compute_request_status_conflict', message: '申请状态已变更' }, 409);
        }
        requests[index] = { ...requests[index], status: body.status, updatedAt: '2026-08-11T09:00:00.000Z' };
        return json(requests[index]);
      }
      if ((parsed.pathname === '/api/admin/compute/requests' && method === 'GET') || (parsed.pathname === '/api/admin/compute/requests/search' && method === 'POST')) {
        const filters = method === 'POST'
          ? JSON.parse(String(init?.body)) as { limit: number; cursor?: string; kind?: string; status?: string; q?: string }
          : {
              limit: Number(parsed.searchParams.get('limit') ?? 50),
              ...(parsed.searchParams.get('cursor') ? { cursor: parsed.searchParams.get('cursor') ?? undefined } : {}),
              ...(parsed.searchParams.get('kind') ? { kind: parsed.searchParams.get('kind') ?? undefined } : {}),
              ...(parsed.searchParams.get('status') ? { status: parsed.searchParams.get('status') ?? undefined } : {}),
            };
        adminSearches.push({ url, method: method as 'GET' | 'POST', filters });
        if (adminReadMode === 'error') return json({ error: 'admin_compute_unavailable', message: '算力申请服务暂不可用' }, 403);
        if (adminReadMode === 'empty') return json({ items: [], nextCursor: null });
        if (filters.cursor === 'page-2') return json({ items: [adminComputeRequestSummary(requests[2])], nextCursor: null });
        const kind = filters.kind;
        const status = filters.status;
        const query = (filters.q ?? '').toLocaleLowerCase('zh-CN');
        const hasFilter = Boolean(kind || status || query);
        const filtered = requests.filter((request) => (!kind || request.kind === kind) && (!status || request.status === status) && (!query || [request.id, request.email, request.company, request.contactName, request.contactPhone, request.city, request.gpuModel].some((value) => value.toLocaleLowerCase('zh-CN').includes(query))));
        return json(hasFilter ? { items: filtered.map(adminComputeRequestSummary), nextCursor: null } : { items: requests.slice(0, 2).map(adminComputeRequestSummary), nextCursor: 'page-2' });
      }
      if (method === 'GET' && parsed.pathname.startsWith('/api/admin/compute/requests/')) {
        detailReads += 1;
        const id = decodeURIComponent(parsed.pathname.slice('/api/admin/compute/requests/'.length));
        if (holdInitialDetail && id === 'compute-hosting-1') return initialDetail;
        if (detailReadMode === 'error' && id === 'compute-rental-1') return json({ error: 'compute_request_not_found', message: '申请详情暂不可用' }, 404);
        const request = requests.find((item) => item.id === id);
        return request ? json(request) : json({ error: 'compute_request_not_found' }, 404);
      }
      if (url.endsWith('/api/capabilities')) return json(capabilities);
      if (url.endsWith('/api/model-catalog') || url.endsWith('/api/model-sources')) return json([]);
      if (url.endsWith('/api/account')) return json(account);
      if (url.endsWith('/api/compute/offers') || url.endsWith('/api/compute/requests') || url.endsWith('/api/tasks') || url.endsWith('/api/products') || url.endsWith('/api/ledger')) return json([]);
      if (url.endsWith('/api/credit-packs')) return json(creditPacks);
      if (url.endsWith('/api/referrals')) return json({ inviteCode: 'ADMINCODE', referredUsers: 0, commissionRateBps: 0, pendingCommissionCents: 0, settledCommissionCents: 0 });
      if (url.endsWith('/api/devices/web-device/heartbeat') && method === 'POST') return json({ id: 'web-device', name: 'COD Mobile', platform: 'mobile', status: 'online', lastSeenAt: new Date().toISOString() });
      if (url.endsWith('/api/devices')) return json([{ id: 'web-device', name: 'COD Mobile', platform: 'mobile', status: 'online', lastSeenAt: new Date().toISOString() }]);
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    await screen.findByRole('heading', { name: '新建或选择任务' });

    fireEvent.click(screen.getByTitle('账户'));
    const accountDialog = await screen.findByRole('dialog', { name: '钱包与额度包' });
    fireEvent.click(within(accountDialog).getByRole('button', { name: /查看用户申请/ }));
    let adminDialog = await screen.findByRole('dialog', { name: '管理员 · 算力申请' });
    expect((await within(adminDialog).findAllByText('星港算力')).length).toBeGreaterThan(0);
    expect(within(adminDialog).getByText('正在读取申请详情…')).toBeInTheDocument();
    expect(within(adminDialog).queryByText('owner@example.com')).not.toBeInTheDocument();
    expect(within(adminDialog).queryByText('wx_gpu_owner')).not.toBeInTheDocument();
    expect(Object.keys(adminComputeRequestSummary(requests[0]))).not.toContain('email');
    expect(Object.keys(adminComputeRequestSummary(requests[0]))).not.toContain('contactPhone');
    holdInitialDetail = false;
    await act(async () => { resolveInitialDetail(json(requests[0])); await initialDetail; });
    expect(await within(adminDialog).findByText('4U 双电源服务器，月底可进场')).toBeInTheDocument();
    expect(within(adminDialog).getByText('门禁记录、远程运维、设备保险')).toBeInTheDocument();
    expect(within(adminDialog).getAllByText('owner@example.com').length).toBeGreaterThan(0);
    expect(adminSearches[0]).toMatchObject({ method: 'GET', filters: { limit: 50 } });
    expect(new URL(adminSearches[0].url, 'https://cod.test').pathname).toBe('/api/admin/compute/requests');
    expect(adminSearches[0].url).not.toMatch(/owner|wx_gpu|%40|q=/i);

    fireEvent.click(within(adminDialog).getByRole('button', { name: '复制申请邮箱' }));
    await waitFor(() => expect(copyText).toHaveBeenCalledWith('owner@example.com'));
    expect(within(adminDialog).getByRole('status')).toHaveTextContent('申请邮箱已复制');
    fireEvent.click(within(adminDialog).getByRole('button', { name: '复制手机或微信' }));
    await waitFor(() => expect(copyText).toHaveBeenCalledWith('wx_gpu_owner'));
    expect(within(adminDialog).getByRole('status')).toHaveTextContent('手机或微信已复制');

    fireEvent.click(within(adminDialog).getByRole('button', { name: '加载更多' }));
    expect(await within(adminDialog).findByText('远景研究')).toBeInTheDocument();
    expect(adminSearches.some((search) => search.method === 'GET' && search.filters.cursor === 'page-2')).toBe(true);

    fireEvent.click(within(adminDialog).getByRole('button', { name: /海岸模型/ }));
    await within(adminDialog).findByRole('article', { name: '海岸模型的算力申请详情' });
    fireEvent.change(within(adminDialog).getByLabelText('算力申请状态'), { target: { value: 'closed' } });
    fireEvent.click(within(adminDialog).getByRole('button', { name: '更新为已关闭' }));
    await waitFor(() => expect(rentalPatchRequested).toBe(true));
    fireEvent.click(within(adminDialog).getByRole('button', { name: /星港算力/ }));
    await within(adminDialog).findByRole('article', { name: '星港算力的算力申请详情' });
    requests[1] = { ...requests[1], status: 'closed', updatedAt: '2026-08-11T09:00:00.000Z' };
    await act(async () => { resolveRentalPatch(json(requests[1])); await rentalPatch; });
    expect(within(adminDialog).getByRole('article', { name: '星港算力的算力申请详情' })).toBeInTheDocument();
    expect(within(adminDialog).getByLabelText('算力申请状态')).toHaveValue('submitted');

    fireEvent.change(within(adminDialog).getByLabelText('算力申请状态'), { target: { value: 'contacting' } });
    fireEvent.click(within(adminDialog).getByRole('button', { name: '更新为联系中' }));
    await waitFor(() => expect(patchedStatus).toBe('contacting'));
    expect(hostingPatchBodies.at(-1)).toEqual({ status: 'contacting', expectedStatus: 'submitted' });

    fireEvent.change(within(adminDialog).getByLabelText('筛选业务类型'), { target: { value: 'hosting' } });
    fireEvent.change(within(adminDialog).getByLabelText('筛选申请状态'), { target: { value: 'contacting' } });
    await waitFor(() => expect(adminSearches.some((search) => search.method === 'GET' && search.filters.kind === 'hosting' && search.filters.status === 'contacting' && !search.filters.q)).toBe(true));
    fireEvent.change(within(adminDialog).getByLabelText('搜索算力申请'), { target: { value: '深圳' } });
    await waitFor(() => expect(adminSearches.some((search) => search.method === 'POST' && search.filters.kind === 'hosting' && search.filters.status === 'contacting' && search.filters.q === '深圳')).toBe(true));
    expect(adminSearches.every((search) => !search.url.includes('深圳') && !search.url.includes('owner@example.com'))).toBe(true);
    expect(await within(adminDialog).findByText('4U 双电源服务器，月底可进场')).toBeInTheDocument();

    fireEvent.change(within(adminDialog).getByLabelText('搜索算力申请'), { target: { value: '' } });
    fireEvent.change(within(adminDialog).getByLabelText('筛选业务类型'), { target: { value: 'all' } });
    fireEvent.change(within(adminDialog).getByLabelText('筛选申请状态'), { target: { value: 'all' } });
    await waitFor(() => expect(adminSearches.at(-1)).toMatchObject({ method: 'GET', filters: { limit: 50 } }));
    expect(await within(adminDialog).findByRole('article', { name: '星港算力的算力申请详情' })).toBeInTheDocument();
    const searchesBeforeConflict = adminSearches.length;
    const detailReadsBeforeConflict = detailReads;
    hostingPatchMode = 'conflict';
    fireEvent.change(within(adminDialog).getByLabelText('算力申请状态'), { target: { value: 'quoted' } });
    fireEvent.click(within(adminDialog).getByRole('button', { name: '更新为已报价' }));
    const conflictMessage = '申请状态已由其他管理员更新，请确认后重试。';
    await waitFor(() => expect(within(adminDialog).getAllByText(conflictMessage).length).toBeGreaterThan(0));
    expect(hostingPatchBodies.at(-1)).toEqual({ status: 'quoted', expectedStatus: 'contacting' });
    await waitFor(() => expect(adminSearches.length).toBeGreaterThan(searchesBeforeConflict));
    await waitFor(() => expect(detailReads).toBeGreaterThan(detailReadsBeforeConflict));
    expect(await within(adminDialog).findByText('该申请已结束')).toBeInTheDocument();
    expect(within(adminDialog).getAllByText('已关闭').length).toBeGreaterThan(0);

    fireEvent.click(within(adminDialog).getByRole('button', { name: '关闭' }));
    expect(await screen.findByRole('dialog', { name: '钱包与额度包' })).toBeInTheDocument();
    adminReadMode = 'error';
    fireEvent.click(screen.getByRole('button', { name: /查看用户申请/ }));
    adminDialog = await screen.findByRole('dialog', { name: '管理员 · 算力申请' });
    expect(await within(adminDialog).findByRole('alert')).toHaveTextContent('算力申请服务暂不可用');
    adminReadMode = 'empty';
    fireEvent.click(within(adminDialog).getByRole('button', { name: '重试' }));
    expect(await within(adminDialog).findByText('暂无用户算力申请')).toBeInTheDocument();
    adminReadMode = 'normal';
    fireEvent.click(within(adminDialog).getByRole('button', { name: '刷新' }));
    expect(await within(adminDialog).findByText('4U 双电源服务器，月底可进场')).toBeInTheDocument();
    detailReadMode = 'error';
    fireEvent.click(within(adminDialog).getByRole('button', { name: /海岸模型/ }));
    expect(within(adminDialog).getByText('正在读取申请详情…')).toBeInTheDocument();
    expect(await within(adminDialog).findByRole('alert')).toHaveTextContent('申请详情暂不可用');
    detailReadMode = 'normal';
    fireEvent.click(within(adminDialog).getByRole('button', { name: '重试详情' }));
    expect(await within(adminDialog).findByRole('article', { name: '海岸模型的算力申请详情' })).toBeInTheDocument();
    act(() => { expect(dispatchCodNativeBack()).toBe(true); });
    expect(await screen.findByRole('dialog', { name: '钱包与额度包' })).toBeInTheDocument();
  });

  it('does not expose the compute-request administration entry or API to members', async () => {
    window.localStorage.setItem('cod.session.token', 'member-token');
    window.localStorage.setItem('cod.device.id', 'web-device');
    const account = { userId: 'member', displayName: 'member', balanceCents: 0, currency: 'CNY', plan: 'developer', role: 'member', billingExempt: false };
    const adminReads: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/admin/compute/requests')) { adminReads.push(url); return json({ error: 'admin_required' }, 403); }
      if (url.endsWith('/api/capabilities')) return json(capabilities);
      if (url.endsWith('/api/model-catalog') || url.endsWith('/api/model-sources')) return json([]);
      if (url.endsWith('/api/account')) return json(account);
      if (url.endsWith('/api/compute/offers') || url.endsWith('/api/compute/requests') || url.endsWith('/api/tasks') || url.endsWith('/api/products') || url.endsWith('/api/ledger')) return json([]);
      if (url.endsWith('/api/credit-packs')) return json(creditPacks);
      if (url.endsWith('/api/referrals')) return json({ inviteCode: 'MEMBERCODE', referredUsers: 0, commissionRateBps: 0, pendingCommissionCents: 0, settledCommissionCents: 0 });
      if (url.endsWith('/api/devices/web-device/heartbeat') && init?.method === 'POST') return json({ id: 'web-device', name: 'COD Web', platform: 'web', status: 'online', lastSeenAt: new Date().toISOString() });
      if (url.endsWith('/api/devices')) return json([{ id: 'web-device', name: 'COD Web', platform: 'web', status: 'online', lastSeenAt: new Date().toISOString() }]);
      throw new Error(`Unexpected request: ${url}`);
    }));
    render(<App />);
    await screen.findByRole('heading', { name: '新建或选择任务' });
    fireEvent.click(screen.getByTitle('账户'));
    const accountDialog = await screen.findByRole('dialog', { name: '钱包与额度包' });
    expect(within(accountDialog).queryByRole('button', { name: /查看用户申请/ })).not.toBeInTheDocument();
    expect(adminReads).toEqual([]);
  });

  it('evicts administrator PII on a synchronized 401 or demotion without logging out on a transient 5xx', async () => {
    vi.useFakeTimers();
    window.localStorage.setItem('cod.session.token', 'admin-token');
    window.localStorage.setItem('cod.device.id', 'web-device');
    let accountRole: 'admin' | 'member' = 'admin';
    let transientTaskFailure = false;
    let revoked = false;
    const adminAccount = () => ({ userId: 'admin', displayName: 'admin', balanceCents: 0, currency: 'CNY', plan: 'developer', role: accountRole, billingExempt: accountRole === 'admin' });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const parsed = new URL(url, 'https://cod.test');
      if (parsed.pathname === '/api/auth/login' && init?.method === 'POST') return json({ token: 'renewed-token' });
      if (revoked && ['/api/tasks', '/api/devices', '/api/account', '/api/credit-packs'].includes(parsed.pathname)) return json({ error: 'unauthorized' }, 401);
      if (transientTaskFailure && parsed.pathname === '/api/tasks') return json({ error: 'temporary' }, 503);
      if (parsed.pathname === '/api/admin/compute/requests' && (init?.method ?? 'GET') === 'GET') return json({ items: [adminComputeRequestSummary(adminComputeRequests[0] as ComputeRequest)], nextCursor: null });
      if (parsed.pathname === '/api/admin/compute/requests/compute-hosting-1') return json({ ...adminComputeRequests[0] });
      if (url.endsWith('/api/capabilities')) return json(capabilities);
      if (url.endsWith('/api/model-catalog') || url.endsWith('/api/model-sources')) return json([]);
      if (url.endsWith('/api/account')) return json(adminAccount());
      if (url.endsWith('/api/compute/offers') || url.endsWith('/api/compute/requests') || url.endsWith('/api/tasks') || url.endsWith('/api/products') || url.endsWith('/api/ledger')) return json([]);
      if (url.endsWith('/api/credit-packs')) return json(creditPacks);
      if (url.endsWith('/api/referrals')) return json({ inviteCode: 'ADMINCODE', referredUsers: 0, commissionRateBps: 0, pendingCommissionCents: 0, settledCommissionCents: 0 });
      if (url.endsWith('/api/devices/web-device/heartbeat') && init?.method === 'POST') return json({ id: 'web-device', name: 'COD Web', platform: 'web', status: 'online', lastSeenAt: new Date().toISOString() });
      if (url.endsWith('/api/devices')) return json([{ id: 'web-device', name: 'COD Web', platform: 'web', status: 'online', lastSeenAt: new Date().toISOString() }]);
      throw new Error(`Unexpected request: ${url}`);
    }));
    const flushPromises = async () => { await act(async () => { for (let index = 0; index < 12; index += 1) await Promise.resolve(); }); };
    const advanceSync = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(15_500); }); await flushPromises(); };

    render(<App />);
    await flushPromises();
    expect(screen.getByRole('heading', { name: '新建或选择任务' })).toBeInTheDocument();
    fireEvent.click(screen.getByTitle('账户'));
    fireEvent.click(within(screen.getByRole('dialog', { name: '钱包与额度包' })).getByRole('button', { name: /查看用户申请/ }));
    await flushPromises();
    expect(screen.getAllByText('owner@example.com').length).toBeGreaterThan(0);
    expect(window.localStorage.getItem('cod.session.token')).toBe('admin-token');

    transientTaskFailure = true;
    await advanceSync();
    expect(screen.getByRole('dialog', { name: '管理员 · 算力申请' })).toBeInTheDocument();
    expect(screen.getAllByText('owner@example.com').length).toBeGreaterThan(0);
    expect(window.localStorage.getItem('cod.session.token')).toBe('admin-token');

    transientTaskFailure = false; accountRole = 'member';
    await advanceSync();
    expect(screen.getByRole('dialog', { name: '钱包与额度包' })).toBeInTheDocument();
    expect(screen.queryByText('owner@example.com')).not.toBeInTheDocument();
    expect(screen.queryByText('wx_gpu_owner')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /查看用户申请/ })).not.toBeInTheDocument();
    expect(window.localStorage.getItem('cod.session.token')).toBe('admin-token');

    accountRole = 'admin';
    await advanceSync();
    fireEvent.click(screen.getByRole('button', { name: /查看用户申请/ }));
    await flushPromises();
    expect(screen.getAllByText('owner@example.com').length).toBeGreaterThan(0);

    revoked = true;
    await advanceSync();
    expect(screen.queryByRole('dialog', { name: '管理员 · 算力申请' })).not.toBeInTheDocument();
    expect(screen.queryByText('owner@example.com')).not.toBeInTheDocument();
    expect(screen.queryByText('wx_gpu_owner')).not.toBeInTheDocument();
    expect(window.localStorage.getItem('cod.session.token')).toBeNull();
    expect(screen.getByRole('heading', { name: '新对话' })).toBeInTheDocument();
    expect(screen.getAllByText('登录已失效，请重新登录。').length).toBeGreaterThan(0);

    revoked = false;
    fireEvent.click(screen.getByTitle('登录'));
    const loginDialog = screen.getByRole('dialog', { name: '登录 COD' });
    fireEvent.change(within(loginDialog).getByLabelText('邮箱'), { target: { value: 'admin@kai.com' } });
    fireEvent.change(within(loginDialog).getByLabelText('密码'), { target: { value: 'Password123' } });
    fireEvent.click(within(loginDialog).getByRole('button', { name: '登录' }));
    await flushPromises();
    expect(screen.getByRole('heading', { name: '新建或选择任务' })).toBeInTheDocument();
    expect(screen.queryByText('登录已失效，请重新登录。')).not.toBeInTheDocument();
  });

  it('discards a stale pagination response after an administrator changes filters', async () => {
    window.localStorage.setItem('cod.session.token', 'admin-token');
    window.localStorage.setItem('cod.device.id', 'web-device');
    const account = { userId: 'admin', displayName: 'admin', balanceCents: 0, currency: 'CNY', plan: 'developer', role: 'admin', billingExempt: true };
    let resolveStalePage!: (response: Response) => void;
    let stalePageRequested = false;
    const stalePage = new Promise<Response>((resolve) => { resolveStalePage = resolve; });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const parsed = new URL(url, 'https://cod.test');
      if (parsed.pathname === '/api/admin/compute/requests' && (init?.method ?? 'GET') === 'GET') {
        const cursor = parsed.searchParams.get('cursor');
        const status = parsed.searchParams.get('status');
        if (cursor === 'old-page') { stalePageRequested = true; return stalePage; }
        if (status === 'contacting') return json({ items: [adminComputeRequestSummary(adminComputeRequests[1] as ComputeRequest)], nextCursor: null });
        return json({ items: [adminComputeRequestSummary(adminComputeRequests[0] as ComputeRequest)], nextCursor: 'old-page' });
      }
      if (init?.method !== 'PATCH' && parsed.pathname.startsWith('/api/admin/compute/requests/')) {
        const id = decodeURIComponent(parsed.pathname.slice('/api/admin/compute/requests/'.length));
        const request = adminComputeRequests.find((item) => item.id === id);
        return request ? json({ ...request }) : json({ error: 'compute_request_not_found' }, 404);
      }
      if (url.endsWith('/api/capabilities')) return json(capabilities);
      if (url.endsWith('/api/model-catalog') || url.endsWith('/api/model-sources')) return json([]);
      if (url.endsWith('/api/account')) return json(account);
      if (url.endsWith('/api/compute/offers') || url.endsWith('/api/compute/requests') || url.endsWith('/api/tasks') || url.endsWith('/api/products') || url.endsWith('/api/ledger')) return json([]);
      if (url.endsWith('/api/credit-packs')) return json(creditPacks);
      if (url.endsWith('/api/referrals')) return json({ inviteCode: 'ADMINCODE', referredUsers: 0, commissionRateBps: 0, pendingCommissionCents: 0, settledCommissionCents: 0 });
      if (url.endsWith('/api/devices/web-device/heartbeat') && init?.method === 'POST') return json({ id: 'web-device', name: 'COD Web', platform: 'web', status: 'online', lastSeenAt: new Date().toISOString() });
      if (url.endsWith('/api/devices')) return json([{ id: 'web-device', name: 'COD Web', platform: 'web', status: 'online', lastSeenAt: new Date().toISOString() }]);
      throw new Error(`Unexpected request: ${url}`);
    }));
    render(<App />);
    await screen.findByRole('heading', { name: '新建或选择任务' });
    fireEvent.click(screen.getByTitle('账户'));
    fireEvent.click(within(await screen.findByRole('dialog', { name: '钱包与额度包' })).getByRole('button', { name: /查看用户申请/ }));
    const adminDialog = await screen.findByRole('dialog', { name: '管理员 · 算力申请' });
    expect((await within(adminDialog).findAllByText('星港算力')).length).toBeGreaterThan(0);
    fireEvent.click(within(adminDialog).getByRole('button', { name: '加载更多' }));
    await waitFor(() => expect(stalePageRequested).toBe(true));
    fireEvent.change(within(adminDialog).getByLabelText('筛选申请状态'), { target: { value: 'contacting' } });
    expect((await within(adminDialog).findAllByText('海岸模型')).length).toBeGreaterThan(0);
    await act(async () => { resolveStalePage(json({ items: [adminComputeRequestSummary(adminComputeRequests[2] as ComputeRequest)], nextCursor: null })); await stalePage; });
    expect(within(adminDialog).getAllByText('海岸模型').length).toBeGreaterThan(0);
    expect(within(adminDialog).queryByText('远景研究')).not.toBeInTheDocument();
  });

  it('persists the KAI semantic color mode', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(capabilities)));
    render(<App />);
    await screen.findByRole('heading', { name: '新对话' });
    const toggle = screen.getByRole('button', { name: '切换到深色模式' });
    fireEvent.click(toggle);
    await waitFor(() => expect(document.documentElement).toHaveAttribute('data-color-mode', 'dark'));
    expect(window.localStorage.getItem('kai.color-mode.v1')).toBe('dark');
    expect(screen.getByRole('button', { name: '切换到浅色模式' })).toBeInTheDocument();
  });

  it('can hide and restore the changes, files, and terminal inspector', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(capabilities)));
    render(<App />);
    await screen.findByRole('heading', { name: '新对话' });
    expect(screen.getByRole('button', { name: '改动' })).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: '隐藏右侧面板' })[0]);
    expect(screen.queryByRole('button', { name: '改动' })).not.toBeInTheDocument();
    expect(window.localStorage.getItem('cod.inspector.open')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: '显示右侧面板' }));
    expect(screen.getByRole('button', { name: '改动' })).toBeInTheDocument();
  });

  it('shows project files independently while a Git snapshot is still pending', async () => {
    const selectedRoot = '/Users/developer/projects/zanzibar-integration';
    window.codDesktop = {
      platform: 'win32',
      controlPlaneUrl: 'https://cod.example',
      selectProject: vi.fn(async () => selectedRoot),
      listFiles: vi.fn(async () => [{ path: 'package.json', name: 'package.json', kind: 'file' as const, depth: 0 }]),
      gitDiff: vi.fn(() => new Promise<string>(() => undefined)),
      readTextFile: vi.fn(async () => ''),
      runCommand: vi.fn(async (_root, command) => ({ command, output: '', exitCode: 0 })),
      getGooseAcpUrl: vi.fn(async () => null),
      stopGoose: vi.fn(async () => undefined),
    };
    vi.stubGlobal('fetch', vi.fn(async () => json(capabilities)));
    render(<App />);
    await screen.findByRole('heading', { name: '新对话' });

    const projectSwitcher = screen.getByRole('button', { name: /当前项目/ });
    fireEvent.click(projectSwitcher);

    expect(await within(projectSwitcher).findByText('zanzibar-integration')).toBeInTheDocument();
    expect(window.localStorage.getItem('cod.project.root')).toBe(selectedRoot);
    expect(screen.getByText('Ctrl / ⌘ Enter 发送', { selector: '.composer-footer > span' })).toBeInTheDocument();
    expect(screen.getByText('正在读取 Git 改动…')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '文件' }));
    expect(await screen.findByRole('button', { name: 'package.json' })).toBeInTheDocument();
    expect(document.querySelector('.inspector-body.files')).toBeInTheDocument();
  });

  it('shows an unknown change state instead of claiming zero changes after a Git timeout', async () => {
    const selectedRoot = '/Users/developer/projects/slow-git-project';
    window.codDesktop = {
      platform: 'darwin',
      controlPlaneUrl: 'https://cod.example',
      selectProject: vi.fn(async () => selectedRoot),
      listFiles: vi.fn(async () => [{ path: 'README.md', name: 'README.md', kind: 'file' as const, depth: 0 }]),
      gitDiff: vi.fn(async () => 'Git 状态读取超时；项目文件仍可正常使用。可检查仓库元数据权限后重试。'),
      readTextFile: vi.fn(async () => ''),
      runCommand: vi.fn(async (_root, command) => ({ command, output: '', exitCode: 0 })),
      getGooseAcpUrl: vi.fn(async () => null),
      stopGoose: vi.fn(async () => undefined),
    };
    vi.stubGlobal('fetch', vi.fn(async () => json(capabilities)));
    render(<App />);
    await screen.findByRole('heading', { name: '新对话' });
    fireEvent.click(screen.getByRole('button', { name: /当前项目/ }));

    expect(await screen.findByText('改动未知')).toBeInTheDocument();
    expect(screen.queryByText('0 个改动')).not.toBeInTheDocument();
    expect(screen.getByText('Git 改动读取失败，可点击刷新重试。')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '文件' }));
    expect(await screen.findByRole('button', { name: 'README.md' })).toBeInTheDocument();
  });

  it('binds a desktop Agent gateway request to the currently approved project root', async () => {
    const selectedRoot = '/Users/developer/projects/approved-project';
    const taskId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const getGooseAcpUrl = vi.fn(async () => null);
    window.localStorage.setItem('cod.project.root', selectedRoot);
    window.localStorage.setItem('cod.session.token', 'test-token');
    window.codDesktop = {
      platform: 'darwin',
      controlPlaneUrl: 'https://cod.example',
      selectProject: vi.fn(async () => selectedRoot),
      listFiles: vi.fn(async () => [{ path: 'package.json', name: 'package.json', kind: 'file' as const, depth: 0 }]),
      gitDiff: vi.fn(async () => ''),
      readTextFile: vi.fn(async () => ''),
      runCommand: vi.fn(async (_root, command) => ({ command, output: '', exitCode: 0 })),
      getGooseAcpUrl,
      stopGoose: vi.fn(async () => undefined),
    };
    let taskVersion = 1;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/capabilities')) return json({ ...capabilities, ai: { mode: 'live', streaming: false, streamingMode: 'buffered-sse' } });
      if (url.endsWith('/api/model-catalog')) return json([]);
      if (url.endsWith('/api/compute/offers')) return json([]);
      if (url.endsWith('/api/account')) return json({ userId: 'user', displayName: 'developer', balanceCents: 5000, currency: 'CNY', plan: 'developer' });
      if (url.endsWith('/api/model-sources')) return json([{ id: 'ai-kai', label: 'AI.KAI.COM', status: 'live', callable: true, paymentDirection: '钱包 → ai.kai.com', note: '已连接', models: [{ id: 'model-a', label: '模型 A', contextWindow: 128000, inputPricePerMillionCents: 100, outputPricePerMillionCents: 200 }] }]);
      if (url.endsWith('/api/devices') && init?.method === 'POST') return json({ id: 'desktop-device', name: 'COD Desktop', platform: 'macos', status: 'online', lastSeenAt: new Date().toISOString() }, 201);
      if (url.endsWith('/api/devices')) return json([]);
      if (url.endsWith('/api/tasks') && init?.method === 'POST') return json({ id: taskId, title: 'Agent 根目录绑定', status: 'draft', deviceId: 'desktop-device', updatedAt: new Date().toISOString(), version: taskVersion }, 201);
      if (url.endsWith('/api/tasks')) return json([]);
      if (url.endsWith(`/api/tasks/${taskId}/status`)) {
        const body = JSON.parse(String(init?.body)) as { status: string };
        taskVersion += 1;
        return json({ id: taskId, title: 'Agent 根目录绑定', status: body.status, deviceId: 'desktop-device', updatedAt: new Date().toISOString(), version: taskVersion });
      }
      if (url.endsWith('/api/credit-packs')) return json(creditPacks);
      if (url.endsWith('/api/products') || url.endsWith('/api/ledger')) return json([]);
      throw new Error(`Unexpected request: ${url}`);
    }));

    render(<App />);
    expect(await screen.findByRole('heading', { name: '新建或选择任务' })).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText('让 COD 修改、检查或解释这个项目...'), { target: { value: '检查当前项目' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    await waitFor(() => expect(getGooseAcpUrl).toHaveBeenCalledTimes(1));
    expect(getGooseAcpUrl).toHaveBeenCalledWith(expect.objectContaining({
      token: 'test-token',
      sourceId: 'ai-kai',
      modelId: 'model-a',
      taskId,
      root: selectedRoot,
    }));
    await waitFor(() => expect(document.querySelector('.composer .send .spin')).toBeNull());
  });

  it('clears a restored project root when its file list can no longer be read', async () => {
    const restoredRoot = '/Users/developer/projects/deleted-project';
    window.localStorage.setItem('cod.project.root', restoredRoot);
    window.codDesktop = {
      platform: 'darwin',
      controlPlaneUrl: 'https://cod.example',
      selectProject: vi.fn(async () => null),
      listFiles: vi.fn(async () => { throw new Error('ENOENT'); }),
      gitDiff: vi.fn(() => new Promise<string>(() => undefined)),
      readTextFile: vi.fn(async () => ''),
      runCommand: vi.fn(async (_root, command) => ({ command, output: '', exitCode: 0 })),
      getGooseAcpUrl: vi.fn(async () => null),
      stopGoose: vi.fn(async () => undefined),
    };
    vi.stubGlobal('fetch', vi.fn(async () => json(capabilities)));
    render(<App />);

    const projectSwitcher = screen.getByRole('button', { name: /当前项目/ });
    expect(await within(projectSwitcher).findByText('未连接本机项目')).toBeInTheDocument();
    expect(window.localStorage.getItem('cod.project.root')).toBeNull();
    expect(screen.getAllByText(/上次使用的项目无法打开，已清除失效项目/).length).toBeGreaterThan(0);
  });

  it('rolls a failed project selection back to the last validated project', async () => {
    const previousRoot = '/Users/developer/projects/working-project';
    const rejectedRoot = '/Users/developer/projects/missing-project';
    window.localStorage.setItem('cod.project.root', previousRoot);
    window.codDesktop = {
      platform: 'darwin',
      controlPlaneUrl: 'https://cod.example',
      selectProject: vi.fn(async () => rejectedRoot),
      listFiles: vi.fn(async (root) => {
        if(root===previousRoot)return [{ path: 'working.ts', name: 'working.ts', kind: 'file' as const, depth: 0 }];
        throw new Error('permission denied');
      }),
      gitDiff: vi.fn(async () => ''),
      readTextFile: vi.fn(async () => ''),
      runCommand: vi.fn(async (_root, command) => ({ command, output: '', exitCode: 0 })),
      getGooseAcpUrl: vi.fn(async () => null),
      stopGoose: vi.fn(async () => undefined),
    };
    vi.stubGlobal('fetch', vi.fn(async () => json(capabilities)));
    render(<App />);

    const projectSwitcher = screen.getByRole('button', { name: /当前项目/ });
    expect(await within(projectSwitcher).findByText('working-project')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '文件' }));
    expect(await screen.findByRole('button', { name: 'working.ts' })).toBeInTheDocument();
    fireEvent.click(projectSwitcher);

    await waitFor(() => expect(window.localStorage.getItem('cod.project.root')).toBe(previousRoot));
    expect(await within(projectSwitcher).findByText('working-project')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'working.ts' })).toBeInTheDocument();
    expect(screen.getAllByText(/项目打开失败，已恢复上一个可用项目/).length).toBeGreaterThan(0);
  });

  it('ignores stale file and diff results after a newer project selection', async () => {
    const slowRoot='/Users/developer/projects/slow-project';
    const fastRoot='/Users/developer/projects/fast-project';
    let resolveSlowFiles:(files:WorkspaceFile[])=>void=()=>undefined;
    const slowFiles=new Promise<WorkspaceFile[]>((resolve)=>{resolveSlowFiles=resolve;});
    window.codDesktop = {
      platform: 'darwin',
      controlPlaneUrl: 'https://cod.example',
      selectProject: vi.fn().mockResolvedValueOnce(slowRoot).mockResolvedValueOnce(fastRoot),
      listFiles: vi.fn(async (root) => root===slowRoot?slowFiles:[{ path: 'fast.ts', name: 'fast.ts', kind: 'file' as const, depth: 0 }]),
      gitDiff: vi.fn(async (root) => `diff --git a/${root===slowRoot?'slow.ts':'fast.ts'} b/file`),
      readTextFile: vi.fn(async () => ''),
      runCommand: vi.fn(async (_root, command) => ({ command, output: '', exitCode: 0 })),
      getGooseAcpUrl: vi.fn(async () => null),
      stopGoose: vi.fn(async () => undefined),
    };
    vi.stubGlobal('fetch', vi.fn(async () => json(capabilities)));
    render(<App />);
    await screen.findByRole('heading', { name: '新对话' });

    const projectSwitcher=screen.getByRole('button',{name:/当前项目/});
    fireEvent.click(projectSwitcher);
    expect(await within(projectSwitcher).findByText('slow-project')).toBeInTheDocument();
    fireEvent.click(projectSwitcher);
    expect(await within(projectSwitcher).findByText('fast-project')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button',{name:'文件'}));
    expect(await screen.findByRole('button',{name:'fast.ts'})).toBeInTheDocument();

    resolveSlowFiles([{path:'slow.ts',name:'slow.ts',kind:'file',depth:0}]);
    await waitFor(()=>expect(window.localStorage.getItem('cod.project.root')).toBe(fastRoot));
    expect(within(projectSwitcher).getByText('fast-project')).toBeInTheDocument();
    expect(screen.queryByRole('button',{name:'slow.ts'})).not.toBeInTheDocument();
  });

  it('ignores a slow file read after switching to another project', async () => {
    const firstRoot='/Users/developer/projects/first-project';
    const secondRoot='/Users/developer/projects/second-project';
    let resolveRead:(content:string)=>void=()=>undefined;
    const slowRead=new Promise<string>((resolve)=>{resolveRead=resolve;});
    window.localStorage.setItem('cod.project.root',firstRoot);
    window.codDesktop={
      platform:'darwin',controlPlaneUrl:'https://cod.example',selectProject:vi.fn(async()=>secondRoot),
      listFiles:vi.fn(async(root)=>root===firstRoot?[{path:'first.ts',name:'first.ts',kind:'file' as const,depth:0}]:[{path:'second.ts',name:'second.ts',kind:'file' as const,depth:0}]),
      gitDiff:vi.fn(async()=>''),readTextFile:vi.fn(async()=>slowRead),
      runCommand:vi.fn(async(_root,command)=>({command,output:'',exitCode:0})),getGooseAcpUrl:vi.fn(async()=>null),stopGoose:vi.fn(async()=>undefined),
    };
    vi.stubGlobal('fetch',vi.fn(async()=>json(capabilities)));
    render(<App/>);

    const projectSwitcher=screen.getByRole('button',{name:/当前项目/});
    expect(await within(projectSwitcher).findByText('first-project')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button',{name:'文件'}));
    fireEvent.click(await screen.findByRole('button',{name:'first.ts'}));
    expect(window.codDesktop.readTextFile).toHaveBeenCalledWith(firstRoot,'first.ts');
    fireEvent.click(projectSwitcher);
    expect(await within(projectSwitcher).findByText('second-project')).toBeInTheDocument();
    expect(await screen.findByRole('button',{name:'second.ts'})).toBeInTheDocument();

    await act(async()=>{resolveRead('stale first-project contents');await slowRead;});
    expect(window.localStorage.getItem('cod.project.root')).toBe(secondRoot);
    expect(within(projectSwitcher).getByText('second-project')).toBeInTheDocument();
    expect(screen.queryByText('stale first-project contents')).not.toBeInTheDocument();
    expect(screen.queryByText('first.ts',{selector:'.file-preview > strong'})).not.toBeInTheDocument();
  });

  it('keeps the latest file selection when an earlier read finishes last', async () => {
    const root='/Users/developer/projects/file-race';
    let resolveSlowRead:(content:string)=>void=()=>undefined;
    const slowRead=new Promise<string>((resolve)=>{resolveSlowRead=resolve;});
    window.localStorage.setItem('cod.project.root',root);
    window.codDesktop={
      platform:'darwin',controlPlaneUrl:'https://cod.example',selectProject:vi.fn(async()=>null),
      listFiles:vi.fn(async()=>[
        {path:'slow.ts',name:'slow.ts',kind:'file' as const,depth:0},
        {path:'fast.ts',name:'fast.ts',kind:'file' as const,depth:0},
      ]),
      gitDiff:vi.fn(async()=>''),
      readTextFile:vi.fn(async(_root,path)=>path==='slow.ts'?slowRead:'fast file contents'),
      runCommand:vi.fn(async(_root,command)=>({command,output:'',exitCode:0})),getGooseAcpUrl:vi.fn(async()=>null),stopGoose:vi.fn(async()=>undefined),
    };
    vi.stubGlobal('fetch',vi.fn(async()=>json(capabilities)));
    render(<App/>);

    expect(await within(screen.getByRole('button',{name:/当前项目/})).findByText('file-race')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button',{name:'文件'}));
    fireEvent.click(await screen.findByRole('button',{name:'slow.ts'}));
    fireEvent.click(screen.getByRole('button',{name:'fast.ts'}));
    expect(await screen.findByText('fast file contents')).toBeInTheDocument();
    expect(screen.getByText('fast.ts',{selector:'.file-preview > strong'})).toBeInTheDocument();
    expect(document.querySelector('.inspector-body.files')).toBeInTheDocument();

    await act(async()=>{resolveSlowRead('stale slow file contents');await slowRead;});
    expect(screen.getByText('fast.ts',{selector:'.file-preview > strong'})).toBeInTheDocument();
    expect(screen.getByText('fast file contents')).toBeInTheDocument();
    expect(screen.queryByText('stale slow file contents')).not.toBeInTheDocument();
  });

  it('does not let a post-chat project refresh overwrite a newer selection', async () => {
    const firstRoot='/Users/developer/projects/chat-project';
    const secondRoot='/Users/developer/projects/new-project';
    let firstRootReads=0;
    let resolveRefreshFiles:(files:WorkspaceFile[])=>void=()=>undefined;
    let markRefreshStarted:()=>void=()=>undefined;
    const refreshFiles=new Promise<WorkspaceFile[]>((resolve)=>{resolveRefreshFiles=resolve;});
    const refreshStarted=new Promise<void>((resolve)=>{markRefreshStarted=resolve;});
    window.localStorage.setItem('cod.project.root',firstRoot);
    window.localStorage.setItem('cod.session.token','test-token');
    window.codDesktop={
      platform:'darwin',controlPlaneUrl:'https://cod.example',selectProject:vi.fn(async()=>secondRoot),
      listFiles:vi.fn(async(root)=>{
        if(root===secondRoot)return [{path:'new.ts',name:'new.ts',kind:'file' as const,depth:0}];
        firstRootReads+=1;
        if(firstRootReads===1)return [{path:'chat.ts',name:'chat.ts',kind:'file' as const,depth:0}];
        markRefreshStarted();return refreshFiles;
      }),
      gitDiff:vi.fn(async(root)=>root===secondRoot?'diff --git a/new.ts b/new.ts':'diff --git a/chat.ts b/chat.ts'),
      readTextFile:vi.fn(async()=>''),runCommand:vi.fn(async(_root,command)=>({command,output:'',exitCode:0})),getGooseAcpUrl:vi.fn(async()=>null),stopGoose:vi.fn(async()=>undefined),
    };
    let taskVersion=1;
    const fetchMock=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
      const url=String(input);
      if(url.endsWith('/api/capabilities'))return json(capabilities);
      if(url.endsWith('/api/model-catalog'))return json([]);
      if(url.endsWith('/api/account'))return json({userId:'user',displayName:'developer',balanceCents:5000,currency:'CNY',plan:'developer'});
      if(url.endsWith('/api/model-sources'))return json([{id:'ai-kai',label:'AI.KAI.COM',status:'live',callable:true,paymentDirection:'钱包 → ai.kai.com',note:'已连接',models:[{id:'model-a',label:'模型 A',contextWindow:128000,inputPricePerMillionCents:100,outputPricePerMillionCents:200}]}]);
      if(url.endsWith('/api/devices')&&init?.method==='POST')return json({id:'desktop-device',name:'COD Desktop',platform:'macos',status:'online',lastSeenAt:new Date().toISOString()},201);
      if(url.endsWith('/api/devices'))return json([]);
      if(url.endsWith('/api/tasks')&&init?.method==='POST')return json({id:'task-race',title:'刷新竞态',status:'draft',deviceId:'desktop-device',updatedAt:new Date().toISOString(),version:taskVersion},201);
      if(url.endsWith('/api/tasks'))return json([]);
      if(/\/api\/tasks\/task-race\/status$/.test(url)){const body=JSON.parse(String(init?.body)) as {status:'running'|'complete'};taskVersion+=1;return json({id:'task-race',title:'刷新竞态',status:body.status,deviceId:'desktop-device',updatedAt:new Date().toISOString(),version:taskVersion,result:body.status==='complete'?'已完成':null,error:null});}
      if(url.endsWith('/v1/chat/completions'))return json({choices:[{message:{content:'刷新竞态回复'}}],usage:{prompt_tokens:4,completion_tokens:6},cod_source:'ai-kai'});
      if(url.endsWith('/api/credit-packs'))return json(creditPacks);
      if(url.endsWith('/api/products')||url.endsWith('/api/ledger'))return json([]);
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch',fetchMock);
    const {container}=render(<App/>);

    const projectSwitcher=screen.getByRole('button',{name:/当前项目/});
    expect(await within(projectSwitcher).findByText('chat-project')).toBeInTheDocument();
    expect(await screen.findByRole('heading',{name:'新建或选择任务'})).toBeInTheDocument();
    fireEvent.click(screen.getByTitle('普通对话'));
    fireEvent.change(screen.getByPlaceholderText('问 COD 任何问题...'),{target:{value:'测试刷新竞态'}});
    fireEvent.click(screen.getByRole('button',{name:'发送'}));
    await refreshStarted;

    fireEvent.click(projectSwitcher);
    expect(await within(projectSwitcher).findByText('new-project')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button',{name:'文件'}));
    expect(await screen.findByRole('button',{name:'new.ts'})).toBeInTheDocument();
    await act(async()=>{resolveRefreshFiles([{path:'stale.ts',name:'stale.ts',kind:'file',depth:0}]);await refreshFiles;});
    await waitFor(()=>expect(container.querySelector('.composer .send .spin')).toBeNull());

    expect(window.localStorage.getItem('cod.project.root')).toBe(secondRoot);
    expect(within(projectSwitcher).getByText('new-project')).toBeInTheDocument();
    expect(screen.getByRole('button',{name:'new.ts'})).toBeInTheDocument();
    expect(screen.queryByRole('button',{name:'stale.ts'})).not.toBeInTheDocument();
  });

  it('automatically continues the saved first message after login', async () => {
    let taskVersion = 1;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/capabilities')) return json(capabilities);
      if (url.endsWith('/api/auth/login')) return json({ token: 'test-token' });
      if (url.endsWith('/api/account')) return json({ userId: 'user', displayName: 'developer', balanceCents: 6839, currency: 'CNY', plan: 'developer' });
      if (url.endsWith('/api/model-sources')) return json([{ id: 'ai-kai', label: 'AI.KAI.COM', status: 'live', callable: true, paymentDirection: '钱包 → ai.kai.com', note: '已连接', models: [{ id: 'glm-5.2', label: 'glm-5.2', contextWindow: 0, inputPricePerMillionCents: 836, outputPricePerMillionCents: 2926 }] }]);
      if (url.endsWith('/api/devices') && init?.method === 'POST') return json({ id: 'web-device', name: 'COD Web', platform: 'web', status: 'online', lastSeenAt: new Date().toISOString() }, 201);
      if (url.endsWith('/api/devices')) return json([]);
      if (url.endsWith('/api/tasks') && init?.method === 'POST') return json({ id: 'task-new', title: '登录后自动发送', status: 'draft', deviceId: 'web-device', updatedAt: new Date().toISOString(), version: taskVersion }, 201);
      if (url.endsWith('/api/tasks')) return json([]);
      if (url.endsWith('/api/credit-packs')) return json(creditPacks);
      if (/\/api\/tasks\/task-new\/status$/.test(url)) {
        const body = JSON.parse(String(init?.body)) as { status: 'running' | 'complete' };
        taskVersion += 1;
        return json({ id: 'task-new', title: '登录后自动发送', status: body.status, deviceId: 'web-device', updatedAt: new Date().toISOString(), version: taskVersion, result: body.status === 'complete' ? '自动回复' : null, error: null });
      }
      if (url.endsWith('/v1/chat/completions')) return json({ choices: [{ message: { content: '自动回复' } }], usage: { prompt_tokens: 12, completion_tokens: 34 }, cod_source: 'ai-kai', cod_charge_cents: 1 });
      if (url.endsWith('/api/products') || url.endsWith('/api/ledger')) return json([]);
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    await screen.findByRole('heading', { name: '新对话' });
    const composer = screen.getByPlaceholderText('问 COD 任何问题...');
    fireEvent.change(composer, { target: { value: '登录后自动发送' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    const dialog = await screen.findByRole('dialog', { name: '登录后继续' });
    fireEvent.change(within(dialog).getByLabelText('邮箱'), { target: { value: 'developer@kai.com' } });
    fireEvent.change(within(dialog).getByLabelText('密码'), { target: { value: 'Password123' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '登录并继续' }));
    expect(await screen.findByText('自动回复')).toBeInTheDocument();
    expect(screen.getByText(/输入 12 \/ 输出 34 Token/)).toBeInTheDocument();
    expect(screen.queryByText('¥0.01')).not.toBeInTheDocument();
    const chatCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/v1/chat/completions'));
    expect(JSON.parse(String(chatCall?.[1]?.body)).messages).toEqual([{ role: 'user', content: '登录后自动发送' }]);
  });

  it('terminates a running task, aborts the model request, and renders the synchronized cancelled state',async()=>{
    let taskVersion=1;let chatSignal:AbortSignal|undefined;let markChatStarted:()=>void=()=>undefined;const chatStarted=new Promise<void>((resolve)=>{markChatStarted=resolve;});
    const fetchMock=vi.fn(async(input:RequestInfo|URL,init?:RequestInit):Promise<Response>=>{const url=String(input);if(url.endsWith('/api/capabilities'))return json(capabilities);if(url.endsWith('/api/auth/login'))return json({token:'test-token'});if(url.endsWith('/api/account'))return json({userId:'user',displayName:'developer',balanceCents:5000,currency:'CNY',plan:'developer'});if(url.endsWith('/api/model-sources'))return json([{id:'ai-kai',label:'AI.KAI.COM',status:'live',callable:true,paymentDirection:'钱包 → ai.kai.com',note:'已连接',models:[{id:'slow-model',label:'慢模型',contextWindow:128000,inputPricePerMillionCents:100,outputPricePerMillionCents:200}]}]);if(url.endsWith('/api/devices/web-device/heartbeat'))return json({id:'web-device',name:'COD Web',platform:'web',status:'online',lastSeenAt:new Date().toISOString()});if(url.endsWith('/api/devices')&&init?.method==='POST')return json({id:'web-device',name:'COD Web',platform:'web',status:'online',lastSeenAt:new Date().toISOString()},201);if(url.endsWith('/api/devices'))return json([]);if(url.endsWith('/api/tasks'))return json([]);if(url.endsWith('/api/tasks')&&init?.method==='POST')throw new Error('unreachable');if(/\/api\/tasks\/task-cancel\/status$/.test(url)){taskVersion+=1;return json({id:'task-cancel',title:'终止测试',status:'running',deviceId:'web-device',updatedAt:new Date().toISOString(),version:taskVersion,result:null,error:null});}if(/\/api\/tasks\/task-cancel\/cancel$/.test(url)){taskVersion+=1;return json({task:{id:'task-cancel',title:'终止测试',status:'cancelled',deviceId:'web-device',updatedAt:new Date().toISOString(),version:taskVersion,result:null,error:null},cancelledRequests:1});}if(url.endsWith('/v1/chat/completions')){chatSignal=init?.signal??undefined;markChatStarted();return new Promise<Response>((_resolve,reject)=>chatSignal?.addEventListener('abort',()=>reject(chatSignal?.reason),{once:true}));}if(url.endsWith('/api/credit-packs'))return json(creditPacks);if(url.endsWith('/api/products')||url.endsWith('/api/ledger'))return json([]);throw new Error(`Unexpected request: ${url}`);});
    vi.stubGlobal('fetch',fetchMock);window.localStorage.setItem('cod.device.id','web-device');window.localStorage.setItem('cod.session.token','test-token');
    const originalList=fetchMock.getMockImplementation();fetchMock.mockImplementation(async(input,init)=>{const url=String(input);if(url.endsWith('/api/tasks')&&init?.method!=='POST')return json([{id:'task-cancel',title:'终止测试',status:'draft',deviceId:'web-device',updatedAt:new Date().toISOString(),version:taskVersion,result:null,error:null}]);return originalList!(input,init);});
    render(<App/>);expect(await screen.findByRole('heading',{name:'终止测试',level:1})).toBeInTheDocument();fireEvent.click(screen.getByTitle('普通对话'));const composer=screen.getByPlaceholderText('问 COD 任何问题...');fireEvent.change(composer,{target:{value:'持续生成直到我终止'}});fireEvent.click(screen.getByRole('button',{name:'发送'}));await chatStarted;const cancelButton=await screen.findByRole('button',{name:'停止回复'});fireEvent.click(cancelButton);
    expect(await screen.findByText(/已停止这次回复/)).toBeInTheDocument();expect(screen.getByText(/未结算的模型请求会释放预占额度/)).toBeInTheDocument();expect(chatSignal?.aborted).toBe(true);const chatCall=fetchMock.mock.calls.find(([url])=>String(url).endsWith('/v1/chat/completions'));expect(JSON.parse(String(chatCall?.[1]?.body))).not.toHaveProperty('task_id');expect(fetchMock.mock.calls.some(([url])=>String(url).endsWith('/api/tasks/task-cancel/cancel'))).toBe(true);
  });

  it('runs the same prompt through two selected models and renders a comparison', async()=>{
    let taskVersion=1;const fetchMock=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{const url=String(input);if(url.endsWith('/api/capabilities'))return json(capabilities);if(url.endsWith('/api/auth/login'))return json({token:'test-token'});if(url.endsWith('/api/account'))return json({userId:'user',displayName:'developer',balanceCents:5000,currency:'CNY',plan:'developer'});if(url.endsWith('/api/model-sources'))return json([{id:'ai-kai',label:'AI.KAI.COM',status:'live',callable:true,paymentDirection:'钱包 → ai.kai.com',note:'已连接',models:[{id:'model-a',label:'模型 A',contextWindow:128000,inputPricePerMillionCents:100,outputPricePerMillionCents:200},{id:'model-b',label:'模型 B',contextWindow:128000,inputPricePerMillionCents:150,outputPricePerMillionCents:300}]}]);if(url.endsWith('/api/devices')&&init?.method==='POST')return json({id:'web-device',name:'COD Web',platform:'web',status:'online',lastSeenAt:new Date().toISOString()},201);if(url.endsWith('/api/devices'))return json([]);if(url.endsWith('/api/tasks')&&init?.method==='POST')return json({id:'compare-task',title:'同一个问题',status:'draft',deviceId:'web-device',updatedAt:new Date().toISOString(),version:taskVersion},201);if(url.endsWith('/api/tasks'))return json([]);if(/\/api\/tasks\/compare-task\/status$/.test(url)){const body=JSON.parse(String(init?.body)) as {status:'running'|'complete'};taskVersion+=1;return json({id:'compare-task',title:'同一个问题',status:body.status,deviceId:'web-device',updatedAt:new Date().toISOString(),version:taskVersion,result:body.status==='complete'?'比较完成':null,error:null});}if(url.endsWith('/v1/chat/completions')){const body=JSON.parse(String(init?.body)) as {model:string;messages:Array<{content:string}>};return json({choices:[{message:{content:`${body.model} 的回答`}}],usage:{prompt_tokens:10,completion_tokens:20},cod_source:'ai-kai'});}if(url.endsWith('/api/credit-packs'))return json(creditPacks);if(url.endsWith('/api/products')||url.endsWith('/api/ledger'))return json([]);throw new Error(`Unexpected request: ${url}`);});
    vi.stubGlobal('fetch',fetchMock);render(<App/>);await screen.findByRole('heading',{name:'新对话'});fireEvent.click(screen.getByTitle('登录'));const dialog=await screen.findByRole('dialog',{name:'登录 COD'});fireEvent.change(within(dialog).getByLabelText('邮箱'),{target:{value:'developer@kai.com'}});fireEvent.change(within(dialog).getByLabelText('密码'),{target:{value:'Password123'}});fireEvent.click(within(dialog).getByRole('button',{name:'登录'}));await screen.findByRole('heading',{name:'新建或选择任务'});fireEvent.click(screen.getByTitle('普通对话'));const compareToggle=screen.getByRole('button',{name:/多模型对比/});expect(compareToggle).toHaveAttribute('aria-pressed','false');fireEvent.click(compareToggle);expect(screen.getByText('本次发送将产生 2 次独立计费请求')).toBeInTheDocument();const composer=screen.getByPlaceholderText('输入一个问题，同时询问 2 个模型...');fireEvent.change(composer,{target:{value:'同一个问题'}});fireEvent.click(screen.getByRole('button',{name:'发送'}));expect(await screen.findByText('model-a 的回答')).toBeInTheDocument();expect(screen.getByText('model-b 的回答')).toBeInTheDocument();expect(screen.getByText('同一问题 · 2 个模型')).toBeInTheDocument();const calls=fetchMock.mock.calls.filter(([url])=>String(url).endsWith('/v1/chat/completions'));expect(calls).toHaveLength(2);expect(calls.map(([,init])=>(JSON.parse(String(init?.body)) as {model:string}).model).sort()).toEqual(['model-a','model-b']);fireEvent.click(screen.getByRole('button',{name:'选用此回答'}));expect(screen.getByRole('combobox',{name:'模型'})).toHaveValue('model-b');expect(screen.getAllByText('已将 AI.KAI.COM · 模型 B 设为默认模型并用于后续上下文。').length).toBeGreaterThan(0);
  });

  it('loads synchronized tasks, filters them, and does not fake Web terminal output', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/capabilities')) return json(capabilities);
      if (url.endsWith('/api/auth/login')) return json({ token: 'test-token' });
      if (url.endsWith('/api/account')) return json({ userId: 'user', displayName: 'developer', balanceCents: 6839, currency: 'CNY', plan: 'developer' });
      if (url.endsWith('/api/model-sources')) return json([
        { id: 'ai-kai', label: 'AI.KAI.COM', status: 'live', callable: true, paymentDirection: '钱包 → ai.kai.com', note: '已连接', models: [{ id: 'glm-5.2', label: 'glm-5.2', contextWindow: 0, inputPricePerMillionCents: 836, outputPricePerMillionCents: 2926 }] },
        { id: 'chase-kai', label: 'CHASE.KAI.COM', status: 'catalog', callable: false, paymentDirection: '钱包 → chase.kai.com', note: '仅目录', models: [{ id: 'gpt-5.6-sol', label: 'gpt-5.6-sol', contextWindow: 0, inputPricePerMillionCents: 52500, outputPricePerMillionCents: 420000 }] },
      ]);
      if (url.endsWith('/api/devices') && init?.method === 'POST') return json({ id: 'web-device', name: 'COD Web', platform: 'web', status: 'online', lastSeenAt: new Date().toISOString() }, 201);
      if (url.endsWith('/api/devices')) return json([{ id: 'desktop-device', name: 'COD Desktop', platform: 'linux', status: 'online', lastSeenAt: new Date().toISOString() }]);
      if (url.endsWith('/api/tasks')) return json([{ id: 'task-1', title: '真实同步任务', status: 'draft', deviceId: 'desktop-device', updatedAt: new Date().toISOString(), version: 1 }]);
      if (url.endsWith('/api/credit-packs')) return json(creditPacks);
      if (url.endsWith('/api/products') || url.endsWith('/api/ledger')) return json([]);
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    await screen.findByRole('heading', { name: '新对话' });
    fireEvent.click(screen.getByTitle('登录'));
    const loginDialog = await screen.findByRole('dialog', { name: '登录 COD' });
    fireEvent.change(within(loginDialog).getByLabelText('邮箱'), { target: { value: 'developer@kai.com' } });
    fireEvent.change(within(loginDialog).getByLabelText('密码'), { target: { value: 'Password123' } });
    fireEvent.click(within(loginDialog).getByRole('button', { name: '登录' }));
    expect(await screen.findByRole('heading', { name: '新建或选择任务', level: 1 })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /真实同步任务/ })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: '模型源' })).toHaveValue('ai-kai');
    expect(screen.getByRole('combobox', { name: '模型' })).toHaveValue('glm-5.2');
    fireEvent.change(screen.getByRole('combobox', { name: '模型源' }), { target: { value: 'chase-kai' } });
    expect(screen.getByRole('combobox', { name: '模型' })).toHaveValue('gpt-5.6-sol');
    expect(screen.getAllByText('仅目录')).not.toHaveLength(0);
    fireEvent.change(screen.getByPlaceholderText('问 COD 任何问题...'), { target: { value: '不能从目录源调用' } });
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled();

    fireEvent.change(screen.getByLabelText('搜索任务'), { target: { value: '不存在' } });
    expect(screen.getByText('没有匹配的任务')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('搜索任务'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /真实同步任务/ }));
    expect(await screen.findByRole('heading', { name: '真实同步任务', level: 1 })).toBeInTheDocument();
    fireEvent.click(screen.getByTitle('普通对话'));
    expect(await screen.findByRole('heading', { name: '新建或选择任务', level: 1 })).toBeInTheDocument();
    expect(screen.getAllByText('已开始当前设备的新对话；原任务仍保留在任务列表中。').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: '终端' }));
    expect(screen.getByText('Web 端不会执行或伪造终端结果。请使用 COD Desktop。')).toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/auth/login', expect.anything()));
  });

  it('refreshes wallet and credit balances when another signed-in client changes them', async () => {
    let accountReads = 0; let creditReads = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/capabilities')) return json(capabilities);
      if (url.endsWith('/api/model-catalog')) return json([]);
      if (url.endsWith('/api/account')) { accountReads += 1; return json({ userId: 'user', displayName: 'developer', balanceCents: accountReads === 1 ? 688 : 0, currency: 'CNY', plan: 'developer' }); }
      if (url.endsWith('/api/model-sources')) return json([{ id: 'demo', label: 'Demo', status: 'demo', callable: true, paymentDirection: 'demo', note: '', models: [{ id: 'coder-pro', label: 'Coder Pro', contextWindow: 0, inputPricePerMillionCents: 0, outputPricePerMillionCents: 0 }] }]);
      if (url.endsWith('/api/credit-packs')) { creditReads += 1; return json({ packs: [], summary: { availableCents: creditReads === 1 ? 0 : 201, grants: [] } }); }
      if (url.endsWith('/api/devices') && init?.method === 'POST') return json({ id: 'web-device', name: 'COD Web', platform: 'web', status: 'online', lastSeenAt: new Date().toISOString() }, 201);
      if (url.endsWith('/api/devices/web-device/heartbeat')) return json({ id: 'web-device', name: 'COD Web', platform: 'web', status: 'online', lastSeenAt: new Date().toISOString() });
      if (url.endsWith('/api/devices') || url.endsWith('/api/tasks') || url.endsWith('/api/products') || url.endsWith('/api/ledger')) return json([]);
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock); window.localStorage.setItem('cod.session.token', 'test-token');
    render(<App />);
    expect(await screen.findByText('¥ 6.88')).toBeInTheDocument();
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)); });
    fireEvent(document, new Event('visibilitychange'));
    await waitFor(() => expect(accountReads).toBeGreaterThanOrEqual(2));
    expect(await screen.findByText('¥ 2.01')).toBeInTheDocument();
  });
});
