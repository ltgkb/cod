import type { CardHourLedgerEntry, ComputeAssetsSummary, HostingApplicationV2 } from '@cod/contracts/compute-market-v2';

const DAY_MS = 24 * 60 * 60 * 1000;
const activeHostingStatuses = new Set<HostingApplicationV2['status']>(['running', 'action_required', 'offboarding']);

export interface EarningsPoint {
  date: string;
  label: string;
  cardHoursMilli: number;
}

export interface HostingRemaining {
  state: 'active' | 'expired' | 'none' | 'unknown';
  days: number | null;
  endsAt: string | null;
  activeContracts: number;
}

function dateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function hostingSettlementCredit(entry: CardHourLedgerEntry): number {
  if (entry.type !== 'hosting_settlement') return 0;
  return Math.max(0, entry.availableDeltaCardHoursMilli + entry.lockedDeltaCardHoursMilli);
}

export function cumulativeHostingEarnings(summary: ComputeAssetsSummary | null, entries: CardHourLedgerEntry[]): number | null {
  if (summary?.settledHostedCardHoursMilli !== null && summary?.settledHostedCardHoursMilli !== undefined) return summary.settledHostedCardHoursMilli;
  const settlements = entries.filter((entry) => entry.type === 'hosting_settlement');
  if (!settlements.length) return null;
  return settlements.reduce((total, entry) => total + hostingSettlementCredit(entry), 0);
}

export function buildEarningsSeries(entries: CardHourLedgerEntry[], now = new Date(), days = 30): EarningsPoint[] {
  const safeDays = Math.max(1, Math.floor(days));
  const end = new Date(now);
  end.setHours(0, 0, 0, 0);
  const start = new Date(end);
  start.setDate(start.getDate() - safeDays + 1);
  const totals = new Map<string, number>();

  for (const entry of entries) {
    const amount = hostingSettlementCredit(entry);
    if (!amount) continue;
    const createdAt = new Date(entry.createdAt);
    if (Number.isNaN(createdAt.getTime()) || createdAt < start || createdAt.getTime() >= end.getTime() + DAY_MS) continue;
    const key = dateKey(createdAt);
    totals.set(key, (totals.get(key) ?? 0) + amount);
  }

  return Array.from({ length: safeDays }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    return {
      date: dateKey(date),
      label: new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' }).format(date),
      cardHoursMilli: totals.get(dateKey(date)) ?? 0,
    };
  });
}

export function deriveHostingRemaining(applications: HostingApplicationV2[], now = new Date()): HostingRemaining {
  const active = applications.filter((application) => activeHostingStatuses.has(application.status));
  if (!active.length) return { state: 'none', days: null, endsAt: null, activeContracts: 0 };
  const endsAt = active
    .map((application) => application.hostingEndsAt)
    .filter((value): value is string => Boolean(value))
    .map((value) => ({ value, time: new Date(value).getTime() }))
    .filter((item) => Number.isFinite(item.time))
    .sort((a, b) => a.time - b.time)[0];
  if (!endsAt) return { state: 'unknown', days: null, endsAt: null, activeContracts: active.length };
  const days = Math.max(0, Math.ceil((endsAt.time - now.getTime()) / DAY_MS));
  return { state: days === 0 ? 'expired' : 'active', days, endsAt: endsAt.value, activeContracts: active.length };
}
