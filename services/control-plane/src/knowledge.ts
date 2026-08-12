import type { KnowledgeHit } from '@cod/contracts';
import type { ControlPlaneConfig } from './config.js';
import type { Principal } from './database.js';
import { HttpError } from './errors.js';

const samples: KnowledgeHit[] = [
  { id: 'wiki-agent-policy', title: 'Agent 权限与审计规范', excerpt: 'Agent 执行命令前需要声明范围，高风险操作必须由用户确认。', url: 'https://wiki.kai.com/agent-policy', score: 0.94 },
  { id: 'wiki-token-billing', title: 'KAI Token 计费说明', excerpt: '余额按模型实际输入和输出 Token 扣减，所有流水可追溯。', url: 'https://wiki.kai.com/token-billing', score: 0.88 },
];

// Public-chat answers can include retrieval and generation; production calls
// occasionally exceed 15 seconds even while the upstream remains healthy.
const wikiRequestTimeoutMs = 45_000;

export class KnowledgeAdapter {
  private readonly conversationIds = new Map<string, string>();

  constructor(private readonly config: ControlPlaneConfig) {}

  mode(): 'live' | 'demo' {
    return this.config.wikiSearchEndpoint ? 'live' : 'demo';
  }

  async search(query: string, principal?: Principal): Promise<KnowledgeHit[]> {
    const normalized = query.trim();
    if (!normalized) return [];
    const endpoint = this.config.wikiSearchEndpoint;
    const apiKey = this.config.wikiApiKey;
    if (!endpoint) {
      return samples.filter((item) => `${item.title}${item.excerpt}`.toLowerCase().includes(normalized.toLowerCase()));
    }
    const wikiUrl = this.resolveEndpoint(endpoint);
    const conversationKey = principal ? `${principal.tenantId}:${principal.userId}` : null;
    let response: Response;
    try {
      response = await fetch(wikiUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
          ...(principal ? { 'x-cod-tenant-id': principal.tenantId, 'x-cod-user-id': principal.userId } : {}),
        },
        body: JSON.stringify({
          message: normalized.slice(0, 2_000),
          conversation_id: conversationKey ? this.conversationIds.get(conversationKey) ?? null : null,
          language: 'zh-CN',
        }),
        signal: AbortSignal.timeout(wikiRequestTimeoutMs),
      });
    } catch {
      throw new HttpError('KAI Wiki is unavailable', 502, 'wiki_unavailable');
    }
    if (!response.ok) throw new HttpError(`KAI Wiki search failed: ${response.status}`, 502, 'wiki_upstream_error');
    const raw = await readJsonResponse(response);
    const result = normalizePublicChatResponse(raw, this.config.wikiBaseUrl);
    if (conversationKey && result.conversationId) {
      if (this.conversationIds.size >= 10_000 && !this.conversationIds.has(conversationKey)) this.conversationIds.clear();
      this.conversationIds.set(conversationKey, result.conversationId);
    }
    return [result.hit];
  }

  private resolveEndpoint(endpoint: string): URL {
    let baseUrl: URL;
    let wikiUrl: URL;
    try {
      baseUrl = new URL(this.config.wikiBaseUrl);
      wikiUrl = new URL(endpoint, baseUrl);
    } catch {
      throw new HttpError('KAI Wiki endpoint is invalid', 502, 'wiki_invalid_endpoint');
    }
    if (baseUrl.protocol !== 'https:' || wikiUrl.protocol !== 'https:' || wikiUrl.origin !== baseUrl.origin) {
      throw new HttpError('KAI Wiki endpoint must use the configured HTTPS origin', 502, 'wiki_invalid_endpoint');
    }
    return wikiUrl;
  }
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const contentLength = Number(response.headers.get('content-length') ?? 0);
  if (Number.isFinite(contentLength) && contentLength > 1_000_000) {
    throw new HttpError('KAI Wiki returned an oversized response', 502, 'wiki_invalid_response');
  }
  const text = await response.text();
  if (text.length > 1_000_000) throw new HttpError('KAI Wiki returned an oversized response', 502, 'wiki_invalid_response');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError('KAI Wiki returned an invalid response', 502, 'wiki_invalid_response');
  }
}

function normalizePublicChatResponse(raw: unknown, wikiBaseUrl: string): { hit: KnowledgeHit; conversationId: string | null } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new HttpError('KAI Wiki returned an invalid response', 502, 'wiki_invalid_response');
  }
  const item = raw as Record<string, unknown>;
  const answer = typeof item.answer === 'string' ? item.answer.trim().slice(0, 20_000) : '';
  const conversationId = typeof item.conversation_id === 'string' ? item.conversation_id.trim().slice(0, 200) : '';
  const executionId = typeof item.execution_id === 'string' ? item.execution_id.trim().slice(0, 200) : '';
  if (!answer || !conversationId) {
    throw new HttpError('KAI Wiki returned an invalid response', 502, 'wiki_invalid_response');
  }
  return {
    hit: {
      id: executionId || conversationId,
      title: '期算知识库回答',
      excerpt: answer.slice(0, 2_000),
      url: new URL(wikiBaseUrl).toString(),
      score: 1,
    },
    conversationId,
  };
}
