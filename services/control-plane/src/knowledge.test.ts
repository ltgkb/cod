import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from './config.js';
import { KnowledgeAdapter } from './knowledge.js';

describe('KnowledgeAdapter', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns cited mock knowledge when credentials are absent', async () => {
    const hits = await new KnowledgeAdapter(loadConfig({})).search('Agent');
    expect(hits[0]?.url).toContain('wiki.kai.com');
    expect(hits[0]?.score).toBeGreaterThan(0.8);
    expect(await new KnowledgeAdapter(loadConfig({})).search('unrelated phrase')).toEqual([]);
  });

  it('normalizes live results, propagates tenant identity, and drops unsafe links', async () => {
    const fetcher = vi.fn(async () => Response.json({ results: [
      { document_id: 'doc-1', name: '权限规范', snippet: '仅返回当前租户内容', link: 'https://wiki.kai.com/doc-1', relevance: 0.91 },
      { id: 'unsafe', title: 'unsafe', excerpt: 'bad', url: 'javascript:alert(1)', score: 1 },
    ] }));
    vi.stubGlobal('fetch', fetcher);
    const adapter = new KnowledgeAdapter(loadConfig({ NODE_ENV: 'test', KAI_WIKI_SEARCH_ENDPOINT: '/api/search', KAI_WIKI_API_KEY: 'wiki-key' }));
    const hits = await adapter.search('权限', { userId: 'user-1', tenantId: 'tenant-1', email: 'user@kai.com', role: 'member' });
    expect(hits).toEqual([{ id: 'doc-1', title: '权限规范', excerpt: '仅返回当前租户内容', url: 'https://wiki.kai.com/doc-1', score: 0.91 }]);
    expect(fetcher).toHaveBeenCalledWith(new URL('https://wiki.kai.com/api/search'), expect.objectContaining({ headers: expect.objectContaining({ 'x-cod-tenant-id': 'tenant-1', 'x-cod-user-id': 'user-1' }) }));
  });
});
