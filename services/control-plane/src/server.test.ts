import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import { assistantContentFromResponse, assistantFinishReasonFromResponse, assistantToolCallsFromResponse, createControlPlane, isValidChatMessage, usageFromResponse } from './server.js';
import { loadConfig } from './config.js';
import { AiGateway } from './gateway.js';
import { MemoryDatabase } from './memory-database.js';

const servers: Array<ReturnType<typeof createControlPlane>> = [];
afterEach(async () => Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))));

async function start(overrides: Record<string, string> = {}, gatewayFetcher?:typeof fetch) {
  const database = new MemoryDatabase();
  const email='developer@kai.com';
  await database.registerIdentity({userId:`usr_${createHash('sha256').update(email).digest('hex').slice(0,20)}`,tenantId:'tenant_kai_com',email,role:'member'},'scrypt$16384$8$1$dGVzdC1hdXRoLXNhbHQtMQ$OkZEwwvTyk_BXs8umIBKldU3L-Oit-AkHANDBB81kdN0CCW6-5kqg9cGUwmetGRwxs9g_NiohCkGSni7NtcayQ',null,false);
  const config = loadConfig({ NODE_ENV: 'test', COD_DEVELOPMENT_LOGIN_ENABLED: 'true', COD_DEVELOPMENT_LOGIN_EMAIL: 'developer@kai.com', COD_DEVELOPMENT_TOPUP_ENABLED: 'false', ...overrides });
  const server = createControlPlane({ config, database, ...(gatewayFetcher?{gateway:new AiGateway(config,gatewayFetcher)}:{}) }); servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('missing address');
  return { base: `http://127.0.0.1:${address.port}`, database };
}

