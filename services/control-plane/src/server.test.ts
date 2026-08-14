import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import { assistantContentFromResponse, assistantFinishReasonFromResponse, assistantToolCallsFromResponse, createControlPlane, isValidChatMessage, usageFromResponse } from './server.js';
import { loadConfig } from './config.js';
import { AiGateway } from './gateway.js';
import { MemoryDatabase } from './memory-database.js';
import { USAGE_RESERVATION_LEASE_DURATION_MS } from './database.js';

const servers: Array<ReturnType<typeof createControlPlane>> = [];
const testPasswordHash = 'scrypt$16384$8$1$dGVzdC1hdXRoLXNhbHQtMQ$OkZEwwvTyk_BXs8umIBKldU3L-Oit-AkHANDBB81kdN0CCW6-5kqg9cGUwmetGRwxs9g_NiohCkGSni7NtcayQ';
const taskClaim=(expectedVersion:number,marker='A')=>({status:'running' as const,expectedVersion,claimId:marker.repeat(43),leaseToken:(marker==='Z'?'Y':'Z').repeat(43)});
afterEach(async () => Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))));

async function start(overrides: Record<string, string> = {}, gatewayFetcher?:typeof fetch, database=new MemoryDatabase(), reservationKeepaliveIntervalMs?:number) {
  const email='developer@kai.com';
  await database.registerIdentity({userId:`usr_${createHash('sha256').update(email).digest('hex').slice(0,20)}`,tenantId:'tenant_kai_com',email,role:'member'},testPasswordHash,null,false);
  const config = loadConfig({ NODE_ENV: 'test', COD_DEMO_MODE: 'true', COD_DEVELOPMENT_LOGIN_ENABLED: 'true', COD_DEVELOPMENT_LOGIN_EMAIL: 'developer@kai.com', COD_DEVELOPMENT_TOPUP_ENABLED: 'false', ...overrides });
  const server = createControlPlane({ config, database, ...(gatewayFetcher?{gateway:new AiGateway(config,gatewayFetcher)}:{}), ...(reservationKeepaliveIntervalMs?{reservationKeepaliveIntervalMs}:{}) }); servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('missing address');
  return { base: `http://127.0.0.1:${address.port}`, database };
}

