import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from './config.js';
import { AiGateway } from './gateway.js';
import { nonPublicTokenRetailDomains, tokenRetailDomains, tokenRetailSourceId } from './token-retail-directory.js';

describe('model source gateway', () => {
  it('never invents a demo source unless demo mode is explicitly enabled', async () => {
    const unavailableGateway = new AiGateway(loadConfig({ NODE_ENV: 'development' }));
    expect(await unavailableGateway.listSources()).toEqual([]);
    expect(await unavailableGateway.mode()).toBe('unavailable');

    const demoGateway = new AiGateway(loadConfig({ NODE_ENV: 'development', COD_DEMO_MODE: 'true' }));
    expect(await demoGateway.listSources()).toMatchObject([{ id: 'demo', status: 'demo', callable: true }]);
    expect(await demoGateway.mode()).toBe('demo');
  });

  it('routes every display source through ai.kai.com and retries an empty answer', async () => {
    let chatAttempts = 0;
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://ai.kai.com/api/pricing') return Response.json({ data: [{ model_name: 'glm-5.2', quota_type: 0, model_ratio: 0.597, completion_ratio: 3.5, supported_endpoint_types: ['openai'] }] });
      if (url.endsWith('/api/status')) return Response.json({ data: { quota_per_unit: 500_000, price: 7 } });
      if (url === 'https://ai.kai.com/v1/models') return Response.json({ data: [{ id: 'glm-5.2' }] });
      if (url === 'https://ai.kai.com/v1/chat/completions') {
        expect((init?.headers as Record<string, string>).authorization).toBe('Bearer test-key');
        const requestId=(init?.headers as Record<string, string>)['x-request-id'];
        chatAttempts += 1;
        if(requestId==='request-tools')return Response.json({id:'chat-tools',model:'glm-5.2',choices:[{message:{role:'assistant',content:null,tool_calls:[{id:'call-1',type:'function',function:{name:'developer__file_write',arguments:'{"path":"game.html"}'}}]},finish_reason:'tool_calls'}],usage:{prompt_tokens:10,completion_tokens:5}});
        expect(requestId).toBe('request-1');
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
    expect(tokenRetailDomains).toHaveLength(86);
    expect(nonPublicTokenRetailDomains).toEqual(['staging-pmai.kai.com', 'authtest.kai.com']);
    for (const domain of nonPublicTokenRetailDomains) expect(tokenRetailDomains).not.toContain(domain);
    expect(sources).toHaveLength(tokenRetailDomains.length + 1);
    expect(new Set(sources.map((source) => source.id)).size).toBe(sources.length);
    expect(sources.every((source) => /^[a-z0-9-]{2,40}$/.test(source.id))).toBe(true);
    expect(sources[0]).toMatchObject({ id: 'ai-kai', upstreamSourceId: 'ai-kai', status: 'live', callable: true, models: [{ id: 'glm-5.2', inputPricePerMillionCents: 836, outputPricePerMillionCents: 2926 }] });
    expect(sources.slice(1).map((source) => source.id)).toEqual(tokenRetailDomains.map(tokenRetailSourceId));
    expect(sources.find((source) => source.id === 'chase-kai')).toMatchObject({ label: 'CHASE.KAI.COM', upstreamSourceId: 'ai-kai', status: 'live', callable: true, models: [{ id: 'glm-5.2' }] });
    expect(fetcher).toHaveBeenCalledTimes(3);
    const response = await gateway.proxyChat('chase-kai', { model: 'glm-5.2', messages: [] }, 'request-1');
    expect(response.status).toBe(200);
    expect(chatAttempts).toBe(2);
    const toolResponse=await gateway.proxyChat('ai-kai',{model:'glm-5.2',messages:[],tools:[{type:'function',function:{name:'developer__file_write'}}]},'request-tools');
    expect(toolResponse.status).toBe(200);
    expect(chatAttempts).toBe(3);
  });

  it('keeps client-selected source attribution non-financial in production', () => {
    expect(() => loadConfig({
      NODE_ENV: 'production',
      COD_SESSION_SECRET: 's'.repeat(32),
      DATABASE_URL: 'postgresql://cod:test@127.0.0.1:5432/cod',
      COD_DEVELOPMENT_LOGIN_ENABLED: 'false',
      KAI_API_KEY: 'test-key',
      TOKEN_RETAIL_COMMISSION_RATE_BPS: '1',
    })).toThrow('Production source commissions require server-bound attribution');
    for (const id of ['staging-pmai-kai', 'authtest-kai']) {
      expect(() => loadConfig({
        NODE_ENV: 'production',
        COD_SESSION_SECRET: 's'.repeat(32),
        DATABASE_URL: 'postgresql://cod:test@127.0.0.1:5432/cod',
        COD_DEVELOPMENT_LOGIN_ENABLED: 'false',
        KAI_API_KEY: 'test-key',
        COD_MODEL_SOURCES_JSON: JSON.stringify([{ id, label: id.toUpperCase() }]),
      })).toThrow('is non-public');
    }
    for (const [index, label] of ['STAGING-PMAI.KAI.COM', 'AUTHTEST.KAI.COM'].entries()) {
      expect(() => loadConfig({
        NODE_ENV: 'production',
        COD_SESSION_SECRET: 's'.repeat(32),
        DATABASE_URL: 'postgresql://cod:test@127.0.0.1:5432/cod',
        COD_DEVELOPMENT_LOGIN_ENABLED: 'false',
        KAI_API_KEY: 'test-key',
        COD_MODEL_SOURCES_JSON: JSON.stringify([{ id: `public-alias-${index}`, label }]),
      })).toThrow('is non-public');
    }
    expect(() => loadConfig({
      NODE_ENV: 'production',
      COD_SESSION_SECRET: 's'.repeat(32),
      DATABASE_URL: 'postgresql://cod:test@127.0.0.1:5432/cod',
      COD_DEVELOPMENT_LOGIN_ENABLED: 'false',
      KAI_API_KEY: 'test-key',
      COD_MODEL_SOURCES_JSON: JSON.stringify([{ id: 'demo', label: 'Live provider' }]),
    })).toThrow('uses a reserved ID');
  });

  it('never routes a configured live source through the reserved demo response', async () => {
    const config = loadConfig({
      NODE_ENV: 'production',
      COD_SESSION_SECRET: 's'.repeat(32),
      DATABASE_URL: 'postgresql://cod:test@127.0.0.1:5432/cod',
      COD_DEVELOPMENT_LOGIN_ENABLED: 'false',
      KAI_API_KEY: 'test-key',
    });
    config.modelSources = [{ ...config.modelSources[0]!, id: 'demo', label: 'Malformed live source' }];
    const fetcher = vi.fn(async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url.endsWith('/api/pricing')) return Response.json({ data: [{ model_name: 'glm-5.2', quota_type: 0, model_ratio: 1, completion_ratio: 1, supported_endpoint_types: ['openai'] }] });
      if (url.endsWith('/api/status')) return Response.json({ data: { quota_per_unit: 500_000, price: 7 } });
      if (url.endsWith('/models')) return Response.json({ data: [{ id: 'glm-5.2' }] });
      throw new Error(`Unexpected request: ${url}`);
    });
    const gateway = new AiGateway(config, fetcher as typeof fetch);
    await expect(gateway.proxyChat('demo', { model: 'glm-5.2', messages: [] }, 'reserved-demo')).rejects.toMatchObject({ status: 400, code: 'unknown_source' });
    expect(fetcher.mock.calls.some(([input]) => String(input).endsWith('/chat/completions'))).toBe(false);
  });

  it('uses upstream SSE to keep long generations alive and normalizes the final answer for billing', async () => {
    let streamCancelled = false;
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/pricing')) return Response.json({ data: [{ model_name: 'glm-5.2', quota_type: 0, model_ratio: 0.597, completion_ratio: 3.5, supported_endpoint_types: ['openai'] }] });
      if (url.endsWith('/api/status')) return Response.json({ data: { quota_per_unit: 500_000, price: 7 } });
      if (url.endsWith('/models')) return Response.json({ data: [{ id: 'glm-5.2' }] });
      if (url.endsWith('/chat/completions')) {
        expect(JSON.parse(String(init?.body))).toMatchObject({ stream: true, stream_options: { include_usage: true } });
        const events = [
          { id: 'stream-1', model: 'glm-5.2', created: 1, choices: [{ delta: { role: 'assistant', content: '推箱子' }, finish_reason: null }] },
          { id: 'stream-1', model: 'glm-5.2', created: 1, choices: [{ delta: { content: '已完成' }, finish_reason: 'stop' }] },
          { id: 'stream-1', model: 'glm-5.2', created: 1, choices: [], usage: { prompt_tokens: 12, completion_tokens: 34, total_tokens: 46 } },
        ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n';
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          start(controller) { controller.enqueue(encoder.encode(events)); },
          cancel() { streamCancelled = true; },
        });
        return new Response(stream, { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const gateway = new AiGateway(loadConfig({ NODE_ENV: 'production', COD_SESSION_SECRET: 's'.repeat(32), DATABASE_URL: 'postgresql://cod:test@127.0.0.1:5432/cod', COD_DEVELOPMENT_LOGIN_ENABLED: 'false', KAI_API_KEY: 'test-key' }), fetcher as typeof fetch);
    await gateway.listSources();
    const response = await gateway.proxyChat('ai-kai', { model: 'glm-5.2', messages: [{ role: 'user', content: '做个游戏' }], stream: false }, 'stream-request');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ model: 'glm-5.2', choices: [{ message: { content: '推箱子已完成' }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 34 } });
    expect(streamCancelled).toBe(true);
  });

  it('propagates task cancellation to the upstream model without retrying',async()=>{
    let attempts=0;let aborted=false;
    const fetcher=vi.fn(async(input:string|URL|Request,init?:RequestInit):Promise<Response>=>{const url=String(input);if(url.endsWith('/api/pricing'))return Response.json({data:[{model_name:'slow-model',quota_type:0,model_ratio:1,completion_ratio:1,supported_endpoint_types:['openai']}]});if(url.endsWith('/api/status'))return Response.json({data:{quota_per_unit:500000,price:7}});if(url.endsWith('/models'))return Response.json({data:[{id:'slow-model'}]});if(url.endsWith('/chat/completions')){attempts+=1;return new Promise<Response>((_resolve,reject)=>init?.signal?.addEventListener('abort',()=>{aborted=true;reject(init.signal?.reason);},{once:true}));}throw new Error(`Unexpected request: ${url}`);});
    const gateway=new AiGateway(loadConfig({NODE_ENV:'production',COD_SESSION_SECRET:'s'.repeat(32),DATABASE_URL:'postgresql://cod:test@127.0.0.1:5432/cod',COD_DEVELOPMENT_LOGIN_ENABLED:'false',KAI_API_KEY:'test-key'}),fetcher as typeof fetch);await gateway.listSources();const controller=new AbortController();const pending=gateway.proxyChat('ai-kai',{model:'slow-model',messages:[{role:'user',content:'slow'}]},'cancel-request',controller.signal);await vi.waitFor(()=>expect(attempts).toBe(1));controller.abort();await expect(pending).rejects.toMatchObject({code:'task_cancelled'});expect(aborted).toBe(true);expect(attempts).toBe(1);
  });

  it('fails closed instead of inventing prices when the pricing unit status is unavailable', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/api/pricing')) return Response.json({ data: [{ model_name: 'glm-5.2', quota_type: 0, model_ratio: 0.597, completion_ratio: 3.5, supported_endpoint_types: ['openai'] }] });
      if (url.endsWith('/api/status')) return new Response('unavailable', { status: 503 });
      if (url.endsWith('/models')) return Response.json({ data: [{ id: 'glm-5.2' }] });
      throw new Error(`Unexpected request: ${url}`);
    });
    const gateway = new AiGateway(loadConfig({ NODE_ENV: 'production', COD_SESSION_SECRET: 's'.repeat(32), DATABASE_URL: 'postgresql://cod:test@127.0.0.1:5432/cod', COD_DEVELOPMENT_LOGIN_ENABLED: 'false', KAI_API_KEY: 'test-key' }), fetcher as typeof fetch);
    const sources = await gateway.listSources();
    expect(sources).toHaveLength(tokenRetailDomains.length + 1);
    expect(sources.every((source) => source.status === 'unavailable' && !source.callable && source.models.length === 0)).toBe(true);
    expect(sources[0]?.note).toContain('定价状态暂时无法验证');
    await expect(gateway.getModel('ai-kai', 'glm-5.2')).rejects.toMatchObject({ status: 503, code: 'source_unavailable' });
  });

  it('ignores malformed, unsafe, conflicting, and excessive catalog entries without failing the directory', async () => {
    const validRows = Array.from({ length: 205 }, (_, index) => ({
      model_name: `safe-model-${String(index).padStart(3, '0')}`,
      quota_type: 0,
      model_ratio: 1,
      completion_ratio: 2,
      supported_endpoint_types: ['openai'],
    }));
    const advertised = validRows.map((row) => ({ id: row.model_name }));
    advertised.push(null as unknown as { id: string }, { id: 'bad\nmodel' }, { id: 'x'.repeat(201) });
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/api/pricing')) return Response.json({ data: [
        null,
        {},
        { model_name: 'bad-endpoints', quota_type: 0, model_ratio: 1, completion_ratio: 1, supported_endpoint_types: {} },
        { model_name: 'overflow', quota_type: 0, model_ratio: Number.MAX_VALUE, completion_ratio: Number.MAX_VALUE, supported_endpoint_types: ['openai'] },
        { ...validRows[0], model_ratio: 2 },
        ...validRows,
      ] });
      if (url.endsWith('/api/status')) return Response.json({ data: { quota_per_unit: 500_000, price: 7 } });
      if (url.endsWith('/models')) return Response.json({ data: advertised });
      throw new Error(`Unexpected request: ${url}`);
    });
    const gateway = new AiGateway(loadConfig({ NODE_ENV: 'production', COD_SESSION_SECRET: 's'.repeat(32), DATABASE_URL: 'postgresql://cod:test@127.0.0.1:5432/cod', COD_DEVELOPMENT_LOGIN_ENABLED: 'false', KAI_API_KEY: 'test-key' }), fetcher as typeof fetch);
    const source = (await gateway.listSources())[0];
    expect(source).toMatchObject({ status: 'live', callable: true });
    expect(source?.models).toHaveLength(200);
    expect(source?.models.some((model) => model.id === 'overflow' || model.id === validRows[0]?.model_name)).toBe(false);
    expect(source?.models.every((model) => Number.isSafeInteger(model.inputPricePerMillionCents) && Number.isSafeInteger(model.outputPricePerMillionCents))).toBe(true);
  });

  it('treats a malformed authenticated model list as non-callable catalog data', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/api/pricing')) return Response.json({ data: [{ model_name: 'glm-5.2', quota_type: 0, model_ratio: 1, completion_ratio: 2, supported_endpoint_types: ['openai'] }] });
      if (url.endsWith('/api/status')) return Response.json({ data: { quota_per_unit: 500_000, price: 7 } });
      if (url.endsWith('/models')) return Response.json({ data: [null, {}, { id: 42 }] });
      throw new Error(`Unexpected request: ${url}`);
    });
    const gateway = new AiGateway(loadConfig({ NODE_ENV: 'production', COD_SESSION_SECRET: 's'.repeat(32), DATABASE_URL: 'postgresql://cod:test@127.0.0.1:5432/cod', COD_DEVELOPMENT_LOGIN_ENABLED: 'false', KAI_API_KEY: 'test-key' }), fetcher as typeof fetch);
    const source = (await gateway.listSources())[0];
    expect(source).toMatchObject({ status: 'catalog', callable: false, models: [{ id: 'glm-5.2' }] });
  });
});
