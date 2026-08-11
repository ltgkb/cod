import { describe, expect, it } from 'vitest';
import type { Principal } from './database.js';
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
  });

  it('reserves, settles, and releases model usage without leaking balance', async () => {
    const database = new MemoryDatabase();
    await database.reserveUsage(principal, 'reserve-1', 100);
    expect((await database.getAccount(principal)).balanceCents).toBe(0);
    await database.settleUsage(principal, 'reserve-1', { idempotencyKey: 'settle-1', taskId: 'chat', sourceId: 'ai-kai', paymentDirection: '钱包 → ai.kai.com', model: 'coder-pro', inputTokens: 10, outputTokens: 20, costCents: 40 });
    expect((await database.getCreditSummary(principal)).availableCents).toBe(960);
    await database.reserveUsage(principal, 'reserve-duplicate', 100);
    await database.settleUsage(principal, 'reserve-duplicate', { idempotencyKey: 'settle-1', taskId: 'chat', sourceId: 'ai-kai', paymentDirection: '钱包 → ai.kai.com', model: 'coder-pro', inputTokens: 10, outputTokens: 20, costCents: 40 });
    expect((await database.getCreditSummary(principal)).availableCents).toBe(960);
    expect(await database.getLedger(principal)).toHaveLength(2);
    await database.reserveUsage(principal, 'reserve-2', 100);
    await database.releaseUsage(principal, 'reserve-2');
    expect((await database.getCreditSummary(principal)).availableCents).toBe(960);
  });

  it('rejects spending above the wallet balance', async () => {
    const database = new MemoryDatabase();
    await expect(database.recordUsage(principal, { idempotencyKey: 'usage-2', taskId: 'task', sourceId: 'ai-kai', paymentDirection: '钱包 → ai.kai.com', model: 'coder-pro', inputTokens: 1, outputTokens: 1, costCents: 9000 })).rejects.toMatchObject({ status: 402 });
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
});
