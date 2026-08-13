import { randomUUID } from 'node:crypto';
import type { CardHourLedgerEntry, ComputeAssetsSummary, ComputePrincipal } from '@cod/contracts/compute-market-v2';
import { HttpError } from '../errors.js';

interface CardHourAccount {
  availableCardHoursMilli: number;
  lockedCardHoursMilli: number;
  entries: CardHourLedgerEntry[];
  mutations: Map<string, { fingerprint: string; entries: CardHourLedgerEntry[] }>;
}

export interface CardHourLedgerPort {
  summary(principal: ComputePrincipal): ComputeAssetsSummary;
  entries(principal: ComputePrincipal): CardHourLedgerEntry[];
  grant(principal: ComputePrincipal, amountCardHoursMilli: number, idempotencyKey: string, reference: string): CardHourLedgerEntry[];
  charge(principal: ComputePrincipal, amountCardHoursMilli: number, idempotencyKey: string, reference: string): CardHourLedgerEntry[];
  refund(principal: ComputePrincipal, amountCardHoursMilli: number, idempotencyKey: string, reference: string): CardHourLedgerEntry[];
  lock(principal: ComputePrincipal, amountCardHoursMilli: number, idempotencyKey: string, reference: string): CardHourLedgerEntry[];
  release(principal: ComputePrincipal, amountCardHoursMilli: number, idempotencyKey: string, reference: string): CardHourLedgerEntry[];
}

export class InMemoryCardHourLedger implements CardHourLedgerPort {
  private readonly accounts = new Map<string, CardHourAccount>();

  summary(principal: ComputePrincipal): ComputeAssetsSummary {
    const account = this.account(principal);
    return {
      availableCardHoursMilli: account.availableCardHoursMilli,
      lockedCardHoursMilli: account.lockedCardHoursMilli,
      pendingHostedSettlementCardHoursMilli: null,
      availableHostedSettlementCardHoursMilli: null,
      settledHostedCardHoursMilli: null,
      runningResourceCount: 0,
    };
  }

  entries(principal: ComputePrincipal): CardHourLedgerEntry[] {
    return this.account(principal).entries.map((entry) => ({ ...entry }));
  }

  grant(principal: ComputePrincipal, amount: number, key: string, reference: string): CardHourLedgerEntry[] {
    return this.mutate(principal, amount, 0, 'purchase', key, reference);
  }

  charge(principal: ComputePrincipal, amount: number, key: string, reference: string): CardHourLedgerEntry[] {
    return this.mutate(principal, -amount, 0, 'rental_charge', key, reference);
  }

  refund(principal: ComputePrincipal, amount: number, key: string, reference: string): CardHourLedgerEntry[] {
    return this.mutate(principal, amount, 0, 'rental_refund', key, reference);
  }

  lock(principal: ComputePrincipal, amount: number, key: string, reference: string): CardHourLedgerEntry[] {
    return this.mutate(principal, -amount, amount, 'trade_lock', key, reference);
  }

  release(principal: ComputePrincipal, amount: number, key: string, reference: string): CardHourLedgerEntry[] {
    return this.mutate(principal, amount, -amount, 'trade_release', key, reference);
  }

  private mutate(principal: ComputePrincipal, availableDelta: number, lockedDelta: number, type: CardHourLedgerEntry['type'], idempotencyKey: string, reference: string): CardHourLedgerEntry[] {
    if (!Number.isInteger(Math.abs(availableDelta)) || !Number.isInteger(Math.abs(lockedDelta)) || (!availableDelta && !lockedDelta)) throw new HttpError('卡时数必须是正整数千分位', 400, 'invalid_card_hours');
    const account = this.account(principal);
    const fingerprint = `${type}:${availableDelta}:${lockedDelta}:${reference}`;
    const existing = account.mutations.get(idempotencyKey);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new HttpError('幂等键已用于不同的卡时操作', 409, 'idempotency_conflict');
      return existing.entries.map((entry) => ({ ...entry }));
    }
    if (account.availableCardHoursMilli + availableDelta < 0) throw new HttpError('可用卡时不足', 402, 'insufficient_card_hours');
    if (account.lockedCardHoursMilli + lockedDelta < 0) throw new HttpError('冻结卡时不足', 409, 'insufficient_locked_card_hours');
    const entry: CardHourLedgerEntry = {
      id: randomUUID(), tenantId: principal.tenantId, userId: principal.userId, type,
      availableDeltaCardHoursMilli: availableDelta, lockedDeltaCardHoursMilli: lockedDelta,
      reference, createdAt: new Date().toISOString(),
    };
    account.availableCardHoursMilli += availableDelta;
    account.lockedCardHoursMilli += lockedDelta;
    account.entries.unshift(entry);
    account.mutations.set(idempotencyKey, { fingerprint, entries: [entry] });
    return [{ ...entry }];
  }

  private account(principal: ComputePrincipal): CardHourAccount {
    const key = `${principal.tenantId}:${principal.userId}`;
    let account = this.accounts.get(key);
    if (!account) {
      account = { availableCardHoursMilli: 0, lockedCardHoursMilli: 0, entries: [], mutations: new Map() };
      this.accounts.set(key, account);
    }
    return account;
  }
}
