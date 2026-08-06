import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from './config.js';
import { AiGateway } from './gateway.js';

describe('model source gateway', () => {
  it('loads live and catalog-only sources with wallet prices and routes by source', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://ai.kai.com/api/pricing') return Response.json({ data: [{ model_name: 'glm-5.2', quota_type: 0, model_ratio: 0.597, completion_ratio: 3.5, supported_endpoint_types: ['openai'] }] });
      if (url === 'https://chase.kai.com/api/pricing') return Response.json({ data: [{ model_name: 'gpt-5.6-sol', quota_type: 0, model_ratio: 37.5, completion_ratio: 8, supported_endpoint_types: ['openai'] }] });
      if (url.endsWith('/api/status')) return Response.json({ data: { quota_per_unit: 500_000, price: 7 } });
      if (url === 'https://ai.kai.com/v1/models') return Response.json({ data: [{ id: 'glm-5.2' }] });
      if (url === 'https://ai.kai.com/v1/chat/completions') {
        expect((init?.headers as Record<string, string>).authorization).toBe('Bearer test-key');
        return Response.json({ id: 'chat-live', model: 'glm-5.2', choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const gateway = new AiGateway(loadConfig({ NODE_ENV: 'production', KAI_API_KEY: 'test-key' }), fetcher as typeof fetch);
    const sources = await gateway.listSources();
    expect(sources).toHaveLength(2);
    expect(sources[0]).toMatchObject({ id: 'ai-kai', status: 'live', callable: true, models: [{ id: 'glm-5.2', inputPricePerMillionCents: 836, outputPricePerMillionCents: 2926 }] });
    expect(sources[1]).toMatchObject({ id: 'chase-kai', status: 'catalog', callable: false, models: [{ id: 'gpt-5.6-sol' }] });
    await expect(gateway.getModel('chase-kai', 'gpt-5.6-sol')).rejects.toMatchObject({ status: 503, code: 'source_unavailable' });
    expect((await gateway.proxyChat('ai-kai', { model: 'glm-5.2', messages: [] })).status).toBe(200);
  });
});
