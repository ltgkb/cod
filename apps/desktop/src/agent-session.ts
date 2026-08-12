import type { AgentGatewayConfig } from '@cod/contracts';

export interface MintedAgentSession {
  token: string;
  expiresAt: number;
}

interface AgentSessionResponse {
  token?: unknown;
  expiresAt?: unknown;
  scope?: {
    taskId?: unknown;
    executionId?: unknown;
    sourceId?: unknown;
    model?: unknown;
  };
}

function agentSessionEndpoint(controlPlane: URL): URL {
  const endpoint = new URL(controlPlane.toString());
  endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, '')}/api/agent-sessions`;
  endpoint.search = '';
  endpoint.hash = '';
  return endpoint;
}

async function agentSessionError(response: Response): Promise<Error> {
  let code = '';
  let message = '';
  const advertisedLength = Number(response.headers.get('content-length') ?? '0');
  if (!Number.isFinite(advertisedLength) || advertisedLength <= 64 * 1024) {
    try {
      const body = await response.json() as { error?: unknown; message?: unknown };
      if (typeof body.error === 'string') code = body.error.slice(0, 100);
      if (typeof body.message === 'string') message = body.message.slice(0, 300);
    } catch {
      // Never echo an HTML proxy response or other untrusted response body.
    }
  }
  if (response.status === 401) return new Error('COD 登录已失效，无法启动本机 Agent，请重新登录。');
  if (response.status === 404) return new Error('安全 Agent 会话接口尚未部署，无法启动本机 Agent。');
  const detail = message || code || `HTTP ${response.status}`;
  return new Error(`无法创建安全 Agent 会话：${detail}`);
}

export async function mintAgentSession(
  controlPlane: URL,
  config: AgentGatewayConfig,
  fetchImplementation: typeof fetch = fetch,
): Promise<MintedAgentSession> {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 15_000);
  let response: Response;
  try {
    response = await fetchImplementation(agentSessionEndpoint(controlPlane), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ taskId: config.taskId, executionId: config.executionId, leaseToken: config.leaseToken, sourceId: config.sourceId, model: config.modelId }),
      redirect: 'error',
      signal: controller.signal,
    });
  } catch (error) {
    const message = timedOut || (error instanceof Error && error.name === 'AbortError') ? '请求超时' : '控制面不可达';
    throw new Error(`无法创建安全 Agent 会话：${message}`);
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) throw await agentSessionError(response);

  let result: AgentSessionResponse;
  try {
    result = await response.json() as AgentSessionResponse;
  } catch {
    throw new Error('安全 Agent 会话响应不是有效 JSON。');
  }
  const { token, expiresAt, scope } = result;
  if (typeof token !== 'string' || !token || token.length > 8_192 || /[\0\r\n]/.test(token)) {
    throw new Error('安全 Agent 会话响应缺少有效令牌。');
  }
  const expiresAtMilliseconds = typeof expiresAt === 'string' ? Date.parse(expiresAt) : Number.NaN;
  if (!Number.isFinite(expiresAtMilliseconds) || expiresAtMilliseconds <= Date.now() + 30_000) {
    throw new Error('安全 Agent 会话有效期无效或过短。');
  }
  if (!scope
    || scope.taskId !== config.taskId
    || scope.executionId !== config.executionId
    || scope.sourceId !== config.sourceId
    || scope.model !== config.modelId) {
    throw new Error('安全 Agent 会话权限范围与当前任务不匹配。');
  }
  return { token, expiresAt: expiresAtMilliseconds };
}
