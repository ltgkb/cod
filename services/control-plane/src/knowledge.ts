import type { KnowledgeHit } from '@cod/contracts';
import type { ControlPlaneConfig } from './config.js';

const samples: KnowledgeHit[] = [
  { id: 'wiki-agent-policy', title: 'Agent 权限与审计规范', excerpt: 'Agent 执行命令前需要声明范围，高风险操作必须由用户确认。', url: 'https://wiki.kai.com/agent-policy', score: 0.94 },
  { id: 'wiki-token-billing', title: 'KAI Token 计费说明', excerpt: '余额按模型实际输入和输出 Token 扣减，所有流水可追溯。', url: 'https://wiki.kai.com/token-billing', score: 0.88 },
];

export class KnowledgeAdapter {
  constructor(private readonly config: ControlPlaneConfig) {}

  async search(query: string): Promise<KnowledgeHit[]> {
    const normalized = query.trim();
    if (!normalized) return [];
    const endpoint = process.env.KAI_WIKI_SEARCH_ENDPOINT;
    const apiKey = process.env.KAI_WIKI_API_KEY;
    if (!endpoint || !apiKey) {
      return samples.filter((item) => `${item.title}${item.excerpt}`.toLowerCase().includes(normalized.toLowerCase()) || normalized.length > 1);
    }
    const response = await fetch(new URL(endpoint, this.config.wikiBaseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ query: normalized, limit: 5 }),
    });
    if (!response.ok) throw new Error(`Wiki search failed: ${response.status}`);
    return response.json() as Promise<KnowledgeHit[]>;
  }
}