describe('control-plane production rules', () => {
  it('fails closed on incomplete production secrets and never enables direct production topups', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow('COD_SESSION_SECRET');
    const productionEnvironment: Record<string, string> = {
      NODE_ENV: 'production',
      COD_SESSION_SECRET: 's'.repeat(32),
      DATABASE_URL: 'postgresql://cod:test@127.0.0.1:5432/cod',
      KAI_API_KEY: 'provider-key',
      COD_DEVELOPMENT_LOGIN_ENABLED: 'true',
      COD_PILOT_ACCESS_CODE_HASH: 'a'.repeat(64),
      COD_DEVELOPMENT_TOPUP_ENABLED: 'true',
    };
    const config = loadConfig({ ...productionEnvironment, COD_COMPUTE_REVIEW_MODE: 'true' });
    expect(config.developmentTopupEnabled).toBe(false);
    expect(config.computeReviewMode).toBe(false);
    expect(config.computeMarketEnabled).toBe(false);
    expect(loadConfig({ ...productionEnvironment, COD_COMPUTE_MARKET_ENABLED: 'true' }).computeMarketEnabled).toBe(true);
    expect(config.registrationEnabled).toBe(false);
    expect(config.inviteCodeRequired).toBe(false);
    const internalBetaConfig=loadConfig({...productionEnvironment,COD_REGISTRATION_ENABLED:'true',COD_REGISTRATION_VERIFICATION_REQUIRED:'false'});
    expect(internalBetaConfig.registrationEnabled).toBe(true);
    expect(internalBetaConfig.registrationVerificationRequired).toBe(false);
    expect(loadConfig({ NODE_ENV: 'test' }).demoMode).toBe(false);
    expect(loadConfig({ NODE_ENV: 'test', COD_DEMO_MODE: 'false' }).demoMode).toBe(false);
    expect(loadConfig({ NODE_ENV: 'test', COD_DEMO_MODE: 'true' }).demoMode).toBe(true);

    for (const name of ['KAI_AI_BASE_URL', 'KAI_AI_CATALOG_URL', 'KAI_AI_STATUS_URL']) {
      expect(() => loadConfig({ ...productionEnvironment, [name]: 'http://ai.kai.com/insecure' })).toThrow(`${name} must use HTTPS in production`);
      expect(() => loadConfig({ ...productionEnvironment, [name]: 'https://unapproved.example/resource' })).toThrow(`${name} host is not allowed`);
    }
    expect(() => loadConfig({
      ...productionEnvironment,
      KAI_AI_ALLOWED_HOSTS: 'provider.example',
      KAI_AI_BASE_URL: 'https://provider.example/v1',
      KAI_AI_CATALOG_URL: 'https://provider.example/api/pricing',
      KAI_AI_STATUS_URL: 'https://provider.example/api/status',
    })).not.toThrow();
    expect(loadConfig({ NODE_ENV: 'test', KAI_AI_BASE_URL: 'http://127.0.0.1:9000/v1' }).modelSources[0]?.baseUrl).toBe('http://127.0.0.1:9000/v1');
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

  it('allows rate-limited email and password registration in explicit internal beta mode', async () => {
    const {base,database}=await start({COD_REGISTRATION_ENABLED:'true',COD_REGISTRATION_VERIFICATION_REQUIRED:'false'});
    const capabilities=await (await fetch(`${base}/api/capabilities`)).json();
    expect(capabilities).toMatchObject({authentication:{registrationEnabled:true,verificationMethods:[],registrationWebOnly:false,turnstileSiteKey:null}});
    const registration=await fetch(`${base}/api/auth/register`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'internal-beta@kai.com',password:'BetaPass123'})});
    expect(registration.status).toBe(201);
    expect(await registration.json()).toMatchObject({token:expect.any(String),user:{email:'internal-beta@kai.com'},referred:false});
    expect(await database.findIdentityByEmail('internal-beta@kai.com')).toMatchObject({phoneE164:null,emailVerifiedAt:null,phoneVerifiedAt:null});
    expect((await database.getCreditSummary({userId:`usr_${createHash('sha256').update('internal-beta@kai.com').digest('hex').slice(0,20)}`,tenantId:'tenant_kai_com',email:'internal-beta@kai.com',role:'member'})).grants).toHaveLength(1);
    const login=await fetch(`${base}/api/auth/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'internal-beta@kai.com',password:'BetaPass123'})});
    expect(login.status).toBe(200);
    const duplicate=await fetch(`${base}/api/auth/register`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'internal-beta@kai.com',password:'BetaPass123'})});
    expect(duplicate.status).toBe(409);
    const weak=await fetch(`${base}/api/auth/register`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'weak@kai.com',password:'123456'})});
    expect(weak.status).toBe(400);
    const outsideBeta=await fetch(`${base}/api/auth/register`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'outside@example.com',password:'BetaPass123'})});
    expect(outsideBeta.status).toBe(403);
  });

  it('revalidates the current role and identity before honoring an existing admin session', async () => {
    const { base, database } = await start();
    const adminEmail = 'role-admin@kai.com';
    const adminPrincipal = {
      userId: `usr_${createHash('sha256').update(adminEmail).digest('hex').slice(0, 20)}`,
      tenantId: 'tenant_kai_com',
      email: adminEmail,
      role: 'admin' as const,
    };
    await database.registerIdentity(adminPrincipal, testPasswordHash, null, false);

    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: adminEmail, password: 'Password123' }),
    });
    const { token } = await login.json() as { token: string };
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    expect(await (await fetch(`${base}/api/account`, { headers })).json()).toMatchObject({ role: 'admin', billingExempt: true });

    const usage = (idempotencyKey: string) => fetch(`${base}/api/usage`, {
      method: 'POST', headers, body: JSON.stringify({ idempotencyKey, taskId: 'admin-test', sourceId: 'demo', paymentDirection: 'test', model: 'coder-pro', inputTokens: 1, outputTokens: 1, costCents: 10 }),
    });
    const exempt = await usage('admin-before-demotion');
    expect(exempt.status).toBe(201);
    expect(await exempt.json()).toMatchObject({ entry: { amountCents: 0, paymentDirection: '管理员测试免计费' } });
    const malformed = await fetch(`${base}/api/usage`, {
      method: 'POST', headers, body: JSON.stringify({ idempotencyKey: 'invalid-admin-usage', taskId: 'admin-test', sourceId: 'demo', paymentDirection: 'test', model: 'coder-pro', inputTokens: -1, outputTokens: 1, costCents: 10 }),
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ error: 'invalid_usage' });

    const findIdentity = database.findIdentityByEmail.bind(database);
    const lookup = vi.spyOn(database, 'findIdentityByEmail').mockImplementation(async (email) => {
      const identity = await findIdentity(email);
      return identity?.principal.email === adminEmail
        ? { ...identity, principal: { ...identity.principal, role: 'member' } }
        : identity;
    });
    const demoted = await usage('admin-after-demotion');
    expect(demoted.status).toBe(403);
    expect(await demoted.json()).toMatchObject({ error: 'usage_forbidden' });
    expect(await (await fetch(`${base}/api/account`, { headers })).json()).toMatchObject({ role: 'member', billingExempt: false });
    const demotedAdminCompute=await fetch(`${base}/api/admin/compute/requests`,{headers});
    expect(demotedAdminCompute.status).toBe(403);expect(await demotedAdminCompute.json()).toMatchObject({error:'admin_required'});
    const billedChat = await fetch(`${base}/v1/sources/demo/chat/completions`, {
      method: 'POST', headers, body: JSON.stringify({ model: 'coder-pro', messages: [{ role: 'user', content: 'demoted billing check' }] }),
    });
    expect(billedChat.status).toBe(200);
    expect(await billedChat.json()).toMatchObject({ cod_charge_cents: 1, cod_payment_direction: '测试钱包 → COD Demo' });
    expect(await database.getCreditSummary(adminPrincipal)).toMatchObject({ availableCents: 999 });
    expect((await database.getLedger(adminPrincipal))[0]).toMatchObject({ type: 'usage', amountCents: -1, creditAmountCents: -1 });

    lookup.mockImplementation(async (email) => {
      const identity = await findIdentity(email);
      return identity?.principal.email === adminEmail
        ? { ...identity, principal: { ...identity.principal, userId: 'usr_reassigned' } }
        : identity;
    });
    const reassigned = await fetch(`${base}/api/account`, { headers });
    expect(reassigned.status).toBe(401);
    expect(await reassigned.json()).toEqual({ error: 'unauthorized' });
  });

  it('keeps member-owned resources private even from a billing-exempt admin who guesses every identifier', async () => {
    const { base, database } = await start({ COD_PAYMENT_WEBHOOK_SECRET: 'test-payment-adapter' });
    const memberLogin = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'developer@kai.com', password: 'Password123' }),
    });
    const memberToken = (await memberLogin.json() as { token: string }).token;
    const memberHeaders = { authorization: `Bearer ${memberToken}`, 'content-type': 'application/json' };
    const device = await (await fetch(`${base}/api/devices`, { method: 'POST', headers: memberHeaders, body: JSON.stringify({ name: 'Member workstation', platform: 'linux' }) })).json() as { id: string };
    const task = await (await fetch(`${base}/api/tasks`, { method: 'POST', headers: memberHeaders, body: JSON.stringify({ title: 'Member private task', deviceId: device.id }) })).json() as { id: string; version: number };
    const computeBody = { kind: 'rental', offerId: 'cod-h100-pcie-card-hour', company: 'Member Company', contactName: 'Member', contactPhone: '13800138000', city: '上海', gpuModel: 'NVIDIA H100 PCIe 80GB', quantity: 1, durationHours: 10, requirements: 'private requirement' };
    const compute = await (await fetch(`${base}/api/compute/requests`, { method: 'POST', headers: { ...memberHeaders, 'idempotency-key': 'member-compute' }, body: JSON.stringify(computeBody) })).json() as { id: string };
    const order = await (await fetch(`${base}/api/payment-orders`, { method: 'POST', headers: { ...memberHeaders, 'idempotency-key': 'member-order' }, body: JSON.stringify({ amountCents: 1200, channel: 'wechat' }) })).json() as { id: string };

    const adminEmail = 'isolation-admin@kai.com';
    const adminPrincipal = { userId: `usr_${createHash('sha256').update(adminEmail).digest('hex').slice(0, 20)}`, tenantId: 'tenant_kai_com', email: adminEmail, role: 'admin' as const };
    await database.registerIdentity(adminPrincipal, testPasswordHash, null, false);
    const adminLogin = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: adminEmail, password: 'Password123' }),
    });
    const adminToken = (await adminLogin.json() as { token: string }).token;
    const adminHeaders = { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' };
    expect(await (await fetch(`${base}/api/account`, { headers: adminHeaders })).json()).toMatchObject({ role: 'admin', billingExempt: true });

    const attacks = [
      fetch(`${base}/api/devices/${device.id}/heartbeat`, { method: 'POST', headers: adminHeaders }),
      fetch(`${base}/api/tasks`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ title: 'stolen device', deviceId: device.id }) }),
      fetch(`${base}/api/tasks/${task.id}/status`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ status: 'running', expectedVersion: task.version }) }),
      fetch(`${base}/api/tasks/${task.id}/cancel`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ expectedVersion: task.version }) }),
      fetch(`${base}/api/agent-sessions`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ taskId: task.id, executionId: '00000000-0000-4000-8000-000000000000', leaseToken: 'Z'.repeat(43), sourceId: 'demo', model: 'coder-pro' }) }),
      fetch(`${base}/v1/tasks/${task.id}/sources/demo/chat/completions`, { method: 'POST', headers: { ...adminHeaders, 'x-cod-task-execution': '00000000-0000-4000-8000-000000000000', 'x-cod-task-lease': 'Z'.repeat(43) }, body: JSON.stringify({ model: 'coder-pro', messages: [{ role: 'user', content: 'steal task' }] }) }),
      fetch(`${base}/api/payment-orders/${order.id}`, { headers: adminHeaders }),
    ];
    const attackResponses = await Promise.all(attacks);
    expect(attackResponses.map((response) => response.status)).toEqual([404, 404, 404, 404, 404, 404, 404]);
    expect(await (await fetch(`${base}/api/devices`, { headers: adminHeaders })).json()).toEqual([]);
    expect(await (await fetch(`${base}/api/tasks`, { headers: adminHeaders })).json()).toEqual([]);
    expect(await (await fetch(`${base}/api/events?cursor=0`, { headers: adminHeaders })).json()).toEqual([]);
    expect(await (await fetch(`${base}/api/compute/requests`, { headers: adminHeaders })).json()).toEqual([]);
    expect(JSON.stringify(await (await fetch(`${base}/api/audit`, { headers: adminHeaders })).json())).not.toContain(task.id);
    expect(JSON.stringify(await (await fetch(`${base}/api/ledger`, { headers: adminHeaders })).json())).not.toContain(order.id);

    expect(await database.getTask({ userId: (await database.findIdentityByEmail('developer@kai.com'))!.principal.userId, tenantId: 'tenant_kai_com', email: 'developer@kai.com', role: 'member' }, task.id)).toMatchObject({ status: 'draft', version: 1 });
    expect((await database.listComputeRequests({ userId: (await database.findIdentityByEmail('developer@kai.com'))!.principal.userId, tenantId: 'tenant_kai_com', email: 'developer@kai.com', role: 'member' })).map((item) => item.id)).toEqual([compute.id]);
    expect(await (await fetch(`${base}/api/payment-orders/${order.id}`, { headers: memberHeaders })).json()).toMatchObject({ id: order.id, status: 'pending' });
  });

  it('returns client errors for malformed device, task, status, and usage payloads', async () => {
    const { base, database } = await start({ COD_PAYMENT_WEBHOOK_SECRET: 'test-payment-adapter' });
    expect((await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'null' })).status).toBe(400);
    expect((await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'null' })).status).toBe(400);
    const adminEmail = 'validation-admin@kai.com';
    const adminPrincipal = { userId: `usr_${createHash('sha256').update(adminEmail).digest('hex').slice(0, 20)}`, tenantId: 'tenant_kai_com', email: adminEmail, role: 'admin' as const };
    await database.registerIdentity(adminPrincipal, testPasswordHash, null, false);
    const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: adminEmail, password: 'Password123' }) });
    const token = (await login.json() as { token: string }).token;
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

    const invalidDevice = await fetch(`${base}/api/devices`, { method: 'POST', headers, body: JSON.stringify({ name: 42, platform: 'linux' }) });
    const invalidTask = await fetch(`${base}/api/tasks`, { method: 'POST', headers, body: 'null' });
    const device = await (await fetch(`${base}/api/devices`, { method: 'POST', headers, body: JSON.stringify({ name: 'Validation device', platform: 'linux' }) })).json() as { id: string };
    const task = await (await fetch(`${base}/api/tasks`, { method: 'POST', headers, body: JSON.stringify({ title: 'Validation task', deviceId: device.id }) })).json() as { id: string };
    const invalidVersion = await fetch(`${base}/api/tasks/${task.id}/status`, { method: 'POST', headers, body: JSON.stringify({ status: 'running', expectedVersion: '1' }) });
    const invalidUsage = await fetch(`${base}/api/usage`, { method: 'POST', headers, body: 'null' });
    const invalidUsageKey = await fetch(`${base}/api/usage`, { method: 'POST', headers, body: JSON.stringify({ idempotencyKey: 42, taskId: 'test', sourceId: 'demo', paymentDirection: 'test', model: 'coder-pro', inputTokens: 1, outputTokens: 1, costCents: 1 }) });
    const invalidAgent = await fetch(`${base}/api/agent-sessions`, { method: 'POST', headers, body: 'null' });
    const invalidPayment = await fetch(`${base}/api/payment-orders`, { method: 'POST', headers: { ...headers, 'idempotency-key': 'malformed-payment' }, body: 'null' });
    const invalidPaymentAmount = await fetch(`${base}/api/payment-orders`, { method: 'POST', headers: { ...headers, 'idempotency-key': 'string-payment' }, body: JSON.stringify({ amountCents: '1200', channel: 'wechat' }) });
    const invalidPaymentChannel = await fetch(`${base}/api/payment-orders`, { method: 'POST', headers: { ...headers, 'idempotency-key': 'invalid-channel' }, body: JSON.stringify({ amountCents: 1200, channel: 'card' }) });
    const invalidCancel = await fetch(`${base}/api/tasks/${task.id}/cancel`, { method: 'POST', headers, body: 'null' });
    const invalidStatus = await fetch(`${base}/api/tasks/${task.id}/status`, { method: 'POST', headers, body: 'null' });
    const invalidChat = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers, body: 'null' });
    const invalidPath = await fetch(`${base}/api/products/%ZZ/launch`, { method: 'POST', headers });

    expect([invalidDevice, invalidTask, invalidVersion, invalidUsage, invalidUsageKey, invalidAgent, invalidPayment, invalidPaymentAmount, invalidPaymentChannel, invalidCancel, invalidStatus, invalidChat, invalidPath].map((response) => response.status)).toEqual(Array(13).fill(400));
    expect(await invalidDevice.json()).toMatchObject({ error: 'invalid_device' });
    expect(await invalidTask.json()).toMatchObject({ error: 'invalid_task' });
    expect(await invalidVersion.json()).toMatchObject({ error: 'invalid_task_version' });
    expect(await invalidUsage.json()).toMatchObject({ error: 'invalid_usage' });
    expect(await invalidUsageKey.json()).toMatchObject({ error: 'invalid_idempotency_key' });
    expect(await invalidPaymentAmount.json()).toMatchObject({ error: 'invalid_payment_amount' });
    expect(await invalidPaymentChannel.json()).toMatchObject({ error: 'invalid_payment_channel' });
    expect(await invalidPath.json()).toMatchObject({ error: 'invalid_path' });
  });

  it('does not expose the legacy email-and-password registration shortcut',async()=>{
    const {base,database}=await start();const email='developer@kai.com';const principal={userId:`usr_${createHash('sha256').update(email).digest('hex').slice(0,20)}`,tenantId:'tenant_kai_com',email,role:'member' as const};
    const direct=await fetch(`${base}/api/auth/register`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'new@example.com',password:'Password123'})});
    expect(direct.status).toBe(503);expect(await direct.json()).toMatchObject({error:'registration_unavailable'});expect(await database.findIdentityByEmail('new@example.com')).toBeNull();expect((await database.getReferralSummary(principal)).referredUsers).toBe(0);
  });

  it('allows only the configured passwordless pilot identity to migrate while public registration is closed', async () => {
    const legacyAccessCode = 'Legacy-Pilot-Code-2026';
    const configuredEmail = 'configured-pilot@kai.com';
    const { base, database } = await start({
      COD_REGISTRATION_ENABLED: 'false',
      COD_DEVELOPMENT_LOGIN_ENABLED: 'true',
      COD_DEVELOPMENT_LOGIN_EMAIL: configuredEmail,
      COD_PILOT_ACCESS_CODE_HASH: createHash('sha256').update(legacyAccessCode).digest('hex'),
    });
    const configuredPilot = {
      userId: `usr_${createHash('sha256').update(configuredEmail).digest('hex').slice(0, 20)}`,
      tenantId: 'tenant_kai_com',
      email: configuredEmail,
      role: 'member' as const,
    };
    const otherLegacyEmail = 'other-pilot@kai.com';
    const otherPilot = {
      userId: `usr_${createHash('sha256').update(otherLegacyEmail).digest('hex').slice(0, 20)}`,
      tenantId: 'tenant_kai_com',
      email: otherLegacyEmail,
      role: 'member' as const,
    };
    await database.ensurePrincipal(configuredPilot);
    await database.ensurePrincipal(otherPilot);

    const capabilitiesBefore = await (await fetch(`${base}/api/capabilities`)).json();
    expect(capabilitiesBefore).toMatchObject({ authentication: { registrationEnabled: false, legacyMigrationEnabled: true } });
    const migrate = (email: string, accessCode: string, password = 'MigratedPass123') => fetch(`${base}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password, legacyAccessCode: accessCode }),
    });

    const wrongCode = await migrate(configuredEmail, 'wrong-code');
    const arbitraryNewEmail = await migrate('new-pilot@kai.com', legacyAccessCode);
    const unconfiguredLegacy = await migrate(otherLegacyEmail, legacyAccessCode);
    expect([wrongCode.status, arbitraryNewEmail.status, unconfiguredLegacy.status]).toEqual([503, 503, 503]);
    for (const response of [wrongCode, arbitraryNewEmail, unconfiguredLegacy]) {
      expect(await response.json()).toMatchObject({ error: 'registration_unavailable' });
    }
    expect((await database.findIdentityByEmail(configuredEmail))?.passwordHash).toBeNull();
    expect((await database.findIdentityByEmail(otherLegacyEmail))?.passwordHash).toBeNull();
    expect(await database.findIdentityByEmail('new-pilot@kai.com')).toBeNull();

    const migrated = await migrate(configuredEmail, legacyAccessCode);
    expect(migrated.status).toBe(200);
    expect(await migrated.json()).toMatchObject({ user: { id: configuredPilot.userId, email: configuredEmail } });
    expect((await database.findIdentityByEmail(configuredEmail))?.passwordHash).toEqual(expect.any(String));
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: configuredEmail, password: 'MigratedPass123' }),
    });
    expect(login.status).toBe(200);
    expect(await login.json()).toMatchObject({ user: { id: configuredPilot.userId, email: configuredEmail } });
    expect(await (await fetch(`${base}/api/capabilities`)).json()).toMatchObject({ authentication: { registrationEnabled: false, legacyMigrationEnabled: false } });
    expect((await database.listAudit(configuredPilot, 20)).filter((entry) => entry.action === 'auth.legacy_migrated')).toHaveLength(1);

    const replay = await migrate(configuredEmail, legacyAccessCode, 'AnotherPass123');
    expect(replay.status).toBe(503);
    expect(await replay.json()).toMatchObject({ error: 'registration_unavailable' });
  });

  it('binds the one-time legacy access code to the configured pilot account',async()=>{
    const database=new MemoryDatabase();
    const configuredEmail='legacy-owner@kai.com';
    const otherEmail='legacy-other@kai.com';
    const principalFor=(email:string)=>({userId:`usr_${createHash('sha256').update(email).digest('hex').slice(0,20)}`,tenantId:'tenant_kai_com',email,role:'member' as const});
    await database.ensurePrincipal(principalFor(configuredEmail));
    await database.ensurePrincipal(principalFor(otherEmail));
    const identityBefore=await database.findIdentityByEmail(configuredEmail);
    const creditsBefore=await database.getCreditSummary(principalFor(configuredEmail));
    const legacyAccessCode='LegacyAccess123';
    const {base}=await start({
      COD_REGISTRATION_ENABLED:'false',
      COD_DEVELOPMENT_LOGIN_ENABLED:'true',
      COD_DEVELOPMENT_LOGIN_EMAIL:configuredEmail,
      COD_PILOT_ACCESS_CODE_HASH:createHash('sha256').update(legacyAccessCode).digest('hex'),
    },undefined,database);

    const capabilities=await fetch(`${base}/api/capabilities`);
    expect(await capabilities.json()).toMatchObject({authentication:{registrationEnabled:false,legacyMigrationEnabled:true}});

    const takeover=await fetch(`${base}/api/auth/register`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:otherEmail,password:'Password123',legacyAccessCode})});
    expect(takeover.status).toBe(503);
    expect(await takeover.json()).toMatchObject({error:'registration_unavailable'});

    const newAccount=await fetch(`${base}/api/auth/register`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'brand-new@kai.com',password:'Password123',legacyAccessCode})});
    expect(newAccount.status).toBe(503);
    expect(await newAccount.json()).toMatchObject({error:'registration_unavailable'});

    const wrongCode=await fetch(`${base}/api/auth/register`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:configuredEmail,password:'Password123',legacyAccessCode:'WrongLegacy123'})});
    expect(wrongCode.status).toBe(503);
    expect(await wrongCode.json()).toMatchObject({error:'registration_unavailable'});

    const migration=await fetch(`${base}/api/auth/register`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:configuredEmail,password:'Password123',legacyAccessCode})});
    expect(migration.status).toBe(200);
    const migratedCapabilities=await fetch(`${base}/api/capabilities`);
    expect(await migratedCapabilities.json()).toMatchObject({authentication:{registrationEnabled:false,legacyMigrationEnabled:false}});
    const identityAfter=await database.findIdentityByEmail(configuredEmail);
    const creditsAfter=await database.getCreditSummary(principalFor(configuredEmail));
    expect(identityAfter?.principal).toEqual(identityBefore?.principal);
    expect(identityAfter?.inviteCode).toBe(identityBefore?.inviteCode);
    expect(creditsAfter).toEqual(creditsBefore);
    const repeated=await fetch(`${base}/api/auth/register`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:configuredEmail,password:'AnotherPass123',legacyAccessCode})});
    expect(repeated.status).toBe(503);
    expect(await repeated.json()).toMatchObject({error:'registration_unavailable'});
    const login=await fetch(`${base}/api/auth/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:configuredEmail,password:'Password123'})});
    expect(login.status).toBe(200);
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
    expect(await capabilities.json()).toMatchObject({ authentication: { registrationEnabled: false, inviteCodeRequired: false, verificationMethods:['email_otp','sms_otp'],registrationWebOnly:true,publicRegistrationUrl:null }, ai: { mode: 'demo', streamingMode: 'buffered-sse' }, payments: { topupEnabled: false, orderApi: false } });
    const malformed = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ error: 'invalid_json' });
    const forbiddenOrigin = await fetch(`${base}/api/capabilities`, { headers: { origin: 'https://evil.example' } });
    expect(forbiddenOrigin.status).toBe(403);
    const allowedOrigin = await fetch(`${base}/api/capabilities`, { headers: { origin: 'https://cod.example' } });
    expect(allowedOrigin.headers.get('access-control-allow-origin')).toBe('https://cod.example');
  });

  it('mounts compute market V2, keeps production-safe defaults, and isolates review fixtures behind an explicit flag', async () => {
    const { base } = await start({ COD_ALLOWED_ORIGINS: 'https://cod.example' });
    const capabilities = await fetch(`${base}/api/compute/v2/capabilities`);
    expect(capabilities.status).toBe(200);
    expect(await capabilities.json()).toMatchObject({ enabled: false, instantPurchase: false, hosting: false, admin: false });

    const discovery = await start({ COD_COMPUTE_MARKET_ENABLED: 'true' });
    const discoveryCapabilities = await (await fetch(`${discovery.base}/api/compute/v2/capabilities`)).json();
    expect(discoveryCapabilities).toMatchObject({ enabled: true, instantPurchase: false, hosting: false, assets: false, admin: false });
    const discoveryHome = await (await fetch(`${discovery.base}/api/compute/v2/home`)).json() as { quickActions: string[]; featuredOffers: Array<{ title: string; providerName: string; skus: Array<{ period: string; priceCardHoursMilli: number | null }> }> };
    expect(discoveryHome.quickActions).toEqual(['offers']);
    expect(discoveryHome.featuredOffers.map((offer) => offer.title)).toEqual([
      'B300 / 288 GB',
      '1× H100 / 80 GB',
      '2× H100 / 80 GB',
      '4× H100 / 80 GB',
      '8× H100 / 80 GB',
      'L40S / 48 GB',
      'RTX 5090 / 32 GB',
    ]);
    expect(discoveryHome.featuredOffers.every((offer) => offer.providerName === 'COD 认证算力节点' && offer.skus[0]?.period === 'hour' && Number(offer.skus[0]?.priceCardHoursMilli) > 0)).toBe(true);

    const preflight = await fetch(`${base}/api/compute/v2/orders/order-id/quote-decision`, {
      method: 'OPTIONS',
      headers: { origin: 'https://cod.example', 'access-control-request-method': 'PATCH' },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-methods')).toContain('PATCH');

    const review = await start({ COD_COMPUTE_REVIEW_MODE: 'true' });
    const reviewCapabilities = await (await fetch(`${review.base}/api/compute/v2/capabilities`)).json();
    expect(reviewCapabilities).toMatchObject({ enabled: true, instantPurchase: false, reservationPurchase: false, hosting: true });
    const reviewHome = await (await fetch(`${review.base}/api/compute/v2/home`)).json() as { featuredOffers: Array<{ title: string; providerName: string; skus: Array<{ period: string }> }> };
    expect(reviewHome.featuredOffers[0]).toMatchObject({ title: expect.stringContaining('审核样例'), providerName: expect.stringContaining('非真实库存'), skus: [{ period: 'hour' }] });
  });

  it('rejects malformed UUID path parameters before they reach the database',async()=>{
    const {base}=await start();const login=await fetch(`${base}/api/auth/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'developer@kai.com',password:'Password123'})});const {token}=await login.json() as {token:string};const headers={authorization:`Bearer ${token}`,'content-type':'application/json'};const malformed='------------------------------------';
    const payment=await fetch(`${base}/api/payment-orders/${malformed}`,{headers});expect(payment.status).toBe(400);expect(await payment.json()).toMatchObject({error:'invalid_payment_order_id'});
    const heartbeat=await fetch(`${base}/api/devices/${malformed}/heartbeat`,{method:'POST',headers,body:'{}'});expect(heartbeat.status).toBe(400);expect(await heartbeat.json()).toMatchObject({error:'invalid_device_id'});
    const create=await fetch(`${base}/api/tasks`,{method:'POST',headers,body:JSON.stringify({title:'bad device',deviceId:malformed})});expect(create.status).toBe(400);expect(await create.json()).toMatchObject({error:'invalid_device_id'});
    const cancel=await fetch(`${base}/api/tasks/${malformed}/cancel`,{method:'POST',headers,body:JSON.stringify({expectedVersion:1})});expect(cancel.status).toBe(400);expect(await cancel.json()).toMatchObject({error:'invalid_task_id'});
    const status=await fetch(`${base}/api/tasks/${malformed}/status`,{method:'POST',headers,body:JSON.stringify({status:'running',expectedVersion:1,claimId:'A'.repeat(43),leaseToken:'B'.repeat(43)})});expect(status.status).toBe(400);expect(await status.json()).toMatchObject({error:'invalid_task_id'});
  });

  it('publishes a read-only model price catalog without requiring a session', async () => {
    const fetcher=vi.fn(async(input:string|URL|Request):Promise<Response>=>{
      const url=String(input);
      if(url.endsWith('/api/pricing'))return Response.json({data:[{model_name:'glm-5.2',quota_type:0,model_ratio:1,completion_ratio:2,supported_endpoint_types:['openai']}]});
      if(url.endsWith('/api/status'))return Response.json({data:{quota_per_unit:500_000,price:7}});
      if(url.endsWith('/models'))return Response.json({data:[{id:'glm-5.2'}]});
      throw new Error(`Unexpected request: ${url}`);
    });
    const { base } = await start({KAI_API_KEY:'test-key',TOKEN_RETAIL_COMMISSION_RATE_BPS:'375'},fetcher as typeof fetch);
    const response = await fetch(`${base}/api/model-catalog`);
    expect(response.status).toBe(200);
    const catalog = await response.json() as Array<{ id: string; callable: boolean; note:string; models: Array<{ id: string; inputPricePerMillionCents: number; outputPricePerMillionCents: number }> }>;
    expect(catalog).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'ai-kai', callable: true }),expect.objectContaining({id:'chase-kai',callable:true})]));
    expect(catalog.some((source)=>['authtest-kai','staging-pmai-kai'].includes(source.id))).toBe(false);
    expect(catalog[0]?.models[0]).toEqual(expect.objectContaining({ id: expect.any(String), inputPricePerMillionCents: expect.any(Number), outputPricePerMillionCents: expect.any(Number) }));
    expect(catalog.some((source)=>Object.prototype.hasOwnProperty.call(source,'commissionRateBps'))).toBe(false);
    expect(JSON.stringify(catalog)).not.toMatch(/api[_-]?key|authorization|secret|3\.75%|渠道分成|分成比例/i);

    const login=await fetch(`${base}/api/auth/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'developer@kai.com',password:'Password123'})});
    const {token}=await login.json() as {token:string};
    const internalSources=await (await fetch(`${base}/api/model-sources`,{headers:{authorization:`Bearer ${token}`}})).json() as Array<{id:string;commissionRateBps:number;note:string}>;
    expect(internalSources.some((source)=>['authtest-kai','staging-pmai-kai'].includes(source.id))).toBe(false);
    expect(internalSources.find((source)=>source.id==='chase-kai')).toMatchObject({commissionRateBps:375});
    expect(internalSources.find((source)=>source.id==='chase-kai')?.note).not.toContain('3.75%');
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
    const {base,database}=await start({KAI_API_KEY:'test-key',KAI_AI_BASE_URL:'https://shared.example/v1',KAI_AI_CATALOG_URL:'https://shared.example/api/pricing',KAI_AI_STATUS_URL:'https://shared.example/api/status'},fetcher as typeof fetch);
    const login=await fetch(`${base}/api/auth/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'developer@kai.com',password:'Password123'})});const firstToken=(await login.json() as {token:string}).token;
    const secondEmail='second@example.com';await database.registerIdentity({userId:`usr_${createHash('sha256').update(secondEmail).digest('hex').slice(0,20)}`,tenantId:'tenant_example_com',email:secondEmail,role:'member'},testPasswordHash,null,false);const secondLogin=await fetch(`${base}/api/auth/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:secondEmail,password:'Password123'})});expect(secondLogin.status).toBe(200);const secondToken=(await secondLogin.json() as {token:string}).token;
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

  it('maps upstream authentication failures to a sanitized gateway error',async()=>{
    let chatCalls=0;let upstreamBodyCancelled=false;
    const fetcher=vi.fn(async(input:RequestInfo|URL):Promise<Response>=>{
      const url=String(input);
      if(url.endsWith('/api/pricing'))return Response.json({data:[{model_name:'auth-fail-model',quota_type:0,model_ratio:1,completion_ratio:1,supported_endpoint_types:['openai']}]});
      if(url.endsWith('/api/status'))return Response.json({data:{quota_per_unit:500000,price:7}});
      if(url.endsWith('/models'))return Response.json({data:[{id:'auth-fail-model'}]});
      if(url.endsWith('/chat/completions')){chatCalls+=1;return new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('{"error":"invalid_api_key","secretDetail":"must-not-leak"}'));},cancel(){upstreamBodyCancelled=true;}}),{status:401,headers:{'content-type':'application/json'}});}
      throw new Error(`Unexpected provider request: ${url}`);
    });
    const {base}=await start({KAI_API_KEY:'test-key'},fetcher as typeof fetch);
    const login=await fetch(`${base}/api/auth/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'developer@kai.com',password:'Password123'})});
    const {token}=await login.json() as {token:string};
    const response=await fetch(`${base}/v1/chat/completions`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({source:'ai-kai',model:'auth-fail-model',messages:[{role:'user',content:'hello'}]})});
    expect(response.status).toBe(502);
    const body=await response.json();
    expect(body).toEqual({error:'ai_upstream_auth_failed',message:'KAI model provider authentication failed'});
    expect(JSON.stringify(body)).not.toContain('must-not-leak');
    expect(chatCalls).toBe(1);
    expect(upstreamBodyCancelled).toBe(true);
    expect((await fetch(`${base}/api/account`,{headers:{authorization:`Bearer ${token}`}})).status).toBe(200);
  });

  it('mints a 60-minute task-scoped Agent token and blocks every out-of-scope use',async()=>{
    const {base,database}=await start();const login=await fetch(`${base}/api/auth/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'developer@kai.com',password:'Password123'})});const {token,user}=await login.json() as {token:string;user:{id:string;email:string}};const full={authorization:`Bearer ${token}`,'content-type':'application/json'};
    const device=await (await fetch(`${base}/api/devices`,{method:'POST',headers:full,body:JSON.stringify({name:'Scoped Agent',platform:'macos'})})).json() as {id:string};
    const created=await (await fetch(`${base}/api/tasks`,{method:'POST',headers:full,body:JSON.stringify({title:'Scoped task',deviceId:device.id})})).json() as {id:string;version:number};
    const running=await (await fetch(`${base}/api/tasks/${created.id}/status`,{method:'POST',headers:full,body:JSON.stringify(taskClaim(created.version,'A'))})).json() as {version:number;execution:{executionId:string;leaseToken:string}};
    const before=Date.now();const issuedResponse=await fetch(`${base}/api/agent-sessions`,{method:'POST',headers:full,body:JSON.stringify({taskId:created.id,...running.execution,sourceId:'demo',model:'coder-pro'})});expect(issuedResponse.status).toBe(201);
    const issued=await issuedResponse.json() as {token:string;expiresAt:string;scope:{taskId:string;executionId:string;sourceId:string;model:string}};expect(issued.scope).toEqual({taskId:created.id,executionId:running.execution.executionId,sourceId:'demo',model:'coder-pro'});expect(new Date(issued.expiresAt).getTime()-before).toBeGreaterThan(59*60*1000);expect(new Date(issued.expiresAt).getTime()-before).toBeLessThanOrEqual(60*60*1000+1000);
    const agent={authorization:`Bearer ${issued.token}`,'content-type':'application/json'};
    expect((await fetch(`${base}/api/account`,{headers:agent})).status).toBe(403);
    expect((await fetch(`${base}/api/admin/compute/requests`,{headers:agent})).status).toBe(403);
    expect((await fetch(`${base}/v1/tasks/${created.id}/sources/other/chat/completions`,{method:'POST',headers:agent,body:JSON.stringify({model:'coder-pro',messages:[{role:'user',content:'x'}]})})).status).toBe(403);
    const wrongModel=await fetch(`${base}/v1/tasks/${created.id}/sources/demo/chat/completions`,{method:'POST',headers:agent,body:JSON.stringify({model:'writer-pro',messages:[{role:'user',content:'x'}]})});expect(wrongModel.status).toBe(403);expect(await wrongModel.json()).toMatchObject({error:'agent_scope_forbidden'});
    const chatBody=JSON.stringify({model:'coder-pro',messages:[{role:'user',content:'scoped'}]});expect((await fetch(`${base}/v1/tasks/${created.id}/sources/demo/chat/completions`,{method:'POST',headers:agent,body:chatBody})).status).toBe(200);expect((await fetch(`${base}/v1/tasks/${created.id}/sources/demo/chat/completions`,{method:'POST',headers:agent,body:chatBody})).status).toBe(200);
    expect((await fetch(`${base}/api/account`,{headers:full})).status).toBe(200);
    const completed=await fetch(`${base}/api/tasks/${created.id}/status`,{method:'POST',headers:full,body:JSON.stringify({status:'complete',expectedVersion:running.version,result:'done',...running.execution})});expect(completed.status).toBe(200);
    const terminal=await fetch(`${base}/v1/tasks/${created.id}/sources/demo/chat/completions`,{method:'POST',headers:agent,body:chatBody});expect(terminal.status).toBe(409);expect(await terminal.json()).toMatchObject({error:'task_lease_expired'});
    const principal={userId:user.id,tenantId:'tenant_kai_com',email:user.email,role:'member' as const};expect((await database.listAudit(principal,20)).some((entry)=>entry.action==='agent_session.issue')).toBe(true);expect(await database.getLedger(principal)).toHaveLength(2);
  });

  it('recovers the same execution when the committed claim response is retried',async()=>{
    const {base,database}=await start();const login=await fetch(`${base}/api/auth/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'developer@kai.com',password:'Password123'})});const {token,user}=await login.json() as {token:string;user:{id:string;email:string}};const headers={authorization:`Bearer ${token}`,'content-type':'application/json'};const principal={userId:user.id,tenantId:'tenant_kai_com',email:user.email,role:'member' as const};
    const device=await (await fetch(`${base}/api/devices`,{method:'POST',headers,body:JSON.stringify({name:'Claim retry',platform:'macos'})})).json() as {id:string};const task=await (await fetch(`${base}/api/tasks`,{method:'POST',headers,body:JSON.stringify({title:'Recover lost response',deviceId:device.id})})).json() as {id:string;version:number};const claim=taskClaim(task.version,'R');
    const firstResponse=await fetch(`${base}/api/tasks/${task.id}/status`,{method:'POST',headers,body:JSON.stringify(claim)});expect(firstResponse.status).toBe(200);const first=await firstResponse.json() as {version:number;execution:{executionId:string;leaseToken:string;leaseExpiresAt:string}};const cursor=(await database.eventsAfter(principal,0)).at(-1)!.cursor;const auditBefore=(await database.listAudit(principal,200)).length;
    const replayResponse=await fetch(`${base}/api/tasks/${task.id}/status`,{method:'POST',headers,body:JSON.stringify(claim)});expect(replayResponse.status).toBe(200);const replay=await replayResponse.json() as typeof first;
    expect(replay).toMatchObject({version:first.version,execution:first.execution});expect(await database.eventsAfter(principal,cursor)).toHaveLength(0);expect(await database.listAudit(principal,200)).toHaveLength(auditBefore);
    const competing=await fetch(`${base}/api/tasks/${task.id}/status`,{method:'POST',headers,body:JSON.stringify(taskClaim(task.version,'S'))});expect(competing.status).toBe(409);expect(await competing.json()).toMatchObject({error:'task_already_running'});
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

  it('aborts a taskless provider request and releases its reservation when the client disconnects', async () => {
    let markProviderStarted: () => void = () => undefined;
    const providerStarted = new Promise<void>((resolve) => { markProviderStarted = resolve; });
    let markProviderAborted: () => void = () => undefined;
    const providerAborted = new Promise<void>((resolve) => { markProviderAborted = resolve; });
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url.endsWith('/api/pricing')) return Response.json({ data: [{ model_name: 'slow-model', quota_type: 0, model_ratio: 1, completion_ratio: 1, supported_endpoint_types: ['openai'] }] });
      if (url.endsWith('/api/status')) return Response.json({ data: { quota_per_unit: 500000, price: 7 } });
      if (url.endsWith('/models')) return Response.json({ data: [{ id: 'slow-model' }] });
      if (url.endsWith('/chat/completions')) {
        markProviderStarted();
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          const abort = () => {
            markProviderAborted();
            reject(signal?.reason);
          };
          if (signal?.aborted) abort();
          else signal?.addEventListener('abort', abort, { once: true });
        });
      }
      throw new Error(`Unexpected provider request: ${url}`);
    });
    const { base, database } = await start({
      KAI_API_KEY: 'test-key',
      KAI_AI_BASE_URL: 'https://provider.example/v1',
      KAI_AI_CATALOG_URL: 'https://provider.example/api/pricing',
      KAI_AI_STATUS_URL: 'https://provider.example/api/status',
    }, fetcher as typeof fetch);
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'developer@kai.com', password: 'Password123' }),
    });
    const { token, user } = await login.json() as { token: string; user: { id: string; email: string } };
    const client = new AbortController();
    const chat = fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-request-id': 'taskless-client-disconnect' },
      body: JSON.stringify({ source: 'ai-kai', model: 'slow-model', messages: [{ role: 'user', content: 'disconnect me' }] }),
      signal: client.signal,
    });

    await providerStarted;
    client.abort();
    await expect(chat).rejects.toThrow();
    await providerAborted;

    const principal = { userId: user.id, tenantId: 'tenant_kai_com', email: user.email, role: 'member' as const };
    await vi.waitFor(async () => {
      expect((await database.getCreditSummary(principal)).availableCents).toBe(1000);
      expect(await database.getLedger(principal)).toHaveLength(1);
    });
    expect((await database.listAudit(principal, 20)).filter((entry) => entry.action === 'chat.complete')).toHaveLength(0);
  });

  it('does not call or charge the provider when a taskless client disconnects during preflight', async () => {
    let releaseModelLookup: () => void = () => undefined;
    const modelLookupGate = new Promise<void>((resolve) => { releaseModelLookup = resolve; });
    let markPreflightStarted: () => void = () => undefined;
    const preflightStarted = new Promise<void>((resolve) => { markPreflightStarted = resolve; });
    let providerCalls = 0;
    const fetcher = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.endsWith('/api/pricing')) return Response.json({ data: [{ model_name: 'slow-model', quota_type: 0, model_ratio: 1, completion_ratio: 1, supported_endpoint_types: ['openai'] }] });
      if (url.endsWith('/api/status')) return Response.json({ data: { quota_per_unit: 500000, price: 7 } });
      if (url.endsWith('/models')) {
        markPreflightStarted();
        await modelLookupGate;
        return Response.json({ data: [{ id: 'slow-model' }] });
      }
      if (url.endsWith('/chat/completions')) {
        providerCalls += 1;
        return Response.json({ choices: [{ message: { role: 'assistant', content: 'too late' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
      }
      throw new Error(`Unexpected provider request: ${url}`);
    });
    const { base, database } = await start({
      KAI_API_KEY: 'test-key',
      KAI_AI_BASE_URL: 'https://preflight.example/v1',
      KAI_AI_CATALOG_URL: 'https://preflight.example/api/pricing',
      KAI_AI_STATUS_URL: 'https://preflight.example/api/status',
    }, fetcher as typeof fetch);
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'developer@kai.com', password: 'Password123' }),
    });
    const { token, user } = await login.json() as { token: string; user: { id: string; email: string } };
    const client = new AbortController();
    const chat = fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-request-id': 'early-taskless-disconnect' },
      body: JSON.stringify({ source: 'ai-kai', model: 'slow-model', messages: [{ role: 'user', content: 'stop during preflight' }] }),
      signal: client.signal,
    });

    await preflightStarted;
    client.abort();
    await expect(chat).rejects.toThrow();
    releaseModelLookup();

    const principal = { userId: user.id, tenantId: 'tenant_kai_com', email: user.email, role: 'member' as const };
    await vi.waitFor(async () => {
      expect(providerCalls).toBe(0);
      expect((await database.getCreditSummary(principal)).availableCents).toBe(1000);
      expect(await database.getLedger(principal)).toHaveLength(1);
    });
    expect((await database.listAudit(principal, 20)).filter((entry) => entry.action === 'chat.complete')).toHaveLength(0);
  });

  it('renews a reservation during a slow upstream call and stops renewing before settlement',async()=>{
    const database=new MemoryDatabase();const originalRenew=database.renewUsageReservation.bind(database);const originalSettle=database.settleUsage.bind(database);let renewals=0;let leaseRemainingAtSettlement=0;
    vi.spyOn(database,'renewUsageReservation').mockImplementation(async(...args)=>{renewals+=1;await originalRenew(...args);});
    vi.spyOn(database,'settleUsage').mockImplementation(async(...args)=>{const states=(database as unknown as {users:Map<string,{reservations:Map<string,{leaseExpiresAt:number}>}>}).users;const reservation=[...states.values()].flatMap((state)=>[...state.reservations.entries()]).find(([id])=>id===args[1])?.[1];leaseRemainingAtSettlement=(reservation?.leaseExpiresAt??0)-Date.now();return originalSettle(...args);});
    let markProviderStarted:()=>void=()=>undefined;const providerStarted=new Promise<void>((resolve)=>{markProviderStarted=resolve;});let releaseProvider:()=>void=()=>undefined;
    const fetcher=vi.fn(async(input:RequestInfo|URL):Promise<Response>=>{const url=String(input);if(url.endsWith('/api/pricing'))return Response.json({data:[{model_name:'lease-model',quota_type:0,model_ratio:1,completion_ratio:1,supported_endpoint_types:['openai']}]});if(url.endsWith('/api/status'))return Response.json({data:{quota_per_unit:500000,price:7}});if(url.endsWith('/models'))return Response.json({data:[{id:'lease-model'}]});if(url.endsWith('/chat/completions')){markProviderStarted();return new Promise<Response>((resolve)=>{releaseProvider=()=>resolve(Response.json({choices:[{message:{role:'assistant',content:'lease kept alive'},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1}}));});}throw new Error(`Unexpected provider request: ${url}`);});
    const {base}=await start({KAI_API_KEY:'test-key',KAI_AI_BASE_URL:'https://lease.example/v1',KAI_AI_CATALOG_URL:'https://lease.example/api/pricing',KAI_AI_STATUS_URL:'https://lease.example/api/status'},fetcher as typeof fetch,database,5);
    const login=await fetch(`${base}/api/auth/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'developer@kai.com',password:'Password123'})});const {token,user}=await login.json() as {token:string;user:{id:string;email:string}};
    const chat=fetch(`${base}/v1/chat/completions`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json','x-request-id':'lease-success'},body:JSON.stringify({source:'ai-kai',model:'lease-model',messages:[{role:'user',content:'wait'}]})});
    await providerStarted;await vi.waitFor(()=>expect(renewals).toBeGreaterThan(0));releaseProvider();const response=await chat;expect(response.status).toBe(200);
    expect(leaseRemainingAtSettlement).toBeGreaterThan(USAGE_RESERVATION_LEASE_DURATION_MS-1000);
    const renewalsAfterSettlement=renewals;await new Promise((resolve)=>setTimeout(resolve,20));expect(renewals).toBe(renewalsAfterSettlement);
    const principal={userId:user.id,tenantId:'tenant_kai_com',email:user.email,role:'member' as const};expect(await database.getLedger(principal)).toHaveLength(2);expect((await database.getCreditSummary(principal)).availableCents).toBe(999);
  });

  it('aborts and refunds an in-flight model call when reservation renewal fails',async()=>{
    const database=new MemoryDatabase();let renewalAttempts=0;
    vi.spyOn(database,'renewUsageReservation').mockImplementation(async()=>{renewalAttempts+=1;throw new Error('database password=do-not-expose');});
    let markProviderStarted:()=>void=()=>undefined;const providerStarted=new Promise<void>((resolve)=>{markProviderStarted=resolve;});let providerAborted=false;
    const fetcher=vi.fn(async(input:RequestInfo|URL,init?:RequestInit):Promise<Response>=>{const url=String(input);if(url.endsWith('/api/pricing'))return Response.json({data:[{model_name:'lease-fail-model',quota_type:0,model_ratio:1,completion_ratio:1,supported_endpoint_types:['openai']}]});if(url.endsWith('/api/status'))return Response.json({data:{quota_per_unit:500000,price:7}});if(url.endsWith('/models'))return Response.json({data:[{id:'lease-fail-model'}]});if(url.endsWith('/chat/completions')){markProviderStarted();return new Promise<Response>((_resolve,reject)=>{const signal=init?.signal;if(signal?.aborted){providerAborted=true;reject(signal.reason);return;}signal?.addEventListener('abort',()=>{providerAborted=true;reject(signal.reason);},{once:true});});}throw new Error(`Unexpected provider request: ${url}`);});
    const errorLog=vi.spyOn(console,'error').mockImplementation(()=>undefined);
    const {base}=await start({KAI_API_KEY:'test-key',KAI_AI_BASE_URL:'https://lease-fail.example/v1',KAI_AI_CATALOG_URL:'https://lease-fail.example/api/pricing',KAI_AI_STATUS_URL:'https://lease-fail.example/api/status'},fetcher as typeof fetch,database,5);
    const login=await fetch(`${base}/api/auth/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'developer@kai.com',password:'Password123'})});const {token,user}=await login.json() as {token:string;user:{id:string;email:string}};
    const chat=fetch(`${base}/v1/chat/completions`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json','x-request-id':'lease-failure'},body:JSON.stringify({source:'ai-kai',model:'lease-fail-model',messages:[{role:'user',content:'wait'}]})});
    await providerStarted;const response=await chat;expect(response.status).toBe(503);const failure=await response.json() as {error:string;message:string};expect(failure).toEqual({error:'reservation_lease_renewal_failed',message:'Usage reservation lease renewal failed'});expect(JSON.stringify(failure)).not.toContain('do-not-expose');expect(providerAborted).toBe(true);expect(renewalAttempts).toBe(1);
    await new Promise((resolve)=>setTimeout(resolve,20));expect(renewalAttempts).toBe(1);
    const principal={userId:user.id,tenantId:'tenant_kai_com',email:user.email,role:'member' as const};expect(await database.getLedger(principal)).toHaveLength(1);expect((await database.getCreditSummary(principal)).availableCents).toBe(1000);
    const metrics=await (await fetch(`${base}/metrics`)).text();expect(metrics).toMatch(/cod_usage_reservation_lease_failures_total [1-9]\d*/);expect(errorLog).toHaveBeenCalledWith(expect.stringContaining('"event":"usage.reservation.renew_failed"'));errorLog.mockRestore();
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
    const running=await (await fetch(`${base}/api/tasks/${created.id}/status`,{method:'POST',headers,body:JSON.stringify(taskClaim(created.version,'B'))})).json() as {version:number;execution:{executionId:string;leaseToken:string}};const executionHeaders={...headers,'x-cod-task-execution':running.execution.executionId,'x-cod-task-lease':running.execution.leaseToken};
    const chat=fetch(`${base}/v1/chat/completions`,{method:'POST',headers:executionHeaders,body:JSON.stringify({source:'ai-kai',model:'slow-model',task_id:created.id,messages:[{role:'user',content:'持续生成'}]})});
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
    const running=await (await fetch(`${base}/api/tasks/${created.id}/status`,{method:'POST',headers,body:JSON.stringify(taskClaim(created.version,'C'))})).json() as {version:number;execution:{executionId:string;leaseToken:string}};const executionHeaders={...headers,'x-cod-task-execution':running.execution.executionId,'x-cod-task-lease':running.execution.leaseToken};
    let markSettlementCommitted:()=>void=()=>undefined;const settlementCommitted=new Promise<void>((resolve)=>{markSettlementCommitted=resolve;});
    let releaseSettlementReturn:()=>void=()=>undefined;const settlementMayReturn=new Promise<void>((resolve)=>{releaseSettlementReturn=resolve;});
    const originalSettle=database.settleUsage.bind(database);
    vi.spyOn(database,'settleUsage').mockImplementation(async(...args)=>{const entry=await originalSettle(...args);markSettlementCommitted();await settlementMayReturn;return entry;});
    const chatPromise=fetch(`${base}/v1/tasks/${created.id}/sources/demo/chat/completions`,{method:'POST',headers:executionHeaders,body:JSON.stringify({model:'coder-pro',messages:[{role:'user',content:'完成后立刻终止'}]})});
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
    const device=await (await fetch(`${base}/api/devices`,{method:'POST',headers,body:JSON.stringify({name:'COD Desktop (windows)',platform:'windows'})})).json() as {id:string};const task=await (await fetch(`${base}/api/tasks`,{method:'POST',headers,body:JSON.stringify({title:'Desktop Agent',deviceId:device.id})})).json() as {id:string;version:number};const running=await (await fetch(`${base}/api/tasks/${task.id}/status`,{method:'POST',headers,body:JSON.stringify(taskClaim(task.version,'D'))})).json() as {version:number;execution:{executionId:string;leaseToken:string}};const taskHeaders={...headers,'x-cod-task-execution':running.execution.executionId,'x-cod-task-lease':running.execution.leaseToken};
    const taskBound=await fetch(`${base}/v1/tasks/${task.id}/sources/demo/chat/completions`,{method:'POST',headers:taskHeaders,body:JSON.stringify({model:'coder-pro',messages:[{role:'user',content:'desktop task'}]})});expect(taskBound.status).toBe(200);expect(await taskBound.json()).toMatchObject({model:'coder-pro',cod_source:'demo'});expect(running.version).toBe(2);
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
    const conflicting = await fetch(`${base}/api/compute/requests`, { method: 'POST', headers, body: JSON.stringify({ ...JSON.parse(body), quantity: 3 }) });
    expect(conflicting.status).toBe(409); expect(await conflicting.json()).toMatchObject({ error: 'idempotency_conflict' });
    const listed = await (await fetch(`${base}/api/compute/requests`, { headers: { authorization: `Bearer ${token}` } })).json() as Array<{ id: string }>;
    expect(listed).toHaveLength(1); expect(listed[0]?.id).toBe(created.id);
    const invalid = await fetch(`${base}/api/compute/requests`, { method: 'POST', headers: { ...headers, 'idempotency-key': 'compute-invalid' }, body: JSON.stringify({ ...JSON.parse(body), contactPhone: 'x' }) });
    expect(invalid.status).toBe(400);
    const wechat = await fetch(`${base}/api/compute/requests`, { method: 'POST', headers: { ...headers, 'idempotency-key': 'compute-wechat' }, body: JSON.stringify({ ...JSON.parse(body), contactPhone: 'kai_compute_2026' }) });
    expect(wechat.status).toBe(201);
    const principal = { userId: user.id, tenantId: 'tenant_kai_com', email: user.email, role: 'member' as const };
    expect((await database.listAudit(principal, 10)).filter((entry) => entry.action === 'compute.request.created' && entry.entityId === created.id)).toHaveLength(1);
  });

  it('stores third-party GPU hosting requests idempotently and keeps each account isolated', async () => {
    const { base, database } = await start();
    const memberLogin = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'developer@kai.com', password: 'Password123' }) });
    const { token: memberToken, user: memberUser } = await memberLogin.json() as { token: string; user: { id: string; email: string } };
    const body = {
      kind: 'hosting', company: '设备持有方有限公司', contactName: '李经理', contactPhone: 'hosting_owner_2026', city: '深圳',
      gpuModel: 'NVIDIA H100 SXM 80GB', quantity: 16, requirements: '产权资料线下审核', hostingPeriodMonths: 24,
      rackUnits: 8, powerKilowatts: 15.5, networkMbps: 2000, availabilityNotes: '设备可于两周内入场',
      settlementPreference: '与实际第三方托管服务商按月结算', hostingRequirements: '合规机房、双路供电、7x24 远程运维与书面 SLA',
    };
    const memberHeaders = { authorization: `Bearer ${memberToken}`, 'content-type': 'application/json', 'idempotency-key': 'hosting-request-1' };
    const first = await fetch(`${base}/api/compute/requests`, { method: 'POST', headers: memberHeaders, body: JSON.stringify(body) });
    const second = await fetch(`${base}/api/compute/requests`, { method: 'POST', headers: memberHeaders, body: JSON.stringify(body) });
    expect(first.status).toBe(201); expect(second.status).toBe(201);
    const created = await first.json() as { id: string; status: string; fulfillmentMode: string; hostingPeriodMonths: number; powerKilowatts: number };
    expect(await second.json()).toMatchObject({ id: created.id });
    expect(created).toMatchObject({ status: 'submitted', fulfillmentMode: 'third-party-manual-match', hostingPeriodMonths: 24, powerKilowatts: 15.5 });
    const conflict = await fetch(`${base}/api/compute/requests`, { method: 'POST', headers: memberHeaders, body: JSON.stringify({ ...body, networkMbps: 10_000 }) });
    expect(conflict.status).toBe(409); expect(await conflict.json()).toMatchObject({ error: 'idempotency_conflict' });

    const missingTerms = await fetch(`${base}/api/compute/requests`, {
      method: 'POST', headers: { ...memberHeaders, 'idempotency-key': 'hosting-invalid' }, body: JSON.stringify({ ...body, settlementPreference: '' }),
    });
    expect(missingTerms.status).toBe(400); expect(await missingTerms.json()).toMatchObject({ error: 'invalid_compute_hosting_terms' });

    const adminEmail = 'hosting-admin@kai.com';
    const adminPrincipal = { userId: `usr_${createHash('sha256').update(adminEmail).digest('hex').slice(0, 20)}`, tenantId: 'tenant_kai_com', email: adminEmail, role: 'admin' as const };
    await database.registerIdentity(adminPrincipal, testPasswordHash, null, false);
    const adminLogin = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: adminEmail, password: 'Password123' }) });
    const adminToken = (await adminLogin.json() as { token: string }).token;
    expect(await (await fetch(`${base}/api/compute/requests`, { headers: { authorization: `Bearer ${adminToken}` } })).json()).toEqual([]);
    const adminCreated = await (await fetch(`${base}/api/compute/requests`, {
      method: 'POST', headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json', 'idempotency-key': 'hosting-request-1' }, body: JSON.stringify(body),
    })).json() as { id: string };
    expect(adminCreated.id).not.toBe(created.id);
    expect((await (await fetch(`${base}/api/compute/requests`, { headers: { authorization: `Bearer ${memberToken}` } })).json() as Array<{ id: string }>).map((item) => item.id)).toEqual([created.id]);
    expect((await (await fetch(`${base}/api/compute/requests`, { headers: { authorization: `Bearer ${adminToken}` } })).json() as Array<{ id: string }>).map((item) => item.id)).toEqual([adminCreated.id]);

    const memberPrincipal = { userId: memberUser.id, tenantId: 'tenant_kai_com', email: memberUser.email, role: 'member' as const };
    const memberAudit = await database.listAudit(memberPrincipal, 10);
    expect(memberAudit).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'compute.request.created', entityId: created.id, data: expect.objectContaining({ kind: 'hosting', fulfillmentMode: 'third-party-manual-match' }) }),
    ]));
    expect(memberAudit.filter((entry) => entry.action === 'compute.request.created' && entry.entityId === created.id)).toHaveLength(1);
  });

  it('exposes readiness, version, and Prometheus metrics', async () => {
    const { base } = await start();
    expect(await (await fetch(`${base}/ready`)).json()).toMatchObject({ status: 'ready', database: 'memory' });
    expect(await (await fetch(`${base}/version`)).json()).toHaveProperty('node');
    await fetch(`${base}/health`);
    const metrics = await (await fetch(`${base}/metrics`)).text();
    expect(metrics).toContain('cod_database_ready 1');
    expect(metrics).toContain('cod_http_requests_total');
    expect(metrics).toContain('cod_usage_reservations_reaped_total');
  });
});

