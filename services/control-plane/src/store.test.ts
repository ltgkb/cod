import { describe, expect, it, vi } from 'vitest';
import { decodeComputeRequestCursor, encodeComputeRequestCursor, PostgresDatabase, type Principal } from './database.js';
import { MemoryDatabase } from './memory-database.js';

const principal: Principal = { userId: 'user_demo', tenantId: 'tenant_kai_com', email: 'developer@kai.com', role: 'member' };

describe('wallet database contract', () => {
  it('applies top-ups and usage exactly once', async () => {
    const database = new MemoryDatabase();
    await database.topup(principal, { idempotencyKey: 'topup-1', amountCents: 1000, channel: 'pilot' });
    await database.topup(principal, { idempotencyKey: 'topup-1', amountCents: 1000, channel: 'pilot' });
    await database.recordUsage(principal, { idempotencyKey: 'usage-1', taskId: 'task', sourceId: 'ai-kai', paymentDirection: '钱包 → ai.kai.com', model: 'coder-pro', inputTokens: 10, outputTokens: 20, costCents: 120 });
    await database.recordUsage(principal, { idempotencyKey: 'usage-1', taskId: 'task', sourceId: 'ai-kai', paymentDirection: '钱包 → ai.kai.com', model: 'coder-pro', inputTokens: 10, outputTokens: 20, costCents: 120 });
    expect((await database.getAccount(principal)).balanceCents).toBe(1000);
    expect((await database.getCreditSummary(principal)).availableCents).toBe(880);
    const ledger = await database.getLedger(principal);
    expect(ledger).toHaveLength(3);
    expect(ledger[0]).toMatchObject({ sourceId: 'ai-kai', model: 'coder-pro', paymentDirection: '钱包 → ai.kai.com', walletAmountCents: 0, creditAmountCents: -120 });
    expect(ledger.every((entry) => entry.amountCents === entry.walletAmountCents + entry.creditAmountCents)).toBe(true);
  });

  it('rejects idempotency-key reuse with different wallet or usage parameters', async () => {
    const database = new MemoryDatabase();
    await database.topup(principal, { idempotencyKey: 'wallet-operation', amountCents: 1000, channel: 'pilot' });
    await expect(database.topup(principal, { idempotencyKey: 'wallet-operation', amountCents: 2000, channel: 'pilot' })).rejects.toMatchObject({ status: 409, code: 'idempotency_conflict' });
    await expect(database.topup(principal, { idempotencyKey: 'wallet-operation', amountCents: 1000, channel: 'alipay' })).rejects.toMatchObject({ status: 409, code: 'idempotency_conflict' });
    const usage = { idempotencyKey: 'usage-operation', taskId: 'task', sourceId: 'ai-kai', paymentDirection: '钱包 → ai.kai.com', model: 'coder-pro', inputTokens: 10, outputTokens: 20, costCents: 100 };
    await database.recordUsage(principal, usage);
    await expect(database.recordUsage(principal, { ...usage, costCents: 101 })).rejects.toMatchObject({ status: 409, code: 'idempotency_conflict' });
    await expect(database.recordUsage(principal, { ...usage, sourceId: 'chase-kai' })).rejects.toMatchObject({ status: 409, code: 'idempotency_conflict' });
    await expect(database.recordUsage(principal, { ...usage, taskId: 'other-task' })).rejects.toMatchObject({ status: 409, code: 'idempotency_conflict' });
    await expect(database.recordUsage(principal, { ...usage, idempotencyKey: 'wallet-operation' })).rejects.toMatchObject({ status: 409, code: 'idempotency_conflict' });
    expect(await database.getAccount(principal)).toMatchObject({ balanceCents: 1000 });
    expect((await database.getCreditSummary(principal)).availableCents).toBe(900);
    expect(await database.getLedger(principal)).toHaveLength(3);
  });

  it('reserves, settles, and releases model usage without leaking balance', async () => {
    const database = new MemoryDatabase();
    await database.reserveUsage(principal, 'reserve-1', 100);
    expect((await database.getAccount(principal)).balanceCents).toBe(0);
    await database.settleUsage(principal, 'reserve-1', { idempotencyKey: 'settle-1', taskId: 'chat', sourceId: 'ai-kai', paymentDirection: '钱包 → ai.kai.com', model: 'coder-pro', inputTokens: 10, outputTokens: 20, costCents: 40 });
    expect((await database.getCreditSummary(principal)).availableCents).toBe(960);
    expect((await database.getLedger(principal)).every((entry) => entry.amountCents === entry.walletAmountCents + entry.creditAmountCents)).toBe(true);
    await database.reserveUsage(principal, 'reserve-duplicate', 100);
    await database.settleUsage(principal, 'reserve-duplicate', { idempotencyKey: 'settle-1', taskId: 'chat', sourceId: 'ai-kai', paymentDirection: '钱包 → ai.kai.com', model: 'coder-pro', inputTokens: 10, outputTokens: 20, costCents: 40 });
    expect((await database.getCreditSummary(principal)).availableCents).toBe(960);
    expect(await database.getLedger(principal)).toHaveLength(2);
    await database.reserveUsage(principal, 'reserve-2', 100);
    await database.releaseUsage(principal, 'reserve-2');
    expect((await database.getCreditSummary(principal)).availableCents).toBe(960);
  });

  it('preserves every cent through failed reservations, settlement overruns, and partial refunds', async () => {
    const database = new MemoryDatabase();
    await database.reserveUsage(principal, 'large-reservation', 700);
    expect((await database.getCreditSummary(principal)).availableCents).toBe(300);
    await expect(database.reserveUsage(principal, 'overlapping-reservation', 400)).rejects.toMatchObject({ status: 402 });
    expect((await database.getCreditSummary(principal)).availableCents).toBe(300);
    await database.releaseUsage(principal, 'large-reservation');
    expect((await database.getCreditSummary(principal)).availableCents).toBe(1000);

    await database.reserveUsage(principal, 'underestimated-reservation', 800);
    const overrun = { idempotencyKey: 'overrun-settlement', taskId: 'chat', sourceId: 'ai-kai', paymentDirection: '钱包 → ai.kai.com', model: 'coder-pro', inputTokens: 10, outputTokens: 20, costCents: 1200 };
    await expect(database.settleUsage(principal, 'underestimated-reservation', overrun)).rejects.toMatchObject({ status: 402 });
    await database.releaseUsage(principal, 'underestimated-reservation');
    expect((await database.getCreditSummary(principal)).availableCents).toBe(1000);

    await database.topup(principal, { idempotencyKey: 'partial-funds', amountCents: 500, channel: 'pilot' });
    await database.reserveUsage(principal, 'partial-refund-reservation', 1200);
    expect(await database.getAccount(principal)).toMatchObject({ balanceCents: 300 });
    expect((await database.getCreditSummary(principal)).availableCents).toBe(0);
    const settled = await database.settleUsage(principal, 'partial-refund-reservation', { ...overrun, idempotencyKey: 'partial-settlement', costCents: 700 });
    expect(settled).toMatchObject({ amountCents: -700, walletAmountCents: 0, creditAmountCents: -700 });
    expect(await database.getAccount(principal)).toMatchObject({ balanceCents: 500 });
    expect((await database.getCreditSummary(principal)).availableCents).toBe(300);
    expect((await database.getLedger(principal)).every((entry) => entry.amountCents === entry.walletAmountCents + entry.creditAmountCents)).toBe(true);
  });

  it('commits a cached chat response and its completion audit once with usage',async()=>{
    const database=new MemoryDatabase();const requestKey='memory-chat-request';const fingerprint='a'.repeat(64);
    expect(await database.claimChatRequest(principal,requestKey,fingerprint)).toEqual({state:'claimed'});
    await database.reserveUsage(principal,'memory-chat-reservation',100);
    const event={idempotencyKey:`chat:${requestKey}:${fingerprint}`,taskId:'chat',sourceId:'ai-kai',paymentDirection:'钱包 → ai.kai.com',model:'coder-pro',inputTokens:10,outputTokens:20,costCents:40};
    const completion={requestKey,fingerprint,responsePayload:{choices:[{message:{content:'完成'}}]},audit:{entityId:'coder-pro',data:{sourceId:'ai-kai',inputTokens:10,outputTokens:20}}};
    const first=await database.settleUsage(principal,'memory-chat-reservation',event,completion);
    const duplicate=await database.settleUsage(principal,'memory-chat-reservation',event,completion);
    expect(duplicate.id).toBe(first.id);
    expect(await database.claimChatRequest(principal,requestKey,fingerprint)).toMatchObject({state:'complete',responsePayload:completion.responsePayload});
    expect((await database.listAudit(principal,20)).filter((entry)=>entry.action==='chat.complete')).toEqual([expect.objectContaining({entityType:'model',entityId:'coder-pro',data:completion.audit.data})]);
    expect(await database.getLedger(principal)).toHaveLength(2);
  });

  it('rejects spending above the wallet balance', async () => {
    const database = new MemoryDatabase();
    await expect(database.recordUsage(principal, { idempotencyKey: 'usage-2', taskId: 'task', sourceId: 'ai-kai', paymentDirection: '钱包 → ai.kai.com', model: 'coder-pro', inputTokens: 1, outputTokens: 1, costCents: 9000 })).rejects.toMatchObject({ status: 402 });
  });

  it('records admin test usage without consuming wallet or credits', async () => {
    const database = new MemoryDatabase(); const admin: Principal = { ...principal, userId: 'admin', email: 'admin@kai.com', role: 'admin' };
    await database.reserveUsage(admin, 'admin-reservation', 900_000);
    const entry = await database.settleUsage(admin, 'admin-reservation', { idempotencyKey: 'admin-usage', taskId: 'chat', sourceId: 'ai-kai', paymentDirection: '钱包 → ai.kai.com', model: 'coder-pro', inputTokens: 100, outputTokens: 200, costCents: 900_000, commissionRateBps: 2_000, commissionCents: 180_000 });
    expect(entry).toMatchObject({ amountCents: 0, walletAmountCents: 0, creditAmountCents: 0, commissionRateBps: 0, commissionCents: 0, paymentDirection: '管理员测试免计费' });
    expect(await database.getCreditSummary(admin)).toMatchObject({ availableCents: 1000 });
    expect(await database.getAccount(admin)).toMatchObject({ role: 'admin', billingExempt: true });
  });

  it('falls back to permanent wallet funds at the original model price and records source attribution', async () => {
    const database = new MemoryDatabase();
    await database.topup(principal, { idempotencyKey: 'wallet-funds', amountCents: 500, channel: 'pilot' });
    await database.recordUsage(principal, { idempotencyKey: 'drain-trial', taskId: 'task', sourceId: 'chase-kai', upstreamSourceId: 'ai-kai', paymentDirection: '钱包/额度 → ai.kai.com · 归因 CHASE.KAI.COM', model: 'glm-5.2', inputTokens: 100, outputTokens: 100, costCents: 1200, commissionRateBps: 1000, commissionCents: 120 });
    expect((await database.getCreditSummary(principal)).availableCents).toBe(0);
    expect((await database.getAccount(principal)).balanceCents).toBe(300);
    expect((await database.getLedger(principal))[0]).toMatchObject({ sourceId: 'chase-kai', upstreamSourceId: 'ai-kai', creditAmountCents: -1000, walletAmountCents: -200, commissionRateBps: 1000, commissionCents: 120 });
  });

  it('isolates balances and idempotency by principal', async () => {
    const database = new MemoryDatabase();
    const other = { ...principal, userId: 'other', email: 'other@kai.com' };
    await database.topup(principal, { idempotencyKey: 'same', amountCents: 1000, channel: 'pilot' });
    await database.topup(other, { idempotencyKey: 'same', amountCents: 2000, channel: 'pilot' });
    expect((await database.getAccount(principal)).balanceCents).toBe(1000);
    expect((await database.getAccount(other)).balanceCents).toBe(2000);
  });

  it('credits an exact payment order once and rejects mismatched callbacks', async () => {
    const database = new MemoryDatabase();
    await expect(database.createPaymentOrder(principal, { amountCents: 2500, channel: 'alipay', idempotencyKey: '' })).rejects.toMatchObject({ code: 'invalid_idempotency_key' });
    await expect(database.createPaymentOrder(principal, { amountCents: 2500, channel: 'alipay', idempotencyKey: 'x'.repeat(201) })).rejects.toMatchObject({ code: 'invalid_idempotency_key' });
    const order = await database.createPaymentOrder(principal, { amountCents: 2500, channel: 'alipay', idempotencyKey: 'order-1' });
    await expect(database.completePaymentOrder({ orderId: order.id, amountCents: 2501, currency: 'CNY', channel: 'alipay', providerPaymentId: 'ali-1', providerEventId: 'event-bad' })).rejects.toMatchObject({ code: 'payment_order_mismatch' });
    const first = await database.completePaymentOrder({ orderId: order.id, amountCents: 2500, currency: 'CNY', channel: 'alipay', providerPaymentId: 'ali-1', providerEventId: 'event-1' });
    const duplicate = await database.completePaymentOrder({ orderId: order.id, amountCents: 2500, currency: 'CNY', channel: 'alipay', providerPaymentId: 'ali-1', providerEventId: 'event-1-retry' });
    expect(first.entry.id).toBe(duplicate.entry.id);
    const otherOrder = await database.createPaymentOrder(principal, { amountCents: 2500, channel: 'alipay', idempotencyKey: 'order-2' });
    await expect(database.completePaymentOrder({ orderId: otherOrder.id, amountCents: 2500, currency: 'CNY', channel: 'alipay', providerPaymentId: 'ali-1', providerEventId: 'event-2' })).rejects.toMatchObject({ code: 'payment_provider_reused' });
    expect((await database.getAccount(principal)).balanceCents).toBe(2500);
    expect(await database.getLedger(principal)).toHaveLength(2);
  });

  it('buys 180-day packs idempotently and spends the 30-day trial credit first', async () => {
    const database=new MemoryDatabase();
    await database.topup(principal,{idempotencyKey:'fund-pack',amountCents:5000,channel:'pilot'});
    const first=await database.purchaseCreditPack(principal,'starter','buy-starter');
    const duplicate=await database.purchaseCreditPack(principal,'starter','buy-starter');
    expect(first.grant.id).toBe(duplicate.grant.id);
    expect((await database.getAccount(principal)).balanceCents).toBe(3000);
    const summary=await database.getCreditSummary(principal);
    expect(summary.availableCents).toBe(3000);
    const trial=summary.grants.find((grant)=>grant.packId==='trial')!;
    const starter=summary.grants.find((grant)=>grant.packId==='starter')!;
    expect(Math.round((new Date(trial.expiresAt).getTime()-new Date(trial.purchasedAt).getTime())/86400000)).toBe(30);
    expect(Math.round((new Date(starter.expiresAt).getTime()-new Date(starter.purchasedAt).getTime())/86400000)).toBe(180);
    await database.recordUsage(principal,{idempotencyKey:'credit-usage',taskId:'task',sourceId:'ai-kai',paymentDirection:'额度 → ai.kai.com',model:'coder-pro',inputTokens:10,outputTokens:20,costCents:1200});
    const after=await database.getCreditSummary(principal);
    expect(after.grants.find((grant)=>grant.packId==='trial')).toMatchObject({remainingCents:0,status:'depleted'});
    expect(after.grants.find((grant)=>grant.packId==='starter')).toMatchObject({remainingCents:1800,status:'active'});
    expect((await database.getAccount(principal)).balanceCents).toBe(3000);
    expect((await database.getLedger(principal))[0]).toMatchObject({type:'usage',creditAmountCents:-1200,walletAmountCents:0});
  });

  it('distinguishes a newly created in-memory compute request from an idempotent replay', async () => {
    const database = new MemoryDatabase();
    const input = { kind: 'hosting' as const, offerId: null, company: '内存托管测试', contactName: '王工', contactPhone: 'qa_contact', city: '深圳', gpuModel: 'NVIDIA H100', quantity: 4, durationHours: null, termMonths: null, requirements: '书面 SLA', hostingPeriodMonths: 12, rackUnits: 2, powerKilowatts: 4, networkMbps: 1000, availabilityNotes: '两周内进场', settlementPreference: '固定托管费（月结）', hostingRequirements: '双路供电与远程运维' };
    const first = await database.createComputeRequest(principal, input, 'memory-hosting');
    const replay = await database.createComputeRequest(principal, input, 'memory-hosting');
    expect(first).toMatchObject({ created: true, request: { fulfillmentMode: 'third-party-manual-match' } });
    expect(replay).toMatchObject({ created: false, request: { id: first.request.id } });
    expect(await database.listComputeRequests(principal)).toHaveLength(1);
    await expect(database.createComputeRequest(principal, { ...input, quantity: 5 }, 'memory-hosting')).rejects.toMatchObject({ status: 409, code: 'idempotency_conflict' });
  });

  it('distinguishes a newly inserted Postgres compute request from an idempotent replay', async () => {
    const database = new PostgresDatabase('postgresql://qa.invalid/cod');
    const input = { kind: 'hosting' as const, offerId: null, company: 'Postgres 托管测试', contactName: '李工', contactPhone: 'qa_pg_contact', city: '上海', gpuModel: 'NVIDIA L40S', quantity: 8, durationHours: null, termMonths: null, requirements: '第三方验机', hostingPeriodMonths: 24, rackUnits: null, powerKilowatts: null, networkMbps: null, availabilityNotes: '参数待现场确认', settlementPreference: '托管商报价后确认', hostingRequirements: '设备保险与书面 SLA' };
    let stored: Record<string, unknown> | null = null;
    const query = vi.fn(async (text: string, values: unknown[] = []) => {
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK' || text.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [], rowCount: 1 };
      if (text.startsWith('SELECT * FROM cod_compute_requests')) return { rows: stored ? [stored] : [], rowCount: stored ? 1 : 0 };
      if (text.startsWith('INSERT INTO cod_compute_requests')) {
        stored = {
          id: values[0], tenant_id: values[1], user_id: values[2], email: values[3], kind: values[4], offer_id: values[5],
          payload: JSON.parse(String(values[6])), idempotency_key: values[7], status: 'submitted', created_at: '2026-08-11T12:00:00.000Z', updated_at: '2026-08-11T12:00:00.000Z',
        };
        return { rows: [stored], rowCount: 1 };
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    Object.defineProperty(database, 'pool', { value: { connect: async () => ({ query, release: vi.fn() }) } });
    const first = await database.createComputeRequest(principal, input, 'postgres-hosting');
    const replay = await database.createComputeRequest(principal, input, 'postgres-hosting');
    expect(first).toMatchObject({ created: true, request: { fulfillmentMode: 'third-party-manual-match' } });
    expect(replay).toMatchObject({ created: false, request: { id: first.request.id } });
    expect(query.mock.calls.filter(([text]) => String(text).startsWith('INSERT INTO cod_compute_requests'))).toHaveLength(1);
    await expect(database.createComputeRequest(principal, { ...input, quantity: 9 }, 'postgres-hosting')).rejects.toMatchObject({ status: 409, code: 'idempotency_conflict' });
  });
});

describe('compute request administration database contract',()=>{
  const admin:Principal={userId:'platform-admin',tenantId:'tenant_admin',email:'admin@kai.com',role:'admin'};
  const other:Principal={userId:'other-user',tenantId:'tenant_other',email:'owner@other.example',role:'member'};
  const input={kind:'hosting' as const,offerId:null,company:'跨租户托管公司',contactName:'王工',contactPhone:'compute_owner',city:'深圳',gpuModel:'NVIDIA H100',quantity:4,durationHours:null,termMonths:null,requirements:'书面 SLA',hostingPeriodMonths:12,rackUnits:2,powerKilowatts:4,networkMbps:1000,availabilityNotes:'两周内进场',settlementPreference:'月结',hostingRequirements:'双路供电'};

  it('round-trips canonical millisecond and microsecond cursors only',()=>{
    const id='30000000-0000-4000-8000-000000000001';
    for(const createdAt of ['2026-08-11T12:00:00.123Z','2026-08-11T12:00:00.123456Z']){
      const cursor=encodeComputeRequestCursor({createdAt,id});
      expect(decodeComputeRequestCursor(cursor)).toEqual({createdAt,id});
    }
    const raw=(createdAt:string)=>Buffer.from(JSON.stringify([createdAt,id]),'utf8').toString('base64url');
    for(const createdAt of ['2026-08-11T12:00:00.1234Z','2026-08-11T12:00:00.12345Z','2026-08-11T12:00:00.1234567Z','2026-08-11T12:00:00.123+00:00','2026-02-30T12:00:00.123Z']){
      expect(()=>decodeComputeRequestCursor(raw(createdAt))).toThrow();
    }
  });

  it('keeps the in-memory admin view global, paginated, searchable, role-gated, and transition-safe',async()=>{
    const database=new MemoryDatabase();
    const first=(await database.createComputeRequest(principal,input,'compute-admin-first')).request;
    const second=(await database.createComputeRequest(other,{...input,company:'异地托管公司',city:'成都',gpuModel:'NVIDIA L40S'},'compute-admin-second')).request;
    await expect(database.listAdminComputeRequests(principal)).rejects.toMatchObject({status:403,code:'admin_required'});
    await expect(database.getAdminComputeRequest(principal,first.id)).rejects.toMatchObject({status:403,code:'admin_required'});
    await expect(database.updateAdminComputeRequestStatus(principal,first.id,'contacting','submitted')).rejects.toMatchObject({status:403,code:'admin_required'});
    const page1=await database.listAdminComputeRequests(admin,{limit:1});expect(page1.items).toHaveLength(1);expect(page1.nextCursor).toEqual(expect.any(String));
    const page2=await database.listAdminComputeRequests(admin,{limit:1,cursor:decodeComputeRequestCursor(page1.nextCursor)});
    expect(new Set([...page1.items,...page2.items].map((request)=>request.id))).toEqual(new Set([first.id,second.id]));expect(page2.nextCursor).toBeNull();
    expect((await database.listAdminComputeRequests(admin,{q:first.id.toUpperCase()})).items.map((request)=>request.id)).toEqual([first.id]);
    expect((await database.listAdminComputeRequests(admin,{kind:'hosting',status:'submitted',q:'成都'})).items.map((request)=>request.id)).toEqual([second.id]);
    expect(await database.getAdminComputeRequest(admin,second.id)).toMatchObject({id:second.id,email:other.email,contactPhone:'compute_owner'});
    await expect(database.getAdminComputeRequest(admin,'not-a-uuid')).rejects.toMatchObject({status:400,code:'invalid_compute_request_id'});
    expect(await database.updateAdminComputeRequestStatus(admin,first.id,'contacting','submitted')).toMatchObject({request:{status:'contacting'},previousStatus:'submitted',changed:true});
    expect(await database.updateAdminComputeRequestStatus(admin,first.id,'contacting','submitted')).toMatchObject({request:{status:'contacting'},previousStatus:'contacting',changed:false});
    const concurrent=await Promise.allSettled([
      database.updateAdminComputeRequestStatus(admin,first.id,'closed','contacting'),
      database.updateAdminComputeRequestStatus(admin,first.id,'quoted','contacting'),
    ]);
    expect(concurrent.map((result)=>result.status)).toEqual(['fulfilled','rejected']);
    expect(concurrent[1]).toMatchObject({status:'rejected',reason:{status:409,code:'compute_request_status_conflict'}});
    expect(await database.getAdminComputeRequest(admin,first.id)).toMatchObject({status:'closed'});
    const audits=(await database.listAudit(admin,20)).filter((entry)=>entry.action==='compute.request.admin.status');
    expect(audits).toHaveLength(3);expect(JSON.stringify(audits)).not.toContain(first.email);expect(JSON.stringify(audits)).not.toContain(first.contactPhone);
  });

  it('uses parameterized global Postgres pagination and commits status plus audit under one row lock',async()=>{
    const database=new PostgresDatabase('postgresql://qa.invalid/cod');
    const firstId='10000000-0000-4000-8000-000000000001';const secondId='10000000-0000-4000-8000-000000000002';
    let stored:Record<string,unknown>={id:firstId,tenant_id:'tenant_other',user_id:'other-user',email:other.email,kind:'hosting',offer_id:null,payload:{...input},company:input.company,gpu_model:input.gpuModel,quantity:input.quantity,idempotency_key:'pg-admin-first',status:'submitted',created_at:'2026-08-11T12:00:00.000Z',updated_at:'2026-08-11T12:00:00.000Z',cursor_created_at:'2026-08-11T12:00:00.000001Z'};
    const second={...stored,id:secondId,email:'second@another.example',idempotency_key:'pg-admin-second',created_at:'2026-08-10T12:00:00.000Z',cursor_created_at:'2026-08-10T12:00:00.000001Z'};
    const poolQuery=vi.fn(async(text:string,values:unknown[]=[])=>{
      if(text==='SELECT * FROM cod_compute_requests WHERE id=$1')return{rows:values[0]===firstId?[stored]:[],rowCount:values[0]===firstId?1:0};
      if(text.startsWith('SELECT id,kind,status'))return{rows:[stored,second],rowCount:2};
      throw new Error(`Unexpected pool query: ${text}`);
    });
    const transactionQueries:Array<{text:string;values:unknown[]}>=[];const release=vi.fn();
    const clientQuery=vi.fn(async(text:string,values:unknown[]=[])=>{
      transactionQueries.push({text,values});
      if(text==='BEGIN'||text==='COMMIT'||text==='ROLLBACK')return{rows:[],rowCount:1};
      if(text==='SELECT * FROM cod_compute_requests WHERE id=$1 FOR UPDATE')return{rows:values[0]===firstId?[stored]:[],rowCount:values[0]===firstId?1:0};
      if(text.startsWith('UPDATE cod_compute_requests SET status=')){stored={...stored,status:values[1],updated_at:'2026-08-11T12:01:00.000Z'};return{rows:[stored],rowCount:1};}
      if(text.startsWith('INSERT INTO cod_audit'))return{rows:[],rowCount:1};
      throw new Error(`Unexpected transaction query: ${text}`);
    });
    Object.defineProperty(database,'pool',{value:{query:poolQuery,connect:async()=>({query:clientQuery,release})}});
    await expect(database.listAdminComputeRequests(principal)).rejects.toMatchObject({status:403,code:'admin_required'});expect(poolQuery).not.toHaveBeenCalled();
    const cursor={createdAt:'2026-08-12T12:00:00.000Z',id:'10000000-0000-4000-8000-000000000099'};
    const page=await database.listAdminComputeRequests(admin,{limit:1,status:'submitted',kind:'hosting',q:"x%'_",cursor});
    expect(page.items.map((request)=>request.id)).toEqual([firstId]);expect(decodeComputeRequestCursor(page.nextCursor)).toEqual({createdAt:'2026-08-11T12:00:00.000001Z',id:firstId});
    const [listSql,listValues]=poolQuery.mock.calls[0] as [string,unknown[]];
    expect(listSql).toContain('ORDER BY created_at DESC,id DESC LIMIT $6');expect(listSql).toContain('position($3 in lower(id::text))');expect(listSql).toContain("payload->>'city'");expect(listSql).not.toContain("x%'_");
    expect(listValues).toEqual(['submitted','hosting',"x%'_",cursor.createdAt,cursor.id,2]);
    expect(await database.getAdminComputeRequest(admin,firstId)).toMatchObject({id:firstId,email:other.email});
    await expect(database.getAdminComputeRequest(admin,'bad-id')).rejects.toMatchObject({status:400,code:'invalid_compute_request_id'});

    const updated=await database.updateAdminComputeRequestStatus(admin,firstId,'contacting','submitted');expect(updated).toMatchObject({request:{status:'contacting'},previousStatus:'submitted',changed:true});
    const texts=transactionQueries.map(({text})=>text);expect(texts).toEqual(['BEGIN','SELECT * FROM cod_compute_requests WHERE id=$1 FOR UPDATE',expect.stringContaining('UPDATE cod_compute_requests SET status='),expect.stringContaining('INSERT INTO cod_audit'),'COMMIT']);
    const auditValues=transactionQueries.find(({text})=>text.startsWith('INSERT INTO cod_audit'))!.values;expect(JSON.parse(String(auditValues[6]))).toEqual({previousStatus:'submitted',status:'contacting',changed:true});expect(JSON.stringify(auditValues)).not.toContain(other.email);expect(JSON.stringify(auditValues)).not.toContain(input.contactPhone);
    transactionQueries.length=0;expect(await database.updateAdminComputeRequestStatus(admin,firstId,'contacting','submitted')).toMatchObject({changed:false});
    expect(transactionQueries.map(({text})=>text)).toEqual(['BEGIN','SELECT * FROM cod_compute_requests WHERE id=$1 FOR UPDATE',expect.stringContaining('INSERT INTO cod_audit'),'COMMIT']);
    transactionQueries.length=0;await expect(database.updateAdminComputeRequestStatus(admin,firstId,'submitted','contacting')).rejects.toMatchObject({status:409,code:'invalid_compute_request_transition'});
    expect(transactionQueries.map(({text})=>text)).toEqual(['BEGIN','SELECT * FROM cod_compute_requests WHERE id=$1 FOR UPDATE','ROLLBACK']);expect(release).toHaveBeenCalledTimes(3);
  });

  it('preserves Postgres microseconds at a keyset page boundary',async()=>{
    const database=new PostgresDatabase('postgresql://qa.invalid/cod');
    const newerId='20000000-0000-4000-8000-000000000002';const olderId='20000000-0000-4000-8000-000000000001';
    const row=(id:string,cursorCreatedAt:string)=>({id,tenant_id:'tenant_other',user_id:'other-user',email:other.email,kind:'hosting',offer_id:null,payload:{...input},company:input.company,gpu_model:input.gpuModel,quantity:input.quantity,idempotency_key:id,status:'submitted',created_at:'2026-08-11T12:00:00.123Z',updated_at:'2026-08-11T12:00:00.123Z',cursor_created_at:cursorCreatedAt});
    const newer=row(newerId,'2026-08-11T12:00:00.123456Z');const older=row(olderId,'2026-08-11T12:00:00.123123Z');
    const poolQuery=vi.fn(async(text:string,values:unknown[]=[])=>{
      expect(text).toContain("to_char(created_at AT TIME ZONE 'UTC'");
      expect(text).toContain('ORDER BY created_at DESC,id DESC');
      if(values.length===1)return{rows:[newer,older],rowCount:2};
      expect(text).toContain('(created_at,id)<($1::timestamptz,$2::uuid)');
      expect(values.slice(0,2)).toEqual(['2026-08-11T12:00:00.123456Z',newerId]);
      return{rows:[older],rowCount:1};
    });
    Object.defineProperty(database,'pool',{value:{query:poolQuery}});

    const firstPage=await database.listAdminComputeRequests(admin,{limit:1});
    const cursor=decodeComputeRequestCursor(firstPage.nextCursor);
    expect(cursor).toEqual({createdAt:'2026-08-11T12:00:00.123456Z',id:newerId});
    const secondPage=await database.listAdminComputeRequests(admin,{limit:1,cursor});
    expect(firstPage.items[0].createdAt).toBe('2026-08-11T12:00:00.123Z');
    expect(secondPage.items.map((request)=>request.id)).toEqual([olderId]);
    expect(secondPage.nextCursor).toBeNull();
  });
});
