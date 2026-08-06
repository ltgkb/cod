import { describe, expect, it } from 'vitest';
import { AccountStore } from './store.js';
import { MemoryDatabase } from './memory-database.js';
import type { Principal } from './database.js';

const principal: Principal = { userId: 'user_demo', tenantId: 'tenant_kai_com', email: 'developer@kai.com', role: 'member' };

describe('AccountStore', () => {
  it('applies top-ups and usage exactly once', () => {
    const store = new AccountStore();
    store.topup({ idempotencyKey: 'topup-1', amountCents: 1000, channel: 'mock' });
    store.topup({ idempotencyKey: 'topup-1', amountCents: 1000, channel: 'mock' });
    store.recordUsage({ idempotencyKey: 'usage-1', taskId: 'task', model: 'coder-pro', inputTokens: 10, outputTokens: 20, costCents: 120 });
    store.recordUsage({ idempotencyKey: 'usage-1', taskId: 'task', model: 'coder-pro', inputTokens: 10, outputTokens: 20, costCents: 120 });
    expect(store.getAccount().balanceCents).toBe(7720);
    expect(store.getLedger()).toHaveLength(2);
  });

  it('rejects spending above the wallet balance', () => {
    const store = new AccountStore();
    expect(() => store.recordUsage({ idempotencyKey: 'usage-2', taskId: 'task', model: 'coder-pro', inputTokens: 1, outputTokens: 1, costCents: 9000 })).toThrow('Insufficient balance');
  });
});

describe('MemoryDatabase wallet isolation', () => {
  it('isolates balances by principal and applies idempotency per owner', async () => {
    const database = new MemoryDatabase();
    const other = { ...principal, userId: 'other', email: 'other@kai.com' };
    await database.topup(principal, { idempotencyKey: 'same', amountCents: 1000, channel: 'mock' });
    await database.topup(other, { idempotencyKey: 'same', amountCents: 2000, channel: 'mock' });
    expect((await database.getAccount(principal)).balanceCents).toBe(7840);
    expect((await database.getAccount(other)).balanceCents).toBe(8840);
  });
});
