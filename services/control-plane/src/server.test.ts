import { afterEach, describe, expect, it } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import { assistantContentFromResponse, assistantToolCallsFromResponse, createControlPlane, isValidChatMessage, usageFromResponse } from './server.js';
import { loadConfig } from './config.js';
import { MemoryDatabase } from './memory-database.js';

const servers: Array<ReturnType<typeof createControlPlane>> = [];
afterEach(async () => Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))));

async function start(overrides: Record<string, string> = {}) {
  const database = new MemoryDatabase();
  const email='developer@kai.com';
  await database.registerIdentity({userId:`usr_${createHash('sha256').update(email).digest('hex').slice(0,20)}`,tenantId:'tenant_kai_com',email,role:'member'},'scrypt$16384$8$1$dGVzdC1hdXRoLXNhbHQtMQ$OkZEwwvTyk_BXs8umIBKldU3L-Oit-AkHANDBB81kdN0CCW6-5kqg9cGUwmetGRwxs9g_NiohCkGSni7NtcayQ',null,false);
  const config = loadConfig({ NODE_ENV: 'test', COD_DEVELOPMENT_LOGIN_ENABLED: 'true', COD_DEVELOPMENT_LOGIN_EMAIL: 'developer@kai.com', COD_DEVELOPMENT_TOPUP_ENABLED: 'false', ...overrides });
  const server = createControlPlane({ config, database }); servers.push(server);
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
  });

  it('rejects empty assistant content before it can be settled as a successful reply', () => {
    expect(assistantContentFromResponse({ choices: [{ message: { content: '回答' } }] })).toBe('回答');
    expect(assistantContentFromResponse({ choices: [{ message: { content: [{ type: 'text', text: '分段回答' }] } }] })).toBe('分段回答');
    expect(assistantContentFromResponse({ choices: [{ message: { content: '   ' } }] })).toBeNull();
    expect(assistantContentFromResponse({ choices: [] })).toBeNull();
    expect(assistantToolCallsFromResponse({choices:[{message:{content:null,tool_calls:[{id:'call-1',type:'function',function:{name:'developer__file_write',arguments:'{"path":"game.html"}'}}]}}]})).toHaveLength(1);
    expect(assistantToolCallsFromResponse({choices:[{message:{tool_calls:[{id:'call-1',function:{name:'developer__file_write'}}]}}]})).toHaveLength(0);
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
    const invalidInvite=await fetch(`${base}/api/auth/register`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'new@example.com',password:'Password123',inviteCode:'KAI-NOTFOUND'})});expect(invalidInvite.status).toBe(400);
    const registration=await fetch(`${base}/api/auth/register`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'new@example.com',password:'Password123',inviteCode:inviter.inviteCode})});expect(registration.status).toBe(201);
    const registered=await registration.json() as {token:string;inviteCode:string;referred:boolean};expect(registered).toMatchObject({inviteCode:expect.stringMatching(/^KAI-/),referred:true});
    const credits=await (await fetch(`${base}/api/credit-packs`,{headers:{authorization:`Bearer ${registered.token}`}})).json() as {summary:{availableCents:number;grants:Array<{packId:string}>}};expect(credits.summary.availableCents).toBe(1000);expect(credits.summary.grants.filter((grant)=>grant.packId==='trial')).toHaveLength(1);
    const duplicate=await fetch(`${base}/api/auth/register`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'new@example.com',password:'AnotherPass123'})});expect(duplicate.status).toBe(409);
    expect((await database.getReferralSummary(principal)).referredUsers).toBe(1);
  });

  it('reports integration capabilities and rejects invalid JSON and origins', async () => {
    const { base } = await start({ COD_ALLOWED_ORIGINS: 'https://cod.example' });
    const capabilities = await fetch(`${base}/api/capabilities`);
    expect(await capabilities.json()).toMatchObject({ ai: { mode: 'demo' }, payments: { topupEnabled: false } });
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
