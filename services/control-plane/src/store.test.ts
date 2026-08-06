import { describe, expect, it } from 'vitest';
import type { Principal } from './database.js';
import { MemoryDatabase } from './memory-database.js';

const principal: Principal = { userId: 'user_demo', tenantId: 'tenant_kai_com', email: 'developer@kai.com', role: 'member' };

describe('wallet database contract', () => {
  it('applies top-ups and usage exactly once', async () => {
    const database = new MemoryDatabase();
    await database.topup(principal, { idempotencyKey: 'topup-1', amountCents: 1000, channel: 'mock' });
    await database.topup(principal, { idempotencyKey: 'topup-1', amountCents: 1000, channel: 'mock' });
    await database.recordUsage(principal, { idempotencyKey: 'usage-1', taskId: 'task', model: 'coder-pro', inputTokens: 10, outputTokens: 20, costCents: 120 });
    await database.recordUsage(principal, { idempotencyKey: 'usage-1', taskId: 'task', model: 'coder-pro', inputTokens: 10, outputTokens: 20, costCents: 120 });
    expect((await database.getAccount(principal)).balanceCents).toBe(7720);
    expect(await database.getLedger(principal)).toHaveLength(2);
  });

  it('reserves, settles, and releases model usage without leaking balance', async () => {
    const database = new MemoryDatabase();
    await database.reserveUsage(principal, 'reserve-1', 100);
    expect((await database.getAccount(principal)).balanceCents).toBe(6740);
    await database.settleUsage(principal, 'reserve-1', { idempotencyKey: 'settle-1', taskId: 'chat', model: 'coder-pro', inputTokens: 10, outputTokens: 20, costCents: 40 });
    expect((await database.getAccount(principal)).balanceCents).toBe(6800);
    await database.reserveUsage(principal, 'reserve-duplicate', 100);
    await database.settleUsage(principal, 'reserve-duplicate', { idempotencyKey: 'settle-1', taskId: 'chat', model: 'coder-pro', inputTokens: 10, outputTokens: 20, costCents: 40 });
    expect((await database.getAccount(principal)).balanceCents).toBe(6800);
    expect(await database.getLedger(principal)).toHaveLength(1);
    await database.reserveUsage(principal, 'reserve-2', 100);
    await database.releaseUsage(principal, 'reserve-2');
    expect((await database.getAccount(principal)).balanceCents).toBe(6800);
  });

  it('rejects spending above the wallet balance', async () => {
    const database = new MemoryDatabase();
    await expect(database.recordUsage(principal, { idempotencyKey: 'usage-2', taskId: 'task', model: 'coder-pro', inputTokens: 1, outputTokens: 1, costCents: 9000 })).rejects.toMatchObject({ status: 402 });
  });

  it('isolates balances and idempotency by principal', async () => {
    const database = new MemoryDatabase();
    const other = { ...principal, userId: 'other', email: 'other@kai.com' };
    await database.topup(principal, { idempotencyKey: 'same', amountCents: 1000, channel: 'mock' });
    await database.topup(other, { idempotencyKey: 'same', amountCents: 2000, channel: 'mock' });
    expect((await database.getAccount(principal)).balanceCents).toBe(7840);
    expect((await database.getAccount(other)).balanceCents).toBe(8840);
  });
});
