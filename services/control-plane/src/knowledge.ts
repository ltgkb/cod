import type { KnowledgeHit } from '@cod/contracts';
import type { ControlPlaneConfig } from './config.js';
import type { Principal } from './database.js';
import { HttpError } from './errors.js';

const samples: KnowledgeHit[] = [
  { id: 'wiki-agent-policy', title: 'Agent 权限与审计规范', excerpt: 'Agent 执行命令前需要声明范围，高风险操作必须由用户确认。', url: 'https://wiki.kai.com/agent-policy', score: 0.94 },
  { id: 'wiki-token-billing', title: 'KAI Token 计费说明', excerpt: '余额按模型实际输入和输出 Token 扣减，所有流水可追溯。', url: 'https://wiki.kai.com/token-billing', score: 0.88 },
];

export class KnowledgeAdapter {
  constructor(private readonly config: ControlPlaneConfig) {}

  mode(): 'live' | 'demo' {
    return this.config.wikiSearchEndpoint && this.config.wikiApiKey ? 'live' : 'demo';
  }

  async search(query: string, principal?: Principal): Promise<KnowledgeHit[]> {
    const normalized = query.trim();
    if (!normalized) return [];
    const endpoint = this.config.wikiSearchEndpoint;
    const apiKey = this.config.wikiApiKey;
    if (!endpoint || !apiKey) {
      return samples.filter((item) => `${item.title}${item.excerpt}`.toLowerCase().includes(normalized.toLowerCase()));
    }
    let response: Response;
    try {
      response = await fetch(new URL(endpoint, this.config.wikiBaseUrl), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
          ...(principal ? { 'x-cod-tenant-id': principal.tenantId, 'x-cod-user-id': principal.userId } : {}),
        },
        body: JSON.stringify({ query: normalized.slice(0, 2_000), limit: 8, tenantId: principal?.tenantId, userId: principal?.userId }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new HttpError('KAI Wiki is unavailable', 502, 'wiki_unavailable');
    }
    if (!response.ok) throw new HttpError(`KAI Wiki search failed: ${response.status}`, 502, 'wiki_upstream_error');
    return normalizeKnowledgeHits(await response.json());
  }
}

function normalizeKnowledgeHits(raw: unknown): KnowledgeHit[] {
  let rows: unknown = raw;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const envelope = raw as Record<string, unknown>;
    rows = envelope.data ?? envelope.hits ?? envelope.results ?? [];
  }
  if (!Array.isArray(rows)) throw new HttpError('KAI Wiki returned an invalid response', 502, 'wiki_invalid_response');
  return rows.slice(0, 8).flatMap((row, index): KnowledgeHit[] => {
    if (!row || typeof row !== 'object') return [];
    const item = row as Record<string, unknown>;
    const title = String(item.title ?? item.name ?? '').trim().slice(0, 300);
    const excerpt = String(item.excerpt ?? item.snippet ?? item.content ?? '').trim().slice(0, 2_000);
    const rawUrl = String(item.url ?? item.link ?? '').trim();
    const score = Number(item.score ?? item.relevance ?? 0);
    if (!title || !excerpt || !Number.isFinite(score)) return [];
    let url: URL;
    try { url = new URL(rawUrl); } catch { return []; }
    if (url.protocol !== 'https:') return [];
    return [{ id: String(item.id ?? item.document_id ?? `wiki-${index}`).slice(0, 200), title, excerpt, url: url.toString(), score }];
  });
}