describe('control-plane production rules', () => {
  it('fails closed on incomplete production secrets and never enables direct production topups', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow('COD_SESSION_SECRET');
    const config = loadConfig({
      NODE_ENV: 'production',
      COD_SESSION_SECRET: 's'.repeat(32),
      DATABASE_URL: 'postgresql://cod:test@127.0.0.1:5432/cod',
      KAI_API_KEY: 'provider-key',
      COD_DEVELOPMENT_LOGIN_ENABLED: 'true',
      COD_PILOT_ACCESS_CODE_HASH: 'a'.repeat(64),
      COD_DEVELOPMENT_TOPUP_ENABLED: 'true',
    });
    expect(config.developmentTopupEnabled).toBe(false);
    expect(config.registrationEnabled).toBe(false);
    expect(config.inviteCodeRequired).toBe(false);
  });

  it('rejects empty assistant content before it can be settled as a successful reply', () => {
    expect(assistantContentFromResponse({ choices: [{ message: { content: '回答' } }] })).toBe('回答');
    expect(assistantContentFromResponse({ choices: [{ message: { content: [{ type: 'text', text: '分段回答' }] } }] })).toBe('分段回答');
    expect(assistantContentFromResponse({ choices: [{ message: { content: '   ' } }] })).toBeNull();
    expect(assistantContentFromResponse({ choices: [] })).toBeNull();
    expect(assistantToolCallsFromResponse({choices:[{message:{content:null,tool_calls:[{id:'call-1',type:'function',function:{name:'developer__file_write',arguments:'{"path":"game.html"}'}}]}}]})).toHaveLength(1);
    expect(assistantToolCallsFromResponse({choices:[{message:{tool_calls:[{id:'call-1',function:{name:'developer__file_write'}}]}}]})).toHaveLength(0);
    expect(assistantFinishReasonFromResponse({choices:[{finish_reason:'length'}]})).toBe('length');
    expect(assistantFinishReasonFromResponse({choices:[{finish_reason:'stop'}]})).toBe('stop');
    expect(assistantFinishReasonFromResponse({choices:[]})).toBeNull();
    expect(isValidChatMessage({role:'assistant',content:null,tool_calls:[{id:'call-1',type:'function',function:{name:'developer__file_write',arguments:'{}'}}]})).toBe(true);
    expect(isValidChatMessage({role:'tool',tool_call_id:'call-1',content:'written'})).toBe(true);
    expect(isValidChatMessage({role:'assistant',content:null})).toBe(false);
    expect(usageFromResponse({ choices: [] }, { messages: [{ role: 'user', content: 'hello' }] }, 'answer')).toMatchObject({ estimated: true });
    expect(usageFromResponse({ usage: { prompt_tokens: 12, completion_tokens: 4 } }, {}, 'answer')).toEqual({ inputTokens: 12, outputTokens: 4, estimated: false });
  });

  it('uses password login with generic credential errors and disables direct topups', async () => {
    const { base } = await start();
    const denied = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'other@kai.com', password:'Password123' }) });
    expect(denied.status).toBe(401);
    const wrongPassword = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'developer@kai.com', password: 'WrongPassword1' }) });
    expect(wrongPassword.status).toBe(401);
    expect(await wrongPassword.json()).toMatchObject({error:'invalid_credentials'});
    const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'developer@kai.com', password:'Password123' }) });
    const { token } = await login.json() as { token: string };
    const topup = await fetch(`${base}/api/topups`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': 'test' }, body: JSON.stringify({ amountCents: 1000, channel: 'pilot' }) });
    expect(topup.status).toBe(403);
  });

  it('registers with an optional immutable invite binding and issues the 30-day trial once',async()=>{
    const {base,database}=await start();const email='developer@kai.com';const principal={userId:`usr_${createHash('sha256').update(email).digest('hex').slice(0,20)}`,tenantId:'tenant_kai_com',email,role:'member' as const};
    const inviter=await database.getReferralSummary(principal);
    const weak=await fetch(`${base}/api/auth/register`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'new@example.com',password:'short1'})});expect(weak.status).toBe(400);
    const optional=await fetch(`${base}/api/auth/register`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'unreferred@example.com',password:'Password123'})});expect(optional.status).toBe(201);expect(await optional.json()).toMatchObject({inviteCode:expect.stringMatching(/^KAI-/),referred:false});
    const invalidInvite=await fetch(`${base}/api/auth/register`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'new@example.com',password:'Password123',inviteCode:'KAI-NOTFOUND'})});expect(invalidInvite.status).toBe(400);
    const registration=await fetch(`${base}/api/auth/register`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'new@example.com',password:'Password123',inviteCode:inviter.inviteCode})});expect(registration.status).toBe(201);
    const registered=await registration.json() as {token:string;inviteCode:string;referred:boolean};expect(registered).toMatchObject({inviteCode:expect.stringMatching(/^KAI-/),referred:true});
    const credits=await (await fetch(`${base}/api/credit-packs`,{headers:{authorization:`Bearer ${registered.token}`}})).json() as {summary:{availableCents:number;grants:Array<{packId:string}>}};expect(credits.summary.availableCents).toBe(1000);expect(credits.summary.grants.filter((grant)=>grant.packId==='trial')).toHaveLength(1);
    const duplicate=await fetch(`${base}/api/auth/register`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'new@example.com',password:'AnotherPass123'})});expect(duplicate.status).toBe(409);
    expect((await database.getReferralSummary(principal)).referredUsers).toBe(1);
  });

  it('fails closed when registration or payment ordering is unavailable',async()=>{
    const disabled=await start({COD_REGISTRATION_ENABLED:'false'});
    const registration=await fetch(`${disabled.base}/api/auth/register`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'new@example.com',password:'Password123'})});
    expect(registration.status).toBe(503);expect(await registration.json()).toMatchObject({error:'registration_unavailable'});
    const {base}=await start({COD_INVITE_CODE_REQUIRED:'true'});
    const capabilities=await fetch(`${base}/api/capabilities`);expect(await capabilities.json()).toMatchObject({authentication:{inviteCodeOptional:true,inviteCodeRequired:false}});
    const login=await fetch(`${base}/api/auth/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'developer@kai.com',password:'Password123'})});
    const {token}=await login.json() as {token:string};
    const order=await fetch(`${base}/api/payment-orders`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json','idempotency-key':'unavailable-order'},body:JSON.stringify({amountCents:1200,channel:'wechat'})});
    expect(order.status).toBe(503);expect(await order.json()).toMatchObject({error:'payments_unavailable'});
  });

  it('reports integration capabilities and rejects invalid JSON and origins', async () => {
    const { base } = await start({ COD_ALLOWED_ORIGINS: 'https://cod.example' });
    const capabilities = await fetch(`${base}/api/capabilities`);
    expect(await capabilities.json()).toMatchObject({ authentication: { registrationEnabled: true, inviteCodeRequired: false }, ai: { mode: 'demo', streamingMode: 'buffered-sse' }, payments: { topupEnabled: false, orderApi: false } });
    const malformed = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ error: 'invalid_json' });
    const forbiddenOrigin = await fetch(`${base}/api/capabilities`, { headers: { origin: 'https://evil.example' } });
    expect(forbiddenOrigin.status).toBe(403);
    const allowedOrigin = await fetch(`${base}/api/capabilities`, { headers: { origin: 'https://cod.example' } });
    expect(allowedOrigin.headers.get('access-control-allow-origin')).toBe('https://cod.example');
  });

  it('publishes a read-only model price catalog without requiring a session', async () => {
    const { base } = await start();
    const response = await fetch(`${base}/api/model-catalog`);
    expect(response.status).toBe(200);
    const catalog = await response.json() as Array<{ id: string; callable: boolean; models: Array<{ id: string; inputPricePerMillionCents: number; outputPricePerMillionCents: number }> }>;
    expect(catalog).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'demo', callable: true })]));
    expect(catalog[0]?.models[0]).toEqual(expect.objectContaining({ id: expect.any(String), inputPricePerMillionCents: expect.any(Number), outputPricePerMillionCents: expect.any(Number) }));
    expect(JSON.stringify(catalog)).not.toMatch(/api[_-]?key|authorization|secret/i);
  });

  it('issues idempotent pilot wallet credit when the pilot preload is enabled', async () => {
    const { base } = await start({ COD_DEVELOPMENT_TOPUP_ENABLED: 'true' });
    const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'developer@kai.com',password:'Password123' }) });
    const { token } = await login.json() as { token: string };
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': 'pilot-credit-1' };
    const first = await fetch(`${base}/api/topups`, { method: 'POST', headers, body: JSON.stringify({ amountCents: 1000, channel: 'pilot' }) });
    const second = await fetch(`${base}/api/topups`, { method: 'POST', headers, body: JSON.stringify({ amountCents: 1000, channel: 'pilot' }) });
    expect(first.status).toBe(201); expect(second.status).toBe(201);
    expect((await first.json() as { account: { balanceCents: number } }).account.balanceCents).toBe(1000);
    const ledger = await (await fetch(`${base}/api/ledger`, { headers: { authorization: `Bearer ${token}` } })).json() as Array<{ paymentDirection: string }>;
    expect(ledger).toHaveLength(2); expect(ledger[0].paymentDirection).toBe('用户 → COD 钱包');
  });

  it('credits only signed, paid, idempotent payment callbacks', async () => {
    const secret = 'payment-secret';
    const { base } = await start({ COD_PAYMENT_WEBHOOK_SECRET: secret });
    const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'developer@kai.com',password:'Password123' }) });
    const { token } = await login.json() as { token: string };
    const orderResponse = await fetch(`${base}/api/payment-orders`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': 'checkout-1' }, body: JSON.stringify({ amountCents: 1200, channel: 'wechat' }) });
    expect(orderResponse.status).toBe(201);
    const order = await orderResponse.json() as { id: string; status: string };
    expect(order.status).toBe('pending');
    const body = JSON.stringify({ eventId: 'event-1', orderId: order.id, status: 'paid', amountCents: 1200, currency: 'CNY', channel: 'wechat', providerPaymentId: 'wx-1' });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
    const headers = { 'content-type': 'application/json', 'x-cod-timestamp': timestamp, 'x-cod-signature': signature };
    expect((await fetch(`${base}/api/webhooks/payments`, { method: 'POST', headers, body })).status).toBe(200);
    expect((await fetch(`${base}/api/webhooks/payments`, { method: 'POST', headers, body })).status).toBe(200);
    const account = await (await fetch(`${base}/api/account`, { headers: { authorization: `Bearer ${token}` } })).json() as { balanceCents: number };
    const ledger = await (await fetch(`${base}/api/ledger`, { headers: { authorization: `Bearer ${token}` } })).json() as unknown[];
    expect(account.balanceCents).toBe(1200);
    expect(ledger).toHaveLength(2);
    expect(await (await fetch(`${base}/api/payment-orders/${order.id}`, { headers: { authorization: `Bearer ${token}` } })).json()).toMatchObject({ status: 'paid', providerPaymentId: 'wx-1' });
    expect((await fetch(`${base}/api/webhooks/payments`, { method: 'POST', headers: { ...headers, 'x-cod-signature': '00' }, body })).status).toBe(401);
  });

  it('settles every non-stream demo request exactly once', async () => {
    const { base, database } = await start();
    const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'developer@kai.com',password:'Password123' }) });
    const { token, user } = await login.json() as { token: string; user: { id: string; email: string } };
    const response = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'coder-pro', messages: [{ role: 'user', content: 'hi' }], stream: false }) });
    expect(response.status).toBe(200);
    expect(await response.clone().json()).toMatchObject({ model: 'coder-pro', cod_mode: 'demo' });
    const secondResponse = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'coder-pro', messages: [{ role: 'user', content: 'again' }], stream: false }) });
    expect(secondResponse.status).toBe(200);
    const principal = { userId: user.id, tenantId: 'tenant_kai_com', email: user.email, role: 'member' as const };
    expect(await database.getLedger(principal)).toHaveLength(3);
    expect((await database.getAccount(principal)).balanceCents).toBe(0);
    expect((await database.getCreditSummary(principal)).availableCents).toBe(998);
    expect((await database.listAudit(principal, 10)).some((entry) => entry.action === 'chat.complete')).toBe(true);
  });

  it('commits the completion audit during settlement exactly once across a replay', async () => {
    const { base, database } = await start();
    const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'developer@kai.com', password: 'Password123' }) });
    const { token, user } = await login.json() as { token: string; user: { id: string; email: string } };
    const auditMethod = vi.spyOn(database, 'audit');
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-request-id': 'atomic-audit-test' };
    const body = JSON.stringify({ model: 'coder-pro', messages: [{ role: 'user', content: 'hi' }], stream: false });
    const first = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers, body });
    const replay = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers, body });
    expect(first.status).toBe(200);expect(replay.status).toBe(200);
    expect(await replay.clone().json()).toEqual(await first.clone().json());
    const principal = { userId: user.id, tenantId: 'tenant_kai_com', email: user.email, role: 'member' as const };
    expect(await database.getLedger(principal)).toHaveLength(2);
    expect((await database.getCreditSummary(principal)).availableCents).toBe(999);
    const completions=(await database.listAudit(principal,20)).filter((entry)=>entry.action==='chat.complete');
    expect(completions).toHaveLength(1);
    expect(completions[0]).toMatchObject({entityType:'model',entityId:'coder-pro',data:expect.objectContaining({taskId:null,requestedModel:'coder-pro',sourceId:'demo'})});
    expect(auditMethod.mock.calls.some(([,action])=>action==='chat.complete')).toBe(false);
  });

  it('replays a completed request without a second provider charge and rejects request-ID conflicts', async () => {
    const { base, database } = await start();
    const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'developer@kai.com', password: 'Password123' }) });
    const { token, user } = await login.json() as { token: string; user: { id: string; email: string } };
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-request-id': 'client-replay-id' };
    const body = JSON.stringify({ model: 'coder-pro', messages: [{ role: 'user', content: 'same request' }], stream: false });
    const first = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers, body });
    const second = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers, body });
    expect(first.status).toBe(200);expect(second.status).toBe(200);
    expect(await second.clone().json()).toEqual(await first.clone().json());
    expect(first.headers.get('x-request-id')).toBe('client-replay-id');
    expect(second.headers.get('x-request-id')).toBe('client-replay-id');
    const conflict=await fetch(`${base}/v1/chat/completions`,{method:'POST',headers,body:JSON.stringify({model:'coder-pro',messages:[{role:'user',content:'different request'}],stream:false})});
    expect(conflict.status).toBe(409);expect(await conflict.json()).toMatchObject({error:'idempotency_conflict'});
    const principal = { userId: user.id, tenantId: 'tenant_kai_com', email: user.email, role: 'member' as const };
    expect(await database.getLedger(principal)).toHaveLength(2);
    expect((await database.getCreditSummary(principal)).availableCents).toBe(999);
  });

  it('isolates upstream idempotency keys when two accounts reuse the same client request ID',async()=>{
    const upstreamKeys:string[]=[];
    const fetcher=vi.fn(async(input:RequestInfo|URL,init?:RequestInit):Promise<Response>=>{
      const url=String(input);
      if(url.endsWith('/api/pricing'))return Response.json({data:[{model_name:'shared-model',quota_type:0,model_ratio:1,completion_ratio:1,supported_endpoint_types:['openai']}]});
      if(url.endsWith('/api/status'))return Response.json({data:{quota_per_unit:500000,price:7}});
      if(url.endsWith('/models'))return Response.json({data:[{id:'shared-model'}]});
      if(url.endsWith('/chat/completions')){upstreamKeys.push(new Headers(init?.headers).get('idempotency-key')??'');return Response.json({choices:[{message:{role:'assistant',content:'isolated'},finish_reason:'stop'}],usage:{prompt_tokens:2,completion_tokens:1}});}
      throw new Error(`Unexpected provider request: ${url}`);
    });
    const {base}=await start({KAI_API_KEY:'test-key',KAI_AI_BASE_URL:'https://shared.example/v1',KAI_AI_CATALOG_URL:'https://shared.example/api/pricing',KAI_AI_STATUS_URL:'https://shared.example/api/status'},fetcher as typeof fetch);
    const login=await fetch(`${base}/api/auth/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'developer@kai.com',password:'Password123'})});const firstToken=(await login.json() as {token:string}).token;
    const registration=await fetch(`${base}/api/auth/register`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'second@example.com',password:'Password123'})});expect(registration.status).toBe(201);const secondToken=(await registration.json() as {token:string}).token;
    const body=JSON.stringify({source:'ai-kai',model:'shared-model',messages:[{role:'user',content:'same'}]});const request=(token:string)=>fetch(`${base}/v1/chat/completions`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json','x-request-id':'cross-account-replay'},body});
    expect((await request(firstToken)).status).toBe(200);expect((await request(secondToken)).status).toBe(200);expect((await request(firstToken)).status).toBe(200);
    expect(upstreamKeys).toHaveLength(2);expect(upstreamKeys.every((key)=>/^cod-[a-f0-9]{48}$/.test(key))).toBe(true);expect(new Set(upstreamKeys).size).toBe(2);
  });

  it('rejects a concurrent duplicate before a second upstream call and lets failed requests retry',async()=>{
    let providerStartedResolve:()=>void=()=>undefined;const providerStarted=new Promise<void>((resolve)=>{providerStartedResolve=resolve;});
    let providerResolve:(response:Response)=>void=()=>undefined;let chatCalls=0;
    const fetcher=vi.fn(async(input:RequestInfo|URL):Promise<Response>=>{
      const url=String(input);
      if(url.endsWith('/api/pricing'))return Response.json({data:[{model_name:'slow-model',quota_type:0,model_ratio:1,completion_ratio:1,supported_endpoint_types:['openai']}]});
      if(url.endsWith('/api/status'))return Response.json({data:{quota_per_unit:500000,price:7}});
      if(url.endsWith('/models'))return Response.json({data:[{id:'slow-model'}]});
      if(url.endsWith('/chat/completions')){chatCalls+=1;providerStartedResolve();return new Promise<Response>((resolve)=>{providerResolve=resolve;});}
      throw new Error(`Unexpected provider request: ${url}`);
    });
    const {base,database}=await start({KAI_API_KEY:'test-key',KAI_AI_BASE_URL:'https://provider.example/v1',KAI_AI_CATALOG_URL:'https://provider.example/api/pricing',KAI_AI_STATUS_URL:'https://provider.example/api/status'},fetcher as typeof fetch);
    const login=await fetch(`${base}/api/auth/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'developer@kai.com',password:'Password123'})});const {token,user}=await login.json() as {token:string;user:{id:string;email:string}};
    const headers={authorization:`Bearer ${token}`,'content-type':'application/json','x-request-id':'concurrent-chat'};const body=JSON.stringify({source:'ai-kai',model:'slow-model',messages:[{role:'user',content:'one at a time'}],stream:false});
    const firstPromise=fetch(`${base}/v1/chat/completions`,{method:'POST',headers,body});await providerStarted;
    const duplicate=await fetch(`${base}/v1/chat/completions`,{method:'POST',headers,body});expect(duplicate.status).toBe(409);expect(await duplicate.json()).toMatchObject({error:'chat_request_in_progress'});expect(chatCalls).toBe(1);
    providerResolve(Response.json({id:'chat-1',choices:[{message:{role:'assistant',content:'done'},finish_reason:'stop'}],usage:{prompt_tokens:4,completion_tokens:2}}));
    const first=await firstPromise;expect(first.status).toBe(200);expect(chatCalls).toBe(1);
    const principal={userId:user.id,tenantId:'tenant_kai_com',email:user.email,role:'member' as const};expect(await database.getLedger(principal)).toHaveLength(2);

    let retryCalls=0;const upstreamKeys:string[]=[];
    const retryFetcher=vi.fn(async(input:RequestInfo|URL,init?:RequestInit):Promise<Response>=>{
      const url=String(input);
      if(url.endsWith('/api/pricing'))return Response.json({data:[{model_name:'retry-model',quota_type:0,model_ratio:1,completion_ratio:1,supported_endpoint_types:['openai']}]});
      if(url.endsWith('/api/status'))return Response.json({data:{quota_per_unit:500000,price:7}});
      if(url.endsWith('/models'))return Response.json({data:[{id:'retry-model'}]});
      if(url.endsWith('/chat/completions')){retryCalls+=1;upstreamKeys.push(new Headers(init?.headers).get('idempotency-key')??'');return retryCalls<=2?Response.json({error:'temporary'},{status:503}):Response.json({id:'chat-retry',choices:[{message:{role:'assistant',content:'recovered'},finish_reason:'stop'}],usage:{prompt_tokens:4,completion_tokens:2}});}
      throw new Error(`Unexpected provider request: ${url}`);
    });
    const retryServer=await start({KAI_API_KEY:'test-key',KAI_AI_BASE_URL:'https://retry.example/v1',KAI_AI_CATALOG_URL:'https://retry.example/api/pricing',KAI_AI_STATUS_URL:'https://retry.example/api/status'},retryFetcher as typeof fetch);
    const retryLogin=await fetch(`${retryServer.base}/api/auth/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'developer@kai.com',password:'Password123'})});const retryToken=(await retryLogin.json() as {token:string}).token;
    const retryHeaders={authorization:`Bearer ${retryToken}`,'content-type':'application/json','x-request-id':'failed-then-retry'};const retryBody=JSON.stringify({source:'ai-kai',model:'retry-model',messages:[{role:'user',content:'retry'}]});
    expect((await fetch(`${retryServer.base}/v1/chat/completions`,{method:'POST',headers:retryHeaders,body:retryBody})).status).toBe(503);
    expect((await fetch(`${retryServer.base}/v1/chat/completions`,{method:'POST',headers:retryHeaders,body:retryBody})).status).toBe(200);expect(retryCalls).toBe(3);expect(upstreamKeys[0]).toMatch(/^cod-[a-f0-9]{48}$/);expect(new Set(upstreamKeys).size).toBe(1);
  });

  it('mints a 60-minute task-scoped Agent token and blocks every out-of-scope use',async()=>{
    const {base,database}=await start();const login=await fetch(`${base}/api/auth/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'developer@kai.com',password:'Password123'})});const {token,user}=await login.json() as {token:string;user:{id:string;email:string}};const full={authorization:`Bearer ${token}`,'content-type':'application/json'};
    const device=await (await fetch(`${base}/api/devices`,{method:'POST',headers:full,body:JSON.stringify({name:'Scoped Agent',platform:'macos'})})).json() as {id:string};
    const created=await (await fetch(`${base}/api/tasks`,{method:'POST',headers:full,body:JSON.stringify({title:'Scoped task',deviceId:device.id})})).json() as {id:string;version:number};
    const running=await (await fetch(`${base}/api/tasks/${created.id}/status`,{method:'POST',headers:full,body:JSON.stringify({status:'running',expectedVersion:created.version})})).json() as {version:number};
    const before=Date.now();const issuedResponse=await fetch(`${base}/api/agent-sessions`,{method:'POST',headers:full,body:JSON.stringify({taskId:created.id,sourceId:'demo',model:'coder-pro'})});expect(issuedResponse.status).toBe(201);
    const issued=await issuedResponse.json() as {token:string;expiresAt:string;scope:{taskId:string;sourceId:string;model:string}};expect(issued.scope).toEqual({taskId:created.id,sourceId:'demo',model:'coder-pro'});expect(new Date(issued.expiresAt).getTime()-before).toBeGreaterThan(59*60*1000);expect(new Date(issued.expiresAt).getTime()-before).toBeLessThanOrEqual(60*60*1000+1000);
    const agent={authorization:`Bearer ${issued.token}`,'content-type':'application/json'};
    expect((await fetch(`${base}/api/account`,{headers:agent})).status).toBe(403);
    expect((await fetch(`${base}/v1/tasks/${created.id}/sources/other/chat/completions`,{method:'POST',headers:agent,body:JSON.stringify({model:'coder-pro',messages:[{role:'user',content:'x'}]})})).status).toBe(403);
    const wrongModel=await fetch(`${base}/v1/tasks/${created.id}/sources/demo/chat/completions`,{method:'POST',headers:agent,body:JSON.stringify({model:'writer-pro',messages:[{role:'user',content:'x'}]})});expect(wrongModel.status).toBe(403);expect(await wrongModel.json()).toMatchObject({error:'agent_scope_forbidden'});
    const chatBody=JSON.stringify({model:'coder-pro',messages:[{role:'user',content:'scoped'}]});expect((await fetch(`${base}/v1/tasks/${created.id}/sources/demo/chat/completions`,{method:'POST',headers:agent,body:chatBody})).status).toBe(200);expect((await fetch(`${base}/v1/tasks/${created.id}/sources/demo/chat/completions`,{method:'POST',headers:agent,body:chatBody})).status).toBe(200);
    expect((await fetch(`${base}/api/account`,{headers:full})).status).toBe(200);
    const completed=await fetch(`${base}/api/tasks/${created.id}/status`,{method:'POST',headers:full,body:JSON.stringify({status:'complete',expectedVersion:running.version,result:'done'})});expect(completed.status).toBe(200);
    const terminal=await fetch(`${base}/v1/tasks/${created.id}/sources/demo/chat/completions`,{method:'POST',headers:agent,body:chatBody});expect(terminal.status).toBe(409);expect(await terminal.json()).toMatchObject({error:'task_not_running'});
    const principal={userId:user.id,tenantId:'tenant_kai_com',email:user.email,role:'member' as const};expect((await database.listAudit(principal,20)).some((entry)=>entry.action==='agent_session.issue')).toBe(true);expect(await database.getLedger(principal)).toHaveLength(2);
  });

  it('refuses responses above the 512 KiB durable-cache ceiling without charging',async()=>{
    let chatCalls=0;const huge='x'.repeat(512*1024);
    const fetcher=vi.fn(async(input:RequestInfo|URL):Promise<Response>=>{const url=String(input);if(url.endsWith('/api/pricing'))return Response.json({data:[{model_name:'large-model',quota_type:0,model_ratio:1,completion_ratio:1,supported_endpoint_types:['openai']}]});if(url.endsWith('/api/status'))return Response.json({data:{quota_per_unit:500000,price:7}});if(url.endsWith('/models'))return Response.json({data:[{id:'large-model'}]});if(url.endsWith('/chat/completions')){chatCalls+=1;return Response.json({choices:[{message:{role:'assistant',content:huge},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1}});}throw new Error(`Unexpected provider request: ${url}`);});
    const {base,database}=await start({KAI_API_KEY:'test-key',KAI_AI_BASE_URL:'https://large.example/v1',KAI_AI_CATALOG_URL:'https://large.example/api/pricing',KAI_AI_STATUS_URL:'https://large.example/api/status'},fetcher as typeof fetch);const login=await fetch(`${base}/api/auth/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'developer@kai.com',password:'Password123'})});const {token,user}=await login.json() as {token:string;user:{id:string;email:string}};const headers={authorization:`Bearer ${token}`,'content-type':'application/json','x-request-id':'large-response'};const body=JSON.stringify({source:'ai-kai',model:'large-model',messages:[{role:'user',content:'large'}]});
    const first=await fetch(`${base}/v1/chat/completions`,{method:'POST',headers,body});expect(first.status).toBe(502);expect(await first.json()).toMatchObject({error:'chat_response_cache_too_large'});
    const second=await fetch(`${base}/v1/chat/completions`,{method:'POST',headers,body});expect(second.status).toBe(502);expect(chatCalls).toBe(2);
    const principal={userId:user.id,tenantId:'tenant_kai_com',email:user.email,role:'member' as const};expect(await database.getLedger(principal)).toHaveLength(1);expect((await database.getCreditSummary(principal)).availableCents).toBe(1000);
  });

  it('serves billed desktop streaming requests as valid SSE and settles them once', async () => {
    const { base, database } = await start();
    const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'developer@kai.com',password:'Password123' }) });
    const { token, user } = await login.json() as { token: string; user: { id: string; email: string } };
    const response = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'coder-pro', messages: [{ role: 'user', content: 'stream this reply' }], stream: true }) });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(response.headers.get('x-accel-buffering')).toBe('no');
    const events=(await response.text()).split('\n\n').filter(Boolean);
    expect(events.at(-1)).toBe('data: [DONE]');
    const chunks=events.slice(0,-1).map((event)=>JSON.parse(event.replace(/^data: /,'')) as {object:string;choices:Array<{delta:{content?:string};finish_reason:string|null}>;usage?:{prompt_tokens:number;completion_tokens:number;total_tokens:number}});
    expect(chunks[0]).toMatchObject({object:'chat.completion.chunk',choices:[{delta:{role:'assistant',content:expect.any(String)},finish_reason:null}]});
    expect(chunks.at(-1)).toMatchObject({choices:[{delta:{},finish_reason:'stop'}],usage:{prompt_tokens:expect.any(Number),completion_tokens:expect.any(Number),total_tokens:expect.any(Number)}});
    const principal = { userId: user.id, tenantId: 'tenant_kai_com', email: user.email, role: 'member' as const };
    expect(await database.getLedger(principal)).toHaveLength(2);
    expect((await database.getCreditSummary(principal)).availableCents).toBe(999);
  });

  it('cancels an in-flight task, aborts its provider request, and restores the full reservation',async()=>{
    let markProviderStarted:()=>void=()=>undefined;const providerStarted=new Promise<void>((resolve)=>{markProviderStarted=resolve;});let providerAborted=false;
    const fetcher=vi.fn(async(input:RequestInfo|URL,init?:RequestInit):Promise<Response>=>{
      const url=String(input);
      if(url.endsWith('/api/pricing'))return Response.json({data:[{model_name:'slow-model',quota_type:0,model_ratio:1,completion_ratio:1,supported_endpoint_types:['openai']}]});
      if(url.endsWith('/api/status'))return Response.json({data:{quota_per_unit:500000,price:7}});
      if(url.endsWith('/models'))return Response.json({data:[{id:'slow-model'}]});
      if(url.endsWith('/chat/completions')){
        markProviderStarted();
        return new Promise<Response>((_resolve,reject)=>{const signal=init?.signal;if(signal?.aborted){providerAborted=true;reject(signal.reason);return;}signal?.addEventListener('abort',()=>{providerAborted=true;reject(signal.reason);},{once:true});});
      }
      throw new Error(`Unexpected provider request: ${url}`);
    });
    const {base,database}=await start({KAI_API_KEY:'test-key',KAI_AI_BASE_URL:'https://provider.example/v1',KAI_AI_CATALOG_URL:'https://provider.example/api/pricing',KAI_AI_STATUS_URL:'https://provider.example/api/status'},fetcher as typeof fetch);
    const login=await fetch(`${base}/api/auth/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'developer@kai.com',password:'Password123'})});
    const {token,user}=await login.json() as {token:string;user:{id:string;email:string}};const headers={authorization:`Bearer ${token}`,'content-type':'application/json'};
    const device=await (await fetch(`${base}/api/devices`,{method:'POST',headers,body:JSON.stringify({name:'Windows test',platform:'windows'})})).json() as {id:string};
    const created=await (await fetch(`${base}/api/tasks`,{method:'POST',headers,body:JSON.stringify({title:'取消慢任务',deviceId:device.id})})).json() as {id:string;version:number};
    const running=await (await fetch(`${base}/api/tasks/${created.id}/status`,{method:'POST',headers,body:JSON.stringify({status:'running',expectedVersion:created.version})})).json() as {version:number};
    const chat=fetch(`${base}/v1/chat/completions`,{method:'POST',headers,body:JSON.stringify({source:'ai-kai',model:'slow-model',task_id:created.id,messages:[{role:'user',content:'持续生成'}]})});
    await providerStarted;
    const cancelledResponse=await fetch(`${base}/api/tasks/${created.id}/cancel`,{method:'POST',headers,body:JSON.stringify({expectedVersion:running.version})});
    expect(cancelledResponse.status).toBe(200);expect(await cancelledResponse.json()).toMatchObject({task:{status:'cancelled',result:null,error:null},cancelledRequests:1});
    const chatResponse=await chat;expect(chatResponse.status).toBe(409);expect(await chatResponse.json()).toMatchObject({error:'task_cancelled'});expect(providerAborted).toBe(true);
    const principal={userId:user.id,tenantId:'tenant_kai_com',email:user.email,role:'member' as const};
    expect(await database.getLedger(principal)).toHaveLength(1);expect((await database.getCreditSummary(principal)).availableCents).toBe(1000);
    expect(await database.getTask(principal,created.id)).toMatchObject({status:'cancelled',result:null,error:null});expect((await database.listAudit(principal,20)).some((entry)=>entry.action==='task.cancel')).toBe(true);
  });

  it('does not abort or count a request whose settlement has already committed',async()=>{
    const {base,database}=await start();
    const login=await fetch(`${base}/api/auth/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'developer@kai.com',password:'Password123'})});
    const {token,user}=await login.json() as {token:string;user:{id:string;email:string}};const headers={authorization:`Bearer ${token}`,'content-type':'application/json'};
    const device=await (await fetch(`${base}/api/devices`,{method:'POST',headers,body:JSON.stringify({name:'Settlement race',platform:'web'})})).json() as {id:string};
    const created=await (await fetch(`${base}/api/tasks`,{method:'POST',headers,body:JSON.stringify({title:'结算竞态测试',deviceId:device.id})})).json() as {id:string;version:number};
    const running=await (await fetch(`${base}/api/tasks/${created.id}/status`,{method:'POST',headers,body:JSON.stringify({status:'running',expectedVersion:created.version})})).json() as {version:number};
    let markSettlementCommitted:()=>void=()=>undefined;const settlementCommitted=new Promise<void>((resolve)=>{markSettlementCommitted=resolve;});
    let releaseSettlementReturn:()=>void=()=>undefined;const settlementMayReturn=new Promise<void>((resolve)=>{releaseSettlementReturn=resolve;});
    const originalSettle=database.settleUsage.bind(database);
    vi.spyOn(database,'settleUsage').mockImplementation(async(...args)=>{const entry=await originalSettle(...args);markSettlementCommitted();await settlementMayReturn;return entry;});
    const chatPromise=fetch(`${base}/v1/tasks/${created.id}/sources/demo/chat/completions`,{method:'POST',headers,body:JSON.stringify({model:'coder-pro',messages:[{role:'user',content:'完成后立刻终止'}]})});
    await settlementCommitted;
    const cancelledResponse=await fetch(`${base}/api/tasks/${created.id}/cancel`,{method:'POST',headers,body:JSON.stringify({expectedVersion:running.version})});
    const cancelled=await cancelledResponse.json() as {task:{status:string};cancelledRequests:number};
    releaseSettlementReturn();
    const chat=await chatPromise;
    expect(cancelledResponse.status).toBe(200);expect(cancelled).toMatchObject({task:{status:'cancelled'},cancelledRequests:0});expect(chat.status).toBe(200);
    const principal={userId:user.id,tenantId:'tenant_kai_com',email:user.email,role:'member' as const};
    expect(await database.getLedger(principal)).toHaveLength(2);expect((await database.getCreditSummary(principal)).availableCents).toBe(999);
    expect((await database.listAudit(principal,20)).filter((entry)=>entry.action==='chat.complete')).toHaveLength(1);
  });

  it('enforces the 20000-token product limit at the billed gateway', async () => {
    const { base } = await start();
    const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'developer@kai.com',password:'Password123' }) });
    const { token } = await login.json() as { token: string };
    const request = (maxTokens: number) => fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'coder-pro', messages: [{ role: 'user', content: 'limit' }], max_tokens: maxTokens, stream: false }),
    });
    expect((await request(20_001)).status).toBe(400);
    expect((await request(20_000)).status).toBe(200);
  });

  it('exposes the credit pack catalog and purchases a pack from wallet exactly once', async()=>{
    const {base}=await start({COD_DEVELOPMENT_TOPUP_ENABLED:'true'});const login=await fetch(`${base}/api/auth/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'developer@kai.com',password:'Password123'})});const {token}=await login.json() as {token:string};const auth={authorization:`Bearer ${token}`,'content-type':'application/json'};
    await fetch(`${base}/api/topups`,{method:'POST',headers:{...auth,'idempotency-key':'pack-funds'},body:JSON.stringify({amountCents:10000,channel:'pilot'})});
    const catalog=await (await fetch(`${base}/api/credit-packs`,{headers:auth})).json() as {packs:Array<{id:string;validityDays:number}>;summary:{availableCents:number}};expect(catalog.packs).toHaveLength(4);expect(catalog.packs.every((pack)=>pack.validityDays===180)).toBe(true);expect(catalog.summary.availableCents).toBe(1000);
    const headers={...auth,'idempotency-key':'purchase-1'};const first=await fetch(`${base}/api/credit-packs/standard/purchase`,{method:'POST',headers});const second=await fetch(`${base}/api/credit-packs/standard/purchase`,{method:'POST',headers});expect(first.status).toBe(201);expect(second.status).toBe(201);const result=await first.json() as {account:{balanceCents:number};summary:{availableCents:number};grant:{expiresAt:string;purchasedAt:string}};expect(result.account.balanceCents).toBe(0);expect(result.summary.availableCents).toBe(11400);expect(Math.round((new Date(result.grant.expiresAt).getTime()-new Date(result.grant.purchasedAt).getTime())/86400000)).toBe(180);
  });

  it('binds desktop Agent requests to the source encoded in the gateway route', async () => {
    const { base } = await start();
    const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'developer@kai.com',password:'Password123' }) });
    const { token } = await login.json() as { token: string };
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const response = await fetch(`${base}/v1/sources/demo/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ model: 'coder-pro', messages: [{ role: 'user', content: 'desktop' }] }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ model: 'coder-pro', cod_source: 'demo', cod_payment_direction: '测试钱包 → COD Demo' });
    const device=await (await fetch(`${base}/api/devices`,{method:'POST',headers,body:JSON.stringify({name:'COD Desktop (windows)',platform:'windows'})})).json() as {id:string};const task=await (await fetch(`${base}/api/tasks`,{method:'POST',headers,body:JSON.stringify({title:'Desktop Agent',deviceId:device.id})})).json() as {id:string;version:number};const running=await (await fetch(`${base}/api/tasks/${task.id}/status`,{method:'POST',headers,body:JSON.stringify({status:'running',expectedVersion:task.version})})).json() as {version:number};
    const taskBound=await fetch(`${base}/v1/tasks/${task.id}/sources/demo/chat/completions`,{method:'POST',headers,body:JSON.stringify({model:'coder-pro',messages:[{role:'user',content:'desktop task'}]})});expect(taskBound.status).toBe(200);expect(await taskBound.json()).toMatchObject({model:'coder-pro',cod_source:'demo'});expect(running.version).toBe(2);
    const conflict = await fetch(`${base}/v1/sources/demo/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ source: 'other', model: 'coder-pro', messages: [{ role: 'user', content: 'desktop' }] }) });
    expect(conflict.status).toBe(400);
    expect(await conflict.json()).toMatchObject({ error: 'source_conflict' });
  });

  it('publishes H100 offers and stores validated compute-market requests idempotently', async () => {
    const { base, database } = await start();
    const offersResponse = await fetch(`${base}/api/compute/offers`);
    expect(offersResponse.status).toBe(200);
    const offers = await offersResponse.json() as Array<{ id: string; gpuModel: string; priceUnit: string }>;
    expect(offers).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'cod-h100-pcie-card-hour', gpuModel: expect.stringContaining('H100'), priceUnit: 'card-hour' })]));
    const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'developer@kai.com',password:'Password123' }) });
    const { token, user } = await login.json() as { token: string; user: { id: string; email: string } };
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': 'compute-rental-1' };
    const body = JSON.stringify({ kind: 'rental', offerId: 'cod-h100-pcie-card-hour', company: 'KAI 科技', contactName: 'Kai', contactPhone: '13800138000', city: '上海', gpuModel: 'NVIDIA H100 PCIe 80GB', quantity: 2, durationHours: 100, requirements: '用于模型微调' });
    const first = await fetch(`${base}/api/compute/requests`, { method: 'POST', headers, body });
    const second = await fetch(`${base}/api/compute/requests`, { method: 'POST', headers, body });
    expect(first.status).toBe(201); expect(second.status).toBe(201);
    const created = await first.json() as { id: string; status: string; quantity: number };
    expect(await second.json()).toMatchObject({ id: created.id });
    expect(created).toMatchObject({ status: 'submitted', quantity: 2 });
    const listed = await (await fetch(`${base}/api/compute/requests`, { headers: { authorization: `Bearer ${token}` } })).json() as Array<{ id: string }>;
    expect(listed).toHaveLength(1); expect(listed[0]?.id).toBe(created.id);
    const invalid = await fetch(`${base}/api/compute/requests`, { method: 'POST', headers: { ...headers, 'idempotency-key': 'compute-invalid' }, body: JSON.stringify({ ...JSON.parse(body), contactPhone: 'x' }) });
    expect(invalid.status).toBe(400);
    const wechat = await fetch(`${base}/api/compute/requests`, { method: 'POST', headers: { ...headers, 'idempotency-key': 'compute-wechat' }, body: JSON.stringify({ ...JSON.parse(body), contactPhone: 'kai_compute_2026' }) });
    expect(wechat.status).toBe(201);
    const principal = { userId: user.id, tenantId: 'tenant_kai_com', email: user.email, role: 'member' as const };
    expect((await database.listAudit(principal, 10)).some((entry) => entry.action === 'compute.request.created')).toBe(true);
  });

  it('exposes readiness, version, and Prometheus metrics', async () => {
    const { base } = await start();
    expect(await (await fetch(`${base}/ready`)).json()).toMatchObject({ status: 'ready', database: 'memory' });
    expect(await (await fetch(`${base}/version`)).json()).toHaveProperty('node');
    await fetch(`${base}/health`);
    const metrics = await (await fetch(`${base}/metrics`)).text();
    expect(metrics).toContain('cod_database_ready 1');
    expect(metrics).toContain('cod_http_requests_total');
  });
});
