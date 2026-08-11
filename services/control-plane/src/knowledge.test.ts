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

  it('normalizes public chat answers and continues conversations without an API key', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({
        answer: '期算是标准化模型服务容量产品。',
        conversation_id: 'conversation-1',
        execution_id: 'execution-1',
        created_at: '2026-08-07T00:00:00Z',
      }))
      .mockResolvedValueOnce(Response.json({
        answer: '它使用 TPM 计量。',
        conversation_id: 'conversation-1',
        execution_id: 'execution-2',
        created_at: '2026-08-07T00:00:01Z',
      }));
    vi.stubGlobal('fetch', fetcher);
    const adapter = new KnowledgeAdapter(loadConfig({ NODE_ENV: 'test', KAI_WIKI_SEARCH_ENDPOINT: '/api/v1/public-chat' }));
    const principal = { userId: 'user-1', tenantId: 'tenant-1', email: 'user@kai.com', role: 'member' } as const;
    expect(adapter.mode()).toBe('live');
    expect(await adapter.search('什么是期算？', principal)).toEqual([{
      id: 'execution-1',
      title: '期算知识库回答',
      excerpt: '期算是标准化模型服务容量产品。',
      url: 'https://wiki.kai.com/',
      score: 1,
    }]);
    await adapter.search('它用什么指标计量？', principal);
    const firstRequest = fetcher.mock.calls[0]?.[1] as RequestInit;
    const secondRequest = fetcher.mock.calls[1]?.[1] as RequestInit;
    expect(firstRequest.headers).toMatchObject({ 'x-cod-tenant-id': 'tenant-1', 'x-cod-user-id': 'user-1' });
    expect(firstRequest.headers).not.toHaveProperty('authorization');
    expect(JSON.parse(String(firstRequest.body))).toEqual({ message: '什么是期算？', conversation_id: null, language: 'zh-CN' });
    expect(JSON.parse(String(secondRequest.body))).toEqual({ message: '它用什么指标计量？', conversation_id: 'conversation-1', language: 'zh-CN' });
  });

  it('rejects off-origin endpoints before making a request', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const adapter = new KnowledgeAdapter(loadConfig({ NODE_ENV: 'test', KAI_WIKI_SEARCH_ENDPOINT: 'https://example.com/chat' }));
    await expect(adapter.search('query')).rejects.toMatchObject({ code: 'wiki_invalid_endpoint' });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