describe('platform compute request administration',()=>{
  it('paginates and filters every tenant for admins while denying anonymous and member access',async()=>{
    const {base,database}=await start();
    const memberEmail='compute-owner@other.example';
    const memberPrincipal={userId:`usr_${createHash('sha256').update(memberEmail).digest('hex').slice(0,20)}`,tenantId:'tenant_other_example',email:memberEmail,role:'member' as const};
    const adminEmail='compute-platform-admin@kai.com';
    const adminPrincipal={userId:`usr_${createHash('sha256').update(adminEmail).digest('hex').slice(0,20)}`,tenantId:'tenant_kai_com',email:adminEmail,role:'admin' as const};
    await database.registerIdentity(memberPrincipal,testPasswordHash,null,false);
    await database.registerIdentity(adminPrincipal,testPasswordHash,null,false);
    const login=async(email:string)=>{
      const response=await fetch(`${base}/api/auth/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email,password:'Password123'})});
      expect(response.status).toBe(200);return (await response.json() as {token:string}).token;
    };
    const primaryToken=await login('developer@kai.com');const memberToken=await login(memberEmail);const adminToken=await login(adminEmail);
    const primaryHeaders={authorization:`Bearer ${primaryToken}`,'content-type':'application/json'};
    const memberHeaders={authorization:`Bearer ${memberToken}`,'content-type':'application/json'};
    const adminHeaders={authorization:`Bearer ${adminToken}`,'content-type':'application/json'};
    const rentalBody={kind:'rental',offerId:'cod-h100-pcie-card-hour',company:'跨租户甲公司',contactName:'甲联系人',contactPhone:'13800138001',city:'北京',gpuModel:'NVIDIA H100 PCIe 80GB',quantity:2,durationHours:120,requirements:'模型训练'};
    const hostingBody={kind:'hosting',company:'跨租户乙公司',contactName:'乙联系人',contactPhone:'compute_owner_2026',city:'深圳',gpuModel:'NVIDIA L40S',quantity:8,requirements:'第三方验机',hostingPeriodMonths:24,rackUnits:4,powerKilowatts:8,networkMbps:1000,availabilityNotes:'九月进场',settlementPreference:'按月结算',hostingRequirements:'双路供电与书面 SLA'};
    const rental=await (await fetch(`${base}/api/compute/requests`,{method:'POST',headers:{...primaryHeaders,'idempotency-key':'admin-rental'},body:JSON.stringify(rentalBody)})).json() as {id:string};
    const hosting=await (await fetch(`${base}/api/compute/requests`,{method:'POST',headers:{...memberHeaders,'idempotency-key':'admin-hosting'},body:JSON.stringify(hostingBody)})).json() as {id:string};

    const anonymous=await Promise.all([
      fetch(`${base}/api/admin/compute/requests`),
      fetch(`${base}/api/admin/compute/requests/search`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({q:'深圳'})}),
      fetch(`${base}/api/admin/compute/requests/${rental.id}`),
      fetch(`${base}/api/admin/compute/requests/${rental.id}/status`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({status:'contacting'})}),
    ]);
    expect(anonymous.map((response)=>response.status)).toEqual([401,401,401,401]);
    const memberDenied=await Promise.all([
      fetch(`${base}/api/admin/compute/requests`,{headers:memberHeaders}),
      fetch(`${base}/api/admin/compute/requests/search`,{method:'POST',headers:memberHeaders,body:'not-json'}),
      fetch(`${base}/api/admin/compute/requests/${rental.id}`,{headers:memberHeaders}),
      fetch(`${base}/api/admin/compute/requests/${rental.id}/status`,{method:'PATCH',headers:memberHeaders,body:'null'}),
      fetch(`${base}/api/admin/compute/requests?status=invalid`,{headers:memberHeaders}),
      fetch(`${base}/api/admin/compute/requests/not-a-uuid`,{headers:memberHeaders}),
    ]);
    expect(memberDenied.map((response)=>response.status)).toEqual([403,403,403,403,403,403]);
    expect(await memberDenied[0].json()).toMatchObject({error:'admin_required'});

    const firstPage=await (await fetch(`${base}/api/admin/compute/requests?limit=1`,{headers:adminHeaders})).json() as {items:Array<{id:string}>;nextCursor:string|null};
    expect(firstPage.items).toHaveLength(1);expect(firstPage.nextCursor).toEqual(expect.any(String));
    const secondPage=await (await fetch(`${base}/api/admin/compute/requests?limit=1&cursor=${encodeURIComponent(firstPage.nextCursor!)}`,{headers:adminHeaders})).json() as {items:Array<{id:string}>;nextCursor:string|null};
    expect(new Set([...firstPage.items,...secondPage.items].map((item)=>item.id))).toEqual(new Set([rental.id,hosting.id]));expect(secondPage.nextCursor).toBeNull();
    const search=(body:unknown)=>fetch(`${base}/api/admin/compute/requests/search`,{method:'POST',headers:adminHeaders,body:JSON.stringify(body)});
    const filtered=await (await search({status:'submitted',kind:'hosting',q:'深圳'})).json() as {items:Array<{id:string;company:string;gpuModel:string}>};
    expect(filtered.items).toEqual([expect.objectContaining({id:hosting.id,company:'跨租户乙公司',gpuModel:'NVIDIA L40S'})]);
    expect(JSON.stringify(filtered)).not.toContain(memberEmail);expect(JSON.stringify(filtered)).not.toContain('compute_owner_2026');expect(JSON.stringify(filtered)).not.toContain('乙联系人');expect(JSON.stringify(filtered)).not.toContain('双路供电与书面 SLA');
    const idSearch=await (await search({q:rental.id.toUpperCase()})).json() as {items:Array<{id:string}>};
    expect(idSearch.items.map((item)=>item.id)).toEqual([rental.id]);
    const searchPageOne=await (await search({q:'跨租户',limit:1})).json() as {items:Array<{id:string}>;nextCursor:string|null};
    const searchPageTwo=await (await search({q:'跨租户',limit:1,cursor:searchPageOne.nextCursor})).json() as {items:Array<{id:string}>;nextCursor:string|null};
    expect(new Set([...searchPageOne.items,...searchPageTwo.items].map((item)=>item.id))).toEqual(new Set([rental.id,hosting.id]));expect(searchPageTwo.nextCursor).toBeNull();

    const invalidQueries=await Promise.all([
      fetch(`${base}/api/admin/compute/requests?status=deleted`,{headers:adminHeaders}),
      fetch(`${base}/api/admin/compute/requests?kind=other`,{headers:adminHeaders}),
      fetch(`${base}/api/admin/compute/requests?limit=0`,{headers:adminHeaders}),
      fetch(`${base}/api/admin/compute/requests?limit=101`,{headers:adminHeaders}),
      fetch(`${base}/api/admin/compute/requests?cursor=bad`,{headers:adminHeaders}),
      fetch(`${base}/api/admin/compute/requests?q=${'x'.repeat(101)}`,{headers:adminHeaders}),
      fetch(`${base}/api/admin/compute/requests?status=submitted&status=closed`,{headers:adminHeaders}),
      fetch(`${base}/api/admin/compute/requests?tenantId=tenant_other_example`,{headers:adminHeaders}),
    ]);
    expect(invalidQueries.map((response)=>response.status)).toEqual(Array(8).fill(400));
    const invalidSearches=await Promise.all([
      fetch(`${base}/api/admin/compute/requests/search`,{method:'POST',headers:adminHeaders,body:'null'}),
      search([]),
      search({q:'深圳',extra:true}),
      search({q:''}),
      search({q:'x'.repeat(101)}),
      search({q:'深圳',cursor:'bad'}),
      search({q:'深圳',status:'deleted'}),
      search({q:'深圳',kind:'other'}),
      search({q:'深圳',limit:0}),
      search({q:'深圳',limit:1.5}),
    ]);
    expect(invalidSearches.map((response)=>response.status)).toEqual(Array(10).fill(400));
    expect((await fetch(`${base}/api/admin/compute/requests/not-a-uuid`,{headers:adminHeaders})).status).toBe(400);
    expect((await fetch(`${base}/api/admin/compute/requests/not-a-uuid/status`,{method:'PATCH',headers:adminHeaders,body:JSON.stringify({status:'contacting',expectedStatus:'submitted'})})).status).toBe(400);
    const missingId='00000000-0000-4000-8000-000000000000';
    expect((await fetch(`${base}/api/admin/compute/requests/${missingId}`,{headers:adminHeaders})).status).toBe(404);
    expect((await fetch(`${base}/api/admin/compute/requests/${missingId}/status`,{method:'PATCH',headers:adminHeaders,body:JSON.stringify({status:'contacting',expectedStatus:'submitted'})})).status).toBe(404);
    const malformedStatusBodies=await Promise.all(['null','[]',JSON.stringify({status:'contacting'}),JSON.stringify({status:'contacting',expectedStatus:'submitted',extra:true})].map((body)=>fetch(`${base}/api/admin/compute/requests/${rental.id}/status`,{method:'PATCH',headers:adminHeaders,body})));
    expect(malformedStatusBodies.map((response)=>response.status)).toEqual([400,400,400,400]);

    const detail=await fetch(`${base}/api/admin/compute/requests/${rental.id}`,{headers:adminHeaders});expect(detail.status).toBe(200);expect(await detail.json()).toMatchObject({id:rental.id,email:'developer@kai.com',contactName:'甲联系人',contactPhone:'13800138001'});
    const patch=async(status:unknown,expectedStatus:unknown)=>fetch(`${base}/api/admin/compute/requests/${rental.id}/status`,{method:'PATCH',headers:adminHeaders,body:JSON.stringify({status,expectedStatus})});
    expect(await (await patch('contacting','submitted')).json()).toMatchObject({status:'contacting'});
    expect(await (await patch('contacting','submitted')).json()).toMatchObject({status:'contacting'});
    const stale=await patch('closed','submitted');expect(stale.status).toBe(409);expect(await stale.json()).toMatchObject({error:'compute_request_status_conflict'});
    const invalidStatus=await patch('unknown','contacting');expect(invalidStatus.status).toBe(400);expect(await invalidStatus.json()).toMatchObject({error:'invalid_compute_request_status'});
    const backwards=await patch('submitted','contacting');expect(backwards.status).toBe(409);expect(await backwards.json()).toMatchObject({error:'invalid_compute_request_transition'});
    const validUntil=new Date(Date.now()+86400000).toISOString();
    const quote=await fetch(`${base}/api/admin/compute/requests/${rental.id}/quote`,{method:'PUT',headers:adminHeaders,body:JSON.stringify({expectedStatus:'contacting',quote:{amountCents:24000,cardHoursMilli:120000,validUntil,terms:'确认后安排 H100 交付'}})});
    expect(quote.status).toBe(200);expect(await quote.json()).toMatchObject({status:'quoted',quote:{amountCents:24000,cardHoursMilli:120000,terms:'确认后安排 H100 交付'}});
    const wrongOwner=await fetch(`${base}/api/compute/requests/${rental.id}/quote-decision`,{method:'PATCH',headers:memberHeaders,body:JSON.stringify({decision:'accepted',expectedStatus:'quoted'})});expect(wrongOwner.status).toBe(404);
    const accepted=await fetch(`${base}/api/compute/requests/${rental.id}/quote-decision`,{method:'PATCH',headers:primaryHeaders,body:JSON.stringify({decision:'accepted',expectedStatus:'quoted'})});expect(accepted.status).toBe(200);expect(await accepted.json()).toMatchObject({status:'approved',quoteDecision:'accepted'});
    expect(await (await patch('closed','approved')).json()).toMatchObject({status:'closed'});
    const reopened=await patch('quoted','closed');expect(reopened.status).toBe(409);expect(await reopened.json()).toMatchObject({error:'invalid_compute_request_transition'});
    expect(await (await fetch(`${base}/api/compute/requests`,{headers:primaryHeaders})).json()).toEqual([expect.objectContaining({id:rental.id,status:'closed'})]);
    expect(await (await fetch(`${base}/api/compute/requests`,{headers:memberHeaders})).json()).toEqual([expect.objectContaining({id:hosting.id,status:'submitted'})]);

    const audit=await database.listAudit(adminPrincipal,100);const statusAudits=audit.filter((entry)=>entry.action==='compute.request.admin.status');
    expect(statusAudits).toHaveLength(3);expect(statusAudits).toEqual(expect.arrayContaining([
      expect.objectContaining({entityId:rental.id,data:{previousStatus:'submitted',status:'contacting',changed:true}}),
      expect.objectContaining({entityId:rental.id,data:{previousStatus:'contacting',status:'contacting',changed:false}}),
      expect.objectContaining({entityId:rental.id,data:{previousStatus:'approved',status:'closed',changed:true}}),
    ]));
    expect(audit).toEqual(expect.arrayContaining([expect.objectContaining({action:'compute.request.admin.quote',entityId:rental.id})]));
    expect(JSON.stringify(audit)).not.toContain(memberEmail);expect(JSON.stringify(audit)).not.toContain('13800138001');expect(JSON.stringify(audit)).not.toContain('甲联系人');
  });
});
