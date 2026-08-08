import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from './config.js';
import { AiGateway } from './gateway.js';

describe('model source gateway', () => {
  it('routes every display source through ai.kai.com and retries an empty answer', async () => {
    let chatAttempts = 0;
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://ai.kai.com/api/pricing') return Response.json({ data: [{ model_name: 'glm-5.2', quota_type: 0, model_ratio: 0.597, completion_ratio: 3.5, supported_endpoint_types: ['openai'] }] });
      if (url.endsWith('/api/status')) return Response.json({ data: { quota_per_unit: 500_000, price: 7 } });
      if (url === 'https://ai.kai.com/v1/models') return Response.json({ data: [{ id: 'glm-5.2' }] });
      if (url === 'https://ai.kai.com/v1/chat/completions') {
        expect((init?.headers as Record<string, string>).authorization).toBe('Bearer test-key');
        expect((init?.headers as Record<string, string>)['x-request-id']).toBe('request-1');
        chatAttempts += 1;
        if (chatAttempts === 1) return Response.json({ id: 'chat-empty', choices: [{ message: { content: '' } }] });
        return Response.json({ id: 'chat-live', model: 'glm-5.2', choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const gateway = new AiGateway(loadConfig({
      NODE_ENV: 'production',
      COD_SESSION_SECRET: 's'.repeat(32),
      DATABASE_URL: 'postgresql://cod:test@127.0.0.1:5432/cod',
      COD_DEVELOPMENT_LOGIN_ENABLED: 'false',
      KAI_API_KEY: 'test-key',
    }), fetcher as typeof fetch);
    const sources = await gateway.listSources();
    expect(sources).toHaveLength(2);
    expect(sources[0]).toMatchObject({ id: 'ai-kai', upstreamSourceId: 'ai-kai', status: 'live', callable: true, models: [{ id: 'glm-5.2', inputPricePerMillionCents: 836, outputPricePerMillionCents: 2926 }] });
    expect(sources[1]).toMatchObject({ id: 'chase-kai', upstreamSourceId: 'ai-kai', status: 'live', callable: true, models: [{ id: 'glm-5.2' }] });
    const response = await gateway.proxyChat('chase-kai', { model: 'glm-5.2', messages: [] }, 'request-1');
    expect(response.status).toBe(200);
    expect(chatAttempts).toBe(2);
  });
});
