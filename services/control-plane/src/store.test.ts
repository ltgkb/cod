import { describe, expect, it } from 'vitest';
import { AccountStore } from './store.js';

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
