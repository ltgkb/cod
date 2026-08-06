import { randomUUID } from 'node:crypto';
import type { AccountSummary, UsageEvent } from '@cod/contracts';

export interface LedgerEntry {
  id: string;
  type: 'topup' | 'usage';
  amountCents: number;
  createdAt: string;
  reference: string;
}

export interface TopupRequest {
  idempotencyKey: string;
  amountCents: number;
  channel: 'mock' | 'wechat' | 'alipay';
}

export class AccountStore {
  private account: AccountSummary = {
    userId: 'user_demo',
    displayName: 'COD Developer',
    balanceCents: 6840,
    currency: 'CNY',
    plan: 'developer',
  };

  private readonly ledger: LedgerEntry[] = [];
  private readonly idempotency = new Map<string, LedgerEntry>();

  getAccount(): AccountSummary {
    return { ...this.account };
  }

  getLedger(): LedgerEntry[] {
    return [...this.ledger];
  }

  topup(request: TopupRequest): LedgerEntry {
    const existing = this.idempotency.get(request.idempotencyKey);
    if (existing) return existing;
    if (!Number.isInteger(request.amountCents) || request.amountCents < 100 || request.amountCents > 1_000_000) {
      throw new Error('Top-up amount must be between 100 and 1000000 cents');
    }
    const entry: LedgerEntry = {
      id: randomUUID(),
      type: 'topup',
      amountCents: request.amountCents,
      createdAt: new Date().toISOString(),
      reference: `${request.channel}:${request.idempotencyKey}`,
    };
    this.account = { ...this.account, balanceCents: this.account.balanceCents + request.amountCents };
    this.ledger.unshift(entry);
    this.idempotency.set(request.idempotencyKey, entry);
    return entry;
  }

  recordUsage(event: UsageEvent): LedgerEntry {
    const existing = this.idempotency.get(event.idempotencyKey);
    if (existing) return existing;
    if (!Number.isInteger(event.costCents) || event.costCents < 0) throw new Error('Usage cost is invalid');
    if (event.costCents > this.account.balanceCents) throw new Error('Insufficient balance');
    const entry: LedgerEntry = {
      id: randomUUID(),
      type: 'usage',
      amountCents: -event.costCents,
      createdAt: new Date().toISOString(),
      reference: `${event.model}:${event.taskId}`,
    };
    this.account = { ...this.account, balanceCents: this.account.balanceCents - event.costCents };
    this.ledger.unshift(entry);
    this.idempotency.set(event.idempotencyKey, entry);
    return entry;
  }
}
