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
    expect((await database.getAccount(principal)).balanceCents).toBe(7720);
    const ledger = await database.getLedger(principal);
    expect(ledger).toHaveLength(2);
    expect(ledger[0]).toMatchObject({ sourceId: 'ai-kai', model: 'coder-pro', paymentDirection: '钱包 → ai.kai.com' });
  });

  it('reserves, settles, and releases model usage without leaking balance', async () => {
    const database = new MemoryDatabase();
    await database.reserveUsage(principal, 'reserve-1', 100);
    expect((await database.getAccount(principal)).balanceCents).toBe(6740);
    await database.settleUsage(principal, 'reserve-1', { idempotencyKey: 'settle-1', taskId: 'chat', sourceId: 'ai-kai', paymentDirection: '钱包 → ai.kai.com', model: 'coder-pro', inputTokens: 10, outputTokens: 20, costCents: 40 });
    expect((await database.getAccount(principal)).balanceCents).toBe(6800);
    await database.reserveUsage(principal, 'reserve-duplicate', 100);
    await database.settleUsage(principal, 'reserve-duplicate', { idempotencyKey: 'settle-1', taskId: 'chat', sourceId: 'ai-kai', paymentDirection: '钱包 → ai.kai.com', model: 'coder-pro', inputTokens: 10, outputTokens: 20, costCents: 40 });
    expect((await database.getAccount(principal)).balanceCents).toBe(6800);
    expect(await database.getLedger(principal)).toHaveLength(1);
    await database.reserveUsage(principal, 'reserve-2', 100);
    await database.releaseUsage(principal, 'reserve-2');
    expect((await database.getAccount(principal)).balanceCents).toBe(6800);
  });

  it('rejects spending above the wallet balance', async () => {
    const database = new MemoryDatabase();
    await expect(database.recordUsage(principal, { idempotencyKey: 'usage-2', taskId: 'task', sourceId: 'ai-kai', paymentDirection: '钱包 → ai.kai.com', model: 'coder-pro', inputTokens: 1, outputTokens: 1, costCents: 9000 })).rejects.toMatchObject({ status: 402 });
  });

  it('isolates balances and idempotency by principal', async () => {
    const database = new MemoryDatabase();
    const other = { ...principal, userId: 'other', email: 'other@kai.com' };
    await database.topup(principal, { idempotencyKey: 'same', amountCents: 1000, channel: 'pilot' });
    await database.topup(other, { idempotencyKey: 'same', amountCents: 2000, channel: 'pilot' });
    expect((await database.getAccount(principal)).balanceCents).toBe(7840);
    expect((await database.getAccount(other)).balanceCents).toBe(8840);
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
    expect((await database.getAccount(principal)).balanceCents).toBe(9340);
    expect(await database.getLedger(principal)).toHaveLength(1);
  });
});
