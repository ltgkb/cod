import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { createClientId, sendChat } from './api';

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
});

afterEach(() => {
  cleanup();
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

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

describe('COD workspace', () => {
  it('creates client IDs when randomUUID is unavailable on HTTP origins', () => {
    vi.stubGlobal('crypto', { getRandomValues: (bytes: Uint8Array) => { bytes.fill(7); return bytes; } });
    expect(createClientId()).toBe('07'.repeat(16));
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
  });

  it('rejects empty model responses instead of rendering a blank reply', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ choices: [{ message: { content: '   ' } }], usage: { prompt_tokens: 12, completion_tokens: 34 }, cod_source: 'ai-kai', cod_charge_cents: 4 })));
    await expect(sendChat('token', 'ai-kai', 'glm-5.2', [{ role: 'user', content: '问题' }])).rejects.toMatchObject({ code: 'empty_model_response' });
  });

  it('binds model requests to a task and aborts without retrying when cancelled',async()=>{
    let requestSignal:AbortSignal|undefined;let requestBody:Record<string,unknown>|null=null;let started:()=>void=()=>undefined;const requestStarted=new Promise<void>((resolve)=>{started=resolve;});
    const fetchMock=vi.fn(async(_input:RequestInfo|URL,init?:RequestInit):Promise<Response>=>{requestSignal=init?.signal??undefined;requestBody=JSON.parse(String(init?.body)) as Record<string,unknown>;started();return new Promise<Response>((_resolve,reject)=>requestSignal?.addEventListener('abort',()=>reject(requestSignal?.reason),{once:true}));});
    vi.stubGlobal('fetch',fetchMock);const controller=new AbortController();const pending=sendChat('token','ai-kai','model-1',[{role:'user',content:'长任务'}],{taskId:'task-1',signal:controller.signal});await requestStarted;controller.abort(new DOMException('Task cancelled','AbortError'));await expect(pending).rejects.toMatchObject({name:'AbortError'});expect(requestSignal?.aborted).toBe(true);expect(requestBody).toMatchObject({task_id:'task-1'});expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('shows the workspace first and opens login when the first message is sent', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(capabilities)));
    render(<App />);
    expect(await screen.findByRole('heading', { name: '新对话' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    const composer = screen.getByPlaceholderText('问 COD 任何问题...');
    fireEvent.change(composer, { target: { value: '这是我的第一条消息' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    const dialog = await screen.findByRole('dialog', { name: '登录后继续' });
    expect(within(dialog).getByLabelText('密码')).toBeRequired();
    expect(composer).toHaveValue('这是我的第一条消息');
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
    const dialog = await screen.findByRole('dialog', { name: 'COD 算力市场 · 机房直供 / 卡时 / 分期' });
    expect(within(dialog).getByText('H100 80GB 单卡算力')).toBeInTheDocument();
    expect(within(dialog).getByText('¥18.80')).toBeInTheDocument();
    expect(within(dialog).getByText('/ 卡时起')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: /显卡分期/ }));
    expect(within(dialog).getByText(/COD 仅撮合申请，不自行授信或放款/)).toBeInTheDocument();
    expect(within(dialog).getByText(/具备相应资质的合作机构独立审核/)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '登录后提交需求' })).toBeInTheDocument();
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
    const fetchMock=vi.fn(async(input:RequestInfo|URL,init?:RequestInit):Promise<Response>=>{const url=String(input);if(url.endsWith('/api/capabilities'))return json(capabilities);if(url.endsWith('/api/auth/login'))return json({token:'test-token'});if(url.endsWith('/api/account'))return json({userId:'user',displayName:'developer',balanceCents:5000,currency:'CNY',plan:'developer'});if(url.endsWith('/api/model-sources'))return json([{id:'ai-kai',label:'AI.KAI.COM',status:'live',callable:true,paymentDirection:'钱包 → ai.kai.com',note:'已连接',models:[{id:'slow-model',label:'慢模型',contextWindow:128000,inputPricePerMillionCents:100,outputPricePerMillionCents:200}]}]);if(url.endsWith('/api/devices')&&init?.method==='POST')return json({id:'web-device',name:'COD Web',platform:'web',status:'online',lastSeenAt:new Date().toISOString()},201);if(url.endsWith('/api/devices'))return json([]);if(url.endsWith('/api/tasks'))return json([]);if(url.endsWith('/api/tasks')&&init?.method==='POST')throw new Error('unreachable');if(/\/api\/tasks\/task-cancel\/status$/.test(url)){taskVersion+=1;return json({id:'task-cancel',title:'终止测试',status:'running',deviceId:'web-device',updatedAt:new Date().toISOString(),version:taskVersion,result:null,error:null});}if(/\/api\/tasks\/task-cancel\/cancel$/.test(url)){taskVersion+=1;return json({task:{id:'task-cancel',title:'终止测试',status:'cancelled',deviceId:'web-device',updatedAt:new Date().toISOString(),version:taskVersion,result:null,error:null},cancelledRequests:1});}if(url.endsWith('/v1/chat/completions')){chatSignal=init?.signal??undefined;markChatStarted();return new Promise<Response>((_resolve,reject)=>chatSignal?.addEventListener('abort',()=>reject(chatSignal?.reason),{once:true}));}if(url.endsWith('/api/credit-packs'))return json(creditPacks);if(url.endsWith('/api/products')||url.endsWith('/api/ledger'))return json([]);throw new Error(`Unexpected request: ${url}`);});
    vi.stubGlobal('fetch',fetchMock);window.localStorage.setItem('cod.device.id','web-device');window.localStorage.setItem('cod.session.token','test-token');
    const originalList=fetchMock.getMockImplementation();fetchMock.mockImplementation(async(input,init)=>{const url=String(input);if(url.endsWith('/api/tasks')&&init?.method!=='POST')return json([{id:'task-cancel',title:'终止测试',status:'draft',deviceId:'web-device',updatedAt:new Date().toISOString(),version:taskVersion,result:null,error:null}]);return originalList!(input,init);});
    render(<App/>);expect(await screen.findByRole('heading',{name:'终止测试',level:1})).toBeInTheDocument();fireEvent.click(screen.getByTitle('普通对话'));const composer=screen.getByPlaceholderText('问 COD 任何问题...');fireEvent.change(composer,{target:{value:'持续生成直到我终止'}});fireEvent.click(screen.getByRole('button',{name:'发送'}));await chatStarted;const cancelButton=await screen.findByRole('button',{name:'终止任务'});fireEvent.click(cancelButton);
    expect(await screen.findByRole('button',{name:'重新执行'})).toBeInTheDocument();expect(screen.getByText(/未结算请求不扣费，已完成或结算中的请求按实际用量计费/)).toBeInTheDocument();expect(screen.queryByText(/本次终止不会产生模型用量扣费/)).not.toBeInTheDocument();expect(chatSignal?.aborted).toBe(true);const chatCall=fetchMock.mock.calls.find(([url])=>String(url).endsWith('/v1/chat/completions'));expect(JSON.parse(String(chatCall?.[1]?.body))).toMatchObject({task_id:'task-cancel'});expect(fetchMock.mock.calls.some(([url])=>String(url).endsWith('/api/tasks/task-cancel/cancel'))).toBe(true);
  });

  it('runs the same prompt through two selected models and renders a comparison', async()=>{
    let taskVersion=1;const fetchMock=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{const url=String(input);if(url.endsWith('/api/capabilities'))return json(capabilities);if(url.endsWith('/api/auth/login'))return json({token:'test-token'});if(url.endsWith('/api/account'))return json({userId:'user',displayName:'developer',balanceCents:5000,currency:'CNY',plan:'developer'});if(url.endsWith('/api/model-sources'))return json([{id:'ai-kai',label:'AI.KAI.COM',status:'live',callable:true,paymentDirection:'钱包 → ai.kai.com',note:'已连接',models:[{id:'model-a',label:'模型 A',contextWindow:128000,inputPricePerMillionCents:100,outputPricePerMillionCents:200},{id:'model-b',label:'模型 B',contextWindow:128000,inputPricePerMillionCents:150,outputPricePerMillionCents:300}]}]);if(url.endsWith('/api/devices')&&init?.method==='POST')return json({id:'web-device',name:'COD Web',platform:'web',status:'online',lastSeenAt:new Date().toISOString()},201);if(url.endsWith('/api/devices'))return json([]);if(url.endsWith('/api/tasks')&&init?.method==='POST')return json({id:'compare-task',title:'同一个问题',status:'draft',deviceId:'web-device',updatedAt:new Date().toISOString(),version:taskVersion},201);if(url.endsWith('/api/tasks'))return json([]);if(/\/api\/tasks\/compare-task\/status$/.test(url)){const body=JSON.parse(String(init?.body)) as {status:'running'|'complete'};taskVersion+=1;return json({id:'compare-task',title:'同一个问题',status:body.status,deviceId:'web-device',updatedAt:new Date().toISOString(),version:taskVersion,result:body.status==='complete'?'比较完成':null,error:null});}if(url.endsWith('/v1/chat/completions')){const body=JSON.parse(String(init?.body)) as {model:string;messages:Array<{content:string}>};return json({choices:[{message:{content:`${body.model} 的回答`}}],usage:{prompt_tokens:10,completion_tokens:20},cod_source:'ai-kai'});}if(url.endsWith('/api/credit-packs'))return json(creditPacks);if(url.endsWith('/api/products')||url.endsWith('/api/ledger'))return json([]);throw new Error(`Unexpected request: ${url}`);});
    vi.stubGlobal('fetch',fetchMock);render(<App/>);await screen.findByRole('heading',{name:'新对话'});fireEvent.click(screen.getByTitle('登录'));const dialog=await screen.findByRole('dialog',{name:'登录 COD'});fireEvent.change(within(dialog).getByLabelText('邮箱'),{target:{value:'developer@kai.com'}});fireEvent.change(within(dialog).getByLabelText('密码'),{target:{value:'Password123'}});fireEvent.click(within(dialog).getByRole('button',{name:'登录'}));await screen.findByRole('heading',{name:'新建或选择任务'});fireEvent.click(screen.getByTitle('普通对话'));fireEvent.click(screen.getByRole('button',{name:/多模型对比/}));expect(screen.getByText('本次发送将产生 2 次独立计费请求')).toBeInTheDocument();const composer=screen.getByPlaceholderText('输入一个问题，同时询问 2 个模型...');fireEvent.change(composer,{target:{value:'同一个问题'}});fireEvent.click(screen.getByRole('button',{name:'发送'}));expect(await screen.findByText('model-a 的回答')).toBeInTheDocument();expect(screen.getByText('model-b 的回答')).toBeInTheDocument();expect(screen.getByText('同一问题 · 2 个模型')).toBeInTheDocument();const calls=fetchMock.mock.calls.filter(([url])=>String(url).endsWith('/v1/chat/completions'));expect(calls).toHaveLength(2);expect(calls.map(([,init])=>(JSON.parse(String(init?.body)) as {model:string}).model).sort()).toEqual(['model-a','model-b']);fireEvent.click(screen.getByRole('button',{name:'选用此回答'}));expect(screen.getByRole('combobox',{name:'模型'})).toHaveValue('model-b');expect(screen.getAllByText('已将 AI.KAI.COM · 模型 B 设为默认模型并用于后续上下文。').length).toBeGreaterThan(0);
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
    expect(await screen.findByRole('heading', { name: '真实同步任务', level: 1 })).toBeInTheDocument();
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
    expect(screen.getByRole('button', { name: /真实同步任务/ })).toBeInTheDocument();

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
    document.dispatchEvent(new Event('visibilitychange'));
    expect(await screen.findByText('¥ 2.01')).toBeInTheDocument();
  });
});
