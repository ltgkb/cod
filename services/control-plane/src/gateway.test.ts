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
    expect(sources).toHaveLength(2);
    expect(sources[0]).toMatchObject({ id: 'ai-kai', upstreamSourceId: 'ai-kai', status: 'live', callable: true, models: [{ id: 'glm-5.2', inputPricePerMillionCents: 836, outputPricePerMillionCents: 2926 }] });
    expect(sources[1]).toMatchObject({ id: 'chase-kai', upstreamSourceId: 'ai-kai', status: 'live', callable: true, models: [{ id: 'glm-5.2' }] });
    const response = await gateway.proxyChat('chase-kai', { model: 'glm-5.2', messages: [] }, 'request-1');
    expect(response.status).toBe(200);
    expect(chatAttempts).toBe(2);
    const toolResponse=await gateway.proxyChat('ai-kai',{model:'glm-5.2',messages:[],tools:[{type:'function',function:{name:'developer__file_write'}}]},'request-tools');
    expect(toolResponse.status).toBe(200);
    expect(chatAttempts).toBe(3);
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
});
