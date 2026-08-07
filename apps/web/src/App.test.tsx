import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { createClientId, sendChat } from './api';

afterEach(() => {
  cleanup();
  try { window.localStorage?.clear(); } catch { /* Node can expose localStorage without a backing file. */ }
  vi.unstubAllGlobals();
});

const capabilities = {
  authentication: { mode: 'pilot', accessCodeRequired: true },
  ai: { mode: 'demo', streaming: false },
  knowledge: { mode: 'demo' },
  payments: { topupEnabled: false, orderApi: true, mode: 'unavailable' as const },
  synchronization: { transport: 'polling', taskStatusVersioning: true },
  remote: { feishu: 'unavailable' as const, wecom: 'unavailable' as const },
};

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
      return json({ choices: [{ message: { content: '继续回答' } }], cod_source: 'ai-kai' });
    });
    vi.stubGlobal('fetch', fetchMock);
    await sendChat('token', 'ai-kai', 'model-1', [{ role: 'user', content: '第一问' }, { role: 'assistant', content: '第一答' }, { role: 'user', content: '继续' }]);
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { messages: Array<{ role: string; content: string }>; max_tokens: number };
    expect(body.messages).toEqual([{ role: 'user', content: '第一问' }, { role: 'assistant', content: '第一答' }, { role: 'user', content: '继续' }]);
    expect(body).toMatchObject({ max_tokens: 20_000 });
  });

  it('rejects empty model responses instead of rendering a blank reply', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ choices: [{ message: { content: '   ' } }], cod_source: 'ai-kai', cod_charge_cents: 4 })));
    await expect(sendChat('token', 'ai-kai', 'glm-5.2', [{ role: 'user', content: '问题' }])).rejects.toMatchObject({ code: 'empty_model_response' });
  });

  it('shows the workspace first and opens login when the first message is sent', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(capabilities)));
    render(<App />);
    expect(await screen.findByRole('heading', { name: '新对话' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    const composer = screen.getByPlaceholderText('让 COD 修改、检查或解释这个项目...');
    fireEvent.change(composer, { target: { value: '这是我的第一条消息' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    const dialog = await screen.findByRole('dialog', { name: '登录后继续' });
    expect(within(dialog).getByLabelText('访问码')).toBeRequired();
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
      if (/\/api\/tasks\/task-new\/status$/.test(url)) {
        const body = JSON.parse(String(init?.body)) as { status: 'running' | 'complete' };
        taskVersion += 1;
        return json({ id: 'task-new', title: '登录后自动发送', status: body.status, deviceId: 'web-device', updatedAt: new Date().toISOString(), version: taskVersion, result: body.status === 'complete' ? '自动回复' : null, error: null });
      }
      if (url.endsWith('/v1/chat/completions')) return json({ choices: [{ message: { content: '自动回复' } }], cod_source: 'ai-kai', cod_charge_cents: 1 });
      if (url.endsWith('/api/products') || url.endsWith('/api/ledger')) return json([]);
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    await screen.findByRole('heading', { name: '新对话' });
    const composer = screen.getByPlaceholderText('让 COD 修改、检查或解释这个项目...');
    fireEvent.change(composer, { target: { value: '登录后自动发送' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    const dialog = await screen.findByRole('dialog', { name: '登录后继续' });
    fireEvent.change(within(dialog).getByLabelText('访问码'), { target: { value: 'pilot' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '登录并继续' }));
    expect(await screen.findByText('自动回复')).toBeInTheDocument();
    const chatCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/v1/chat/completions'));
    expect(JSON.parse(String(chatCall?.[1]?.body)).messages).toEqual([{ role: 'user', content: '登录后自动发送' }]);
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
      if (url.endsWith('/api/products') || url.endsWith('/api/ledger')) return json([]);
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    await screen.findByRole('heading', { name: '新对话' });
    fireEvent.click(screen.getByTitle('登录'));
    const loginDialog = await screen.findByRole('dialog', { name: '登录 COD' });
    fireEvent.change(within(loginDialog).getByLabelText('访问码'), { target: { value: 'pilot' } });
    fireEvent.click(within(loginDialog).getByRole('button', { name: '登录' }));
    expect(await screen.findByRole('heading', { name: '真实同步任务', level: 1 })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: '模型源' })).toHaveValue('ai-kai');
    expect(screen.getByRole('combobox', { name: '模型' })).toHaveValue('glm-5.2');
    fireEvent.change(screen.getByRole('combobox', { name: '模型源' }), { target: { value: 'chase-kai' } });
    expect(screen.getByRole('combobox', { name: '模型' })).toHaveValue('gpt-5.6-sol');
    expect(screen.getAllByText('仅目录')).not.toHaveLength(0);
    fireEvent.change(screen.getByPlaceholderText('让 COD 修改、检查或解释这个项目...'), { target: { value: '不能从目录源调用' } });
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled();

    fireEvent.change(screen.getByLabelText('搜索任务'), { target: { value: '不存在' } });
    expect(screen.getByText('没有匹配的任务')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('搜索任务'), { target: { value: '' } });
    expect(screen.getByRole('button', { name: /真实同步任务/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '终端' }));
    expect(screen.getByText('Web 端不会执行或伪造终端结果。请使用 COD Desktop。')).toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/auth/login', expect.anything()));
  });
});
