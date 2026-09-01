import { describe, expect, it } from 'vitest';
import type { CardHourLedgerEntry, HostingApplicationV2 } from '@cod/contracts/compute-market-v2';
import { buildEarningsSeries, cumulativeHostingEarnings, deriveHostingRemaining } from '../profileMetrics';

function ledgerEntry(id: string, amount: number, createdAt: string, type: CardHourLedgerEntry['type'] = 'hosting_settlement'): CardHourLedgerEntry {
  return { id, tenantId: 'tenant', userId: 'user', type, availableDeltaCardHoursMilli: amount, lockedDeltaCardHoursMilli: 0, reference: id, createdAt };
}

function hostingApplication(overrides: Partial<HostingApplicationV2> = {}): HostingApplicationV2 {
  return {
    subjectType: 'enterprise', verificationStatus: 'verified', contactName: '负责人', contactPhone: '13800001111', city: '香港', devices: [], rackUnits: 4, powerWatts: 4000,
    networkRequirement: '100G', hostingMonths: 12, availableFrom: '2026-09-01', slaRequirement: '99.9%', settlementPreference: 'COD 卡时', responsibilityAccepted: true, privacyAccepted: true,
    id: 'hosting-1', tenantId: 'tenant', userId: 'user', status: 'running', hostingStartedAt: '2026-08-01T00:00:00.000Z', hostingEndsAt: '2026-10-11T00:00:00.000Z', events: [], nextAction: null,
    responsibleParty: 'cod', revision: 1, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z', ...overrides,
  };
}

describe('compute profile metrics', () => {
  it('groups only positive hosting settlements into the 30-day series', () => {
    const now = new Date('2026-09-01T12:00:00.000Z');
    const series = buildEarningsSeries([
      ledgerEntry('one', 2_000, '2026-08-31T08:00:00.000Z'),
      ledgerEntry('two', 3_000, '2026-08-31T10:00:00.000Z'),
      ledgerEntry('purchase', 99_000, '2026-08-31T11:00:00.000Z', 'purchase'),
      ledgerEntry('old', 8_000, '2026-07-01T00:00:00.000Z'),
    ], now);
    expect(series).toHaveLength(30);
    expect(series.find((point) => point.date === '2026-08-31')?.cardHoursMilli).toBe(5_000);
    expect(series.reduce((total, point) => total + point.cardHoursMilli, 0)).toBe(5_000);
  });

  it('uses the settled summary as the cumulative source of truth and falls back to ledger entries', () => {
    const entries = [ledgerEntry('one', 2_000, '2026-08-31T08:00:00.000Z')];
    const summary = { availableCardHoursMilli: 0, lockedCardHoursMilli: 0, pendingHostedSettlementCardHoursMilli: null, availableHostedSettlementCardHoursMilli: null, settledHostedCardHoursMilli: 12_000, runningResourceCount: 0 };
    expect(cumulativeHostingEarnings(summary, entries)).toBe(12_000);
    expect(cumulativeHostingEarnings({ ...summary, settledHostedCardHoursMilli: null }, entries)).toBe(2_000);
    expect(cumulativeHostingEarnings({ ...summary, settledHostedCardHoursMilli: null }, [])).toBeNull();
  });

  it('uses the nearest explicit contract end and marks missing dates as unknown', () => {
    const now = new Date('2026-09-01T00:00:00.000Z');
    expect(deriveHostingRemaining([hostingApplication(), hostingApplication({ id: 'hosting-2', hostingEndsAt: '2026-12-01T00:00:00.000Z' })], now)).toMatchObject({ state: 'active', days: 40, activeContracts: 2 });
    expect(deriveHostingRemaining([hostingApplication({ hostingEndsAt: null })], now)).toMatchObject({ state: 'unknown', days: null });
    expect(deriveHostingRemaining([hostingApplication({ status: 'completed' })], now)).toMatchObject({ state: 'none', activeContracts: 0 });
  });
});
