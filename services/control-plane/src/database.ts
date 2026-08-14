import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import type { AccountSummary, DeviceRecord, TaskStatus, UsageEvent } from '@cod/contracts';
import { HttpError } from './errors.js';
import type { ComputeRequest, ComputeRequestInput } from './compute-market.js';

export interface Principal {
  userId: string;
  tenantId: string;
  email: string;
  role: 'member' | 'admin';
}

export interface IdentityRecord {
  principal: Principal;
  passwordHash: string | null;
  inviteCode: string | null;
  referredByUserId: string | null;
  referralCodeUsed: string | null;
}

export interface RegistrationResult {
  identity: IdentityRecord;
  created: boolean;
}

export interface ReferralSummary {
  inviteCode: string;
  referredUsers: number;
  commissionRateBps: number;
  pendingCommissionCents: number;
  settledCommissionCents: number;
}

export interface LedgerEntry {
  id: string;
  type: 'topup' | 'usage' | 'pack_purchase' | 'credit_grant' | 'trial_credit';
  amountCents: number;
  walletAmountCents: number;
  creditAmountCents: number;
  createdAt: string;
  reference: string;
  sourceId: string | null;
  upstreamSourceId?: string | null;
  model: string | null;
  paymentDirection: string | null;
  commissionRateBps?: number;
  commissionCents?: number;
}

export interface CreditPackDefinition {
  id: 'starter' | 'standard' | 'pro' | 'team';
  name: string;
  priceCents: number;
  creditCents: number;
  bonusPercent: number;
  validityDays: 180;
}

export interface CreditGrant {
  id: string;
  packId: string;
  name: string;
  originalCents: number;
  remainingCents: number;
  purchasedAt: string;
  expiresAt: string;
  status: 'active' | 'depleted' | 'expired';
}

export interface CreditSummary {
  availableCents: number;
  grants: CreditGrant[];
}

export const creditPackCatalog: readonly CreditPackDefinition[] = [
  { id: 'starter', name: 'AI.KAI.COM 入门额度包', priceCents: 2_000, creditCents: 2_000, bonusPercent: 0, validityDays: 180 },
  { id: 'standard', name: 'AI.KAI.COM 标准额度包', priceCents: 10_000, creditCents: 10_400, bonusPercent: 4, validityDays: 180 },
  { id: 'pro', name: 'AI.KAI.COM 进阶额度包', priceCents: 20_000, creditCents: 21_200, bonusPercent: 6, validityDays: 180 },
  { id: 'team', name: 'AI.KAI.COM 团队额度包', priceCents: 40_000, creditCents: 43_600, bonusPercent: 9, validityDays: 180 },
] as const;

export interface TopupRequest {
  idempotencyKey: string;
  amountCents: number;
  channel: 'pilot' | 'wechat' | 'alipay';
}

export interface PaymentOrder {
  id: string;
  amountCents: number;
  currency: 'CNY';
  channel: 'wechat' | 'alipay';
  status: 'pending' | 'paid' | 'failed' | 'expired' | 'refunded';
  providerPaymentId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PaymentOrderRequest {
  amountCents: number;
  channel: PaymentOrder['channel'];
  idempotencyKey: string;
}

export interface PaymentCompletion {
  orderId: string;
  amountCents: number;
  currency: 'CNY';
  channel: PaymentOrder['channel'];
  providerPaymentId: string;
  providerEventId: string;
}

export interface SyncedTask {
  id: string;
  title: string;
  status: TaskStatus;
  deviceId: string;
  updatedAt: string;
  version: number;
  result: string | null;
  error: string | null;
}

export interface TaskOutcome { result?: string | null; error?: string | null }

export interface TaskEvent {
  cursor: number;
  type: 'device.registered' | 'device.heartbeat' | 'task.created' | 'task.updated';
  entityId: string;
  data: unknown;
  createdAt: string;
}

export interface AuditEntry {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  data: unknown;
  createdAt: string;
}

export interface CodDatabase {
  initialize(): Promise<void>;
  health(): Promise<boolean>;
  ensurePrincipal(principal: Principal): Promise<void>;
  findIdentityByEmail(email: string): Promise<IdentityRecord | null>;
  registerIdentity(principal: Principal, passwordHash: string, inviteCode: string | null, allowExisting: boolean): Promise<RegistrationResult>;
  getReferralSummary(principal: Principal): Promise<ReferralSummary>;
  getAccount(principal: Principal): Promise<AccountSummary>;
  getLedger(principal: Principal): Promise<LedgerEntry[]>;
  getCreditSummary(principal: Principal): Promise<CreditSummary>;
  purchaseCreditPack(principal: Principal, packId: string, idempotencyKey: string): Promise<{ grant: CreditGrant; account: AccountSummary; summary: CreditSummary }>;
  topup(principal: Principal, request: TopupRequest): Promise<LedgerEntry>;
  createPaymentOrder(principal: Principal, request: PaymentOrderRequest): Promise<PaymentOrder>;
  getPaymentOrder(principal: Principal, orderId: string): Promise<PaymentOrder>;
  completePaymentOrder(event: PaymentCompletion): Promise<{ order: PaymentOrder; entry: LedgerEntry }>;
  recordUsage(principal: Principal, event: UsageEvent): Promise<LedgerEntry>;
  reserveUsage(principal: Principal, reservationId: string, amountCents: number): Promise<void>;
  settleUsage(principal: Principal, reservationId: string, event: UsageEvent): Promise<LedgerEntry>;
  releaseUsage(principal: Principal, reservationId: string): Promise<void>;
  createComputeRequest(principal: Principal, input: ComputeRequestInput, idempotencyKey: string): Promise<ComputeRequest>;
  listComputeRequests(principal: Principal): Promise<ComputeRequest[]>;
  listDevices(principal: Principal): Promise<DeviceRecord[]>;
  registerDevice(principal: Principal, input: Pick<DeviceRecord, 'name' | 'platform'>): Promise<DeviceRecord>;
  heartbeat(principal: Principal, deviceId: string): Promise<DeviceRecord>;
  listTasks(principal: Principal): Promise<SyncedTask[]>;
  getTask(principal: Principal, taskId: string): Promise<SyncedTask>;
  createTask(principal: Principal, input: Pick<SyncedTask, 'title' | 'deviceId'>): Promise<SyncedTask>;
  updateTask(principal: Principal, taskId: string, status: TaskStatus, expectedVersion: number, outcome?: TaskOutcome): Promise<SyncedTask>;
  eventsAfter(principal: Principal, cursor: number): Promise<TaskEvent[]>;
  audit(principal: Principal, action: string, entityType: string, entityId: string | null, data?: unknown): Promise<void>;
  listAudit(principal: Principal, limit: number): Promise<AuditEntry[]>;
  close(): Promise<void>;
}

const devicePlatforms = new Set<DeviceRecord['platform']>(['macos', 'windows', 'linux', 'web', 'mobile']);
const taskTransitions: Record<TaskStatus, ReadonlySet<TaskStatus>> = {
  draft: new Set(['running', 'failed', 'cancelled']),
  running: new Set(['waiting', 'complete', 'failed', 'cancelled']),
  waiting: new Set(['running', 'complete', 'failed', 'cancelled']),
  complete: new Set(['running']),
  failed: new Set(['running']),
  cancelled: new Set(['running']),
};

export function validateDeviceInput(input: Pick<DeviceRecord, 'name' | 'platform'>): void {
  if (!input.name?.trim()) throw new HttpError('Device name is required', 400, 'invalid_device');
  if (!devicePlatforms.has(input.platform)) throw new HttpError('Device platform is invalid', 400, 'invalid_device_platform');
}

export function validateTaskTransition(current: TaskStatus, next: TaskStatus): void {
  if (current === next) return;
  if (!taskTransitions[current].has(next)) throw new HttpError(`Task cannot move from ${current} to ${next}`, 409, 'invalid_task_transition');
}

export function validateTaskOutcome(status: TaskStatus, result: string | null, error: string | null): void {
  if (status === 'complete' && !result?.trim()) throw new HttpError('Completed tasks require a result', 400, 'task_result_required');
  if (status === 'failed' && !error?.trim()) throw new HttpError('Failed tasks require an error', 400, 'task_error_required');
}

const schema = `
CREATE TABLE IF NOT EXISTS cod_users (
  tenant_id text NOT NULL, user_id text NOT NULL, email text NOT NULL, display_name text NOT NULL,
  balance_cents bigint NOT NULL DEFAULT 0 CHECK (balance_cents >= 0), currency text NOT NULL DEFAULT 'CNY', plan text NOT NULL DEFAULT 'developer',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id, user_id), UNIQUE (tenant_id, email)
);
ALTER TABLE cod_users ALTER COLUMN balance_cents SET DEFAULT 0;
ALTER TABLE cod_users ADD COLUMN IF NOT EXISTS password_hash text;
ALTER TABLE cod_users ADD COLUMN IF NOT EXISTS invite_code text;
ALTER TABLE cod_users ADD COLUMN IF NOT EXISTS referred_by_tenant_id text;
ALTER TABLE cod_users ADD COLUMN IF NOT EXISTS referred_by_user_id text;
ALTER TABLE cod_users ADD COLUMN IF NOT EXISTS referral_code_used text;
ALTER TABLE cod_users ADD COLUMN IF NOT EXISTS referral_commission_rate_bps integer NOT NULL DEFAULT 0 CHECK (referral_commission_rate_bps >= 0 AND referral_commission_rate_bps <= 10000);
ALTER TABLE cod_users ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'member' CHECK (role IN ('member','admin'));
CREATE UNIQUE INDEX IF NOT EXISTS cod_users_email_global_unique ON cod_users (lower(email));
CREATE UNIQUE INDEX IF NOT EXISTS cod_users_invite_code_unique ON cod_users (upper(invite_code)) WHERE invite_code IS NOT NULL;
CREATE TABLE IF NOT EXISTS cod_ledger (
  id uuid PRIMARY KEY, tenant_id text NOT NULL, user_id text NOT NULL, type text NOT NULL,
  amount_cents bigint NOT NULL, reference text NOT NULL, idempotency_key text NOT NULL, source_id text, model_id text, payment_direction text, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id, idempotency_key)
);
ALTER TABLE cod_ledger DROP CONSTRAINT IF EXISTS cod_ledger_type_check;
ALTER TABLE cod_ledger ADD CONSTRAINT cod_ledger_type_check CHECK (type IN ('topup','usage','pack_purchase','credit_grant','trial_credit'));
ALTER TABLE cod_ledger ADD COLUMN IF NOT EXISTS source_id text;
ALTER TABLE cod_ledger ADD COLUMN IF NOT EXISTS upstream_source_id text;
ALTER TABLE cod_ledger ADD COLUMN IF NOT EXISTS model_id text;
ALTER TABLE cod_ledger ADD COLUMN IF NOT EXISTS payment_direction text;
ALTER TABLE cod_ledger ADD COLUMN IF NOT EXISTS commission_rate_bps integer NOT NULL DEFAULT 0;
ALTER TABLE cod_ledger ADD COLUMN IF NOT EXISTS commission_cents bigint NOT NULL DEFAULT 0;
ALTER TABLE cod_ledger ADD COLUMN IF NOT EXISTS wallet_amount_cents bigint NOT NULL DEFAULT 0;
ALTER TABLE cod_ledger ADD COLUMN IF NOT EXISTS credit_amount_cents bigint NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS cod_credit_grants (
  id uuid PRIMARY KEY, tenant_id text NOT NULL, user_id text NOT NULL, pack_id text NOT NULL, name text NOT NULL,
  purchase_price_cents bigint NOT NULL CHECK (purchase_price_cents >= 0), original_cents bigint NOT NULL CHECK (original_cents > 0),
  remaining_cents bigint NOT NULL CHECK (remaining_cents >= 0), purchased_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('active','depleted','expired')), idempotency_key text NOT NULL,
  UNIQUE (tenant_id,user_id,idempotency_key)
);
ALTER TABLE cod_credit_grants DROP CONSTRAINT IF EXISTS cod_credit_grants_purchase_price_cents_check;
ALTER TABLE cod_credit_grants ADD CONSTRAINT cod_credit_grants_purchase_price_cents_check CHECK (purchase_price_cents >= 0);
CREATE TABLE IF NOT EXISTS cod_usage_reservations (
  id uuid PRIMARY KEY, tenant_id text NOT NULL, user_id text NOT NULL, amount_cents bigint NOT NULL CHECK (amount_cents >= 0),
  status text NOT NULL CHECK (status IN ('reserved','settled','released')), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE cod_usage_reservations ADD COLUMN IF NOT EXISTS wallet_cents bigint;
UPDATE cod_usage_reservations SET wallet_cents=amount_cents WHERE wallet_cents IS NULL;
ALTER TABLE cod_usage_reservations ALTER COLUMN wallet_cents SET DEFAULT 0;
ALTER TABLE cod_usage_reservations ALTER COLUMN wallet_cents SET NOT NULL;
ALTER TABLE cod_usage_reservations ADD COLUMN IF NOT EXISTS grant_allocations jsonb NOT NULL DEFAULT '[]';
CREATE TABLE IF NOT EXISTS cod_payment_orders (
  id uuid PRIMARY KEY, tenant_id text NOT NULL, user_id text NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents >= 100), currency text NOT NULL CHECK (currency = 'CNY'),
  channel text NOT NULL CHECK (channel IN ('wechat','alipay')), status text NOT NULL CHECK (status IN ('pending','paid','failed','expired','refunded')),
  idempotency_key text NOT NULL, provider_payment_id text, provider_event_id text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,user_id,idempotency_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS cod_payment_orders_provider_event_unique ON cod_payment_orders (provider_event_id) WHERE provider_event_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS cod_payment_orders_provider_payment_unique ON cod_payment_orders (channel,provider_payment_id) WHERE provider_payment_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS cod_compute_requests (
  id uuid PRIMARY KEY, tenant_id text NOT NULL, user_id text NOT NULL, email text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('rental','supply','installment')), offer_id text,
  status text NOT NULL CHECK (status IN ('submitted','contacting','quoted','closed')) DEFAULT 'submitted',
  payload jsonb NOT NULL DEFAULT '{}', idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,user_id,idempotency_key)
);
CREATE TABLE IF NOT EXISTS cod_devices (
  id uuid PRIMARY KEY, tenant_id text NOT NULL, user_id text NOT NULL, name text NOT NULL, platform text NOT NULL,
  status text NOT NULL, last_seen_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS cod_tasks (
  id uuid PRIMARY KEY, tenant_id text NOT NULL, user_id text NOT NULL, title text NOT NULL, status text NOT NULL,
  device_id uuid NOT NULL REFERENCES cod_devices(id), version integer NOT NULL DEFAULT 1, result text, error text, updated_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE cod_tasks ADD COLUMN IF NOT EXISTS result text;
ALTER TABLE cod_tasks ADD COLUMN IF NOT EXISTS error text;
CREATE TABLE IF NOT EXISTS cod_events (
  cursor bigserial PRIMARY KEY, tenant_id text NOT NULL, user_id text NOT NULL, type text NOT NULL, entity_id text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS cod_audit (
  id uuid PRIMARY KEY, tenant_id text NOT NULL, user_id text NOT NULL, action text NOT NULL, entity_type text NOT NULL,
  entity_id text, data jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cod_devices_owner_idx ON cod_devices(tenant_id, user_id);
CREATE INDEX IF NOT EXISTS cod_tasks_owner_idx ON cod_tasks(tenant_id, user_id);
CREATE INDEX IF NOT EXISTS cod_events_owner_cursor_idx ON cod_events(tenant_id, user_id, cursor);
CREATE INDEX IF NOT EXISTS cod_audit_owner_created_idx ON cod_audit(tenant_id, user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS cod_payment_orders_owner_created_idx ON cod_payment_orders(tenant_id, user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS cod_credit_grants_owner_expiry_idx ON cod_credit_grants(tenant_id, user_id, expires_at);
CREATE INDEX IF NOT EXISTS cod_compute_requests_owner_created_idx ON cod_compute_requests(tenant_id, user_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS cod_payment_orders_provider_payment_idx ON cod_payment_orders(channel, provider_payment_id) WHERE provider_payment_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS cod_payment_orders_provider_event_idx ON cod_payment_orders(provider_event_id) WHERE provider_event_id IS NOT NULL;
`;

const accountFromRow = (row: Record<string, unknown>): AccountSummary => ({
  userId: String(row.user_id), displayName: String(row.display_name), balanceCents: Number(row.balance_cents), currency: 'CNY', plan: row.plan === 'team' ? 'team' : 'developer', role: row.role === 'admin' ? 'admin' : 'member', billingExempt: row.role === 'admin',
});
const principalFromUserRow = (row: Record<string, unknown>): Principal => ({ userId: String(row.user_id), tenantId: String(row.tenant_id), email: String(row.email), role: row.role === 'admin' ? 'admin' : 'member' });
const identityFromRow = (row: Record<string, unknown>): IdentityRecord => ({
  principal: principalFromUserRow(row),
  passwordHash: row.password_hash ? String(row.password_hash) : null,
  inviteCode: row.invite_code ? String(row.invite_code) : null,
  referredByUserId: row.referred_by_user_id ? String(row.referred_by_user_id) : null,
  referralCodeUsed: row.referral_code_used ? String(row.referral_code_used) : null,
});
const ledgerFromRow = (row: Record<string, unknown>): LedgerEntry => ({ id: String(row.id), type: row.type as LedgerEntry['type'], amountCents: Number(row.amount_cents), walletAmountCents: Number(row.wallet_amount_cents ?? 0), creditAmountCents: Number(row.credit_amount_cents ?? 0), reference: String(row.reference), sourceId: row.source_id ? String(row.source_id) : null, upstreamSourceId: row.upstream_source_id ? String(row.upstream_source_id) : null, model: row.model_id ? String(row.model_id) : null, paymentDirection: row.payment_direction ? String(row.payment_direction) : null, commissionRateBps: Number(row.commission_rate_bps ?? 0), commissionCents: Number(row.commission_cents ?? 0), createdAt: new Date(String(row.created_at)).toISOString() });
const creditGrantFromRow = (row: Record<string, unknown>): CreditGrant => ({ id: String(row.id), packId: String(row.pack_id), name: String(row.name), originalCents: Number(row.original_cents), remainingCents: Number(row.remaining_cents), purchasedAt: new Date(String(row.purchased_at)).toISOString(), expiresAt: new Date(String(row.expires_at)).toISOString(), status: row.status as CreditGrant['status'] });
interface GrantAllocation { grantId: string; amountCents: number }
interface FundsAllocation { walletCents: number; grantAllocations: GrantAllocation[] }
const parseGrantAllocations = (value: unknown): GrantAllocation[] => Array.isArray(value) ? value.flatMap((item) => {
  if (!item || typeof item !== 'object') return [];
  const grantId = String((item as Record<string, unknown>).grantId ?? '');
  const amountCents = Number((item as Record<string, unknown>).amountCents ?? 0);
  return grantId && Number.isInteger(amountCents) && amountCents > 0 ? [{ grantId, amountCents }] : [];
}) : [];
const paymentOrderFromRow = (row: Record<string, unknown>): PaymentOrder => ({ id: String(row.id), amountCents: Number(row.amount_cents), currency: 'CNY', channel: row.channel as PaymentOrder['channel'], status: row.status as PaymentOrder['status'], providerPaymentId: row.provider_payment_id ? String(row.provider_payment_id) : null, createdAt: new Date(String(row.created_at)).toISOString(), updatedAt: new Date(String(row.updated_at)).toISOString() });
const computeRequestFromRow = (row: Record<string, unknown>): ComputeRequest => {
  const payload = row.payload && typeof row.payload === 'object' ? row.payload as ComputeRequestInput : {} as ComputeRequestInput;
  return { ...payload, id: String(row.id), email: String(row.email), kind: row.kind as ComputeRequest['kind'], offerId: row.offer_id ? String(row.offer_id) : null, durationHours: payload.durationHours ?? null, termMonths: payload.termMonths ?? null, status: row.status as ComputeRequest['status'], createdAt: new Date(String(row.created_at)).toISOString(), updatedAt: new Date(String(row.updated_at)).toISOString() };
};
const deviceFromRow = (row: Record<string, unknown>): DeviceRecord => {
  const lastSeenAt = new Date(String(row.last_seen_at)).toISOString();
  const stale = Date.now() - new Date(lastSeenAt).getTime() > 45_000;
  return { id: String(row.id), name: String(row.name), platform: row.platform as DeviceRecord['platform'], status: stale ? 'offline' : row.status as DeviceRecord['status'], lastSeenAt };
};
const taskFromRow = (row: Record<string, unknown>): SyncedTask => ({ id: String(row.id), title: String(row.title), status: row.status as TaskStatus, deviceId: String(row.device_id), updatedAt: new Date(String(row.updated_at)).toISOString(), version: Number(row.version), result: row.result === null || row.result === undefined ? null : String(row.result), error: row.error === null || row.error === undefined ? null : String(row.error) });

export class PostgresDatabase implements CodDatabase {
  private readonly pool: Pool;
  constructor(databaseUrl: string) { this.pool = new Pool({ connectionString: databaseUrl, max: 10, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000 }); }
  async initialize() {
    await this.pool.query(schema);
    await this.transaction(async (client) => {
      const orphaned = await client.query(`UPDATE cod_usage_reservations SET status='released',updated_at=now() WHERE status='reserved' RETURNING tenant_id,user_id,wallet_cents,grant_allocations`);
      const refunds = new Map<string, { tenantId: string; userId: string; amountCents: number }>();
      for (const row of orphaned.rows) {
        const tenantId=String(row.tenant_id); const userId=String(row.user_id); const key=`${tenantId}:${userId}`;
        const current=refunds.get(key); refunds.set(key,{tenantId,userId,amountCents:(current?.amountCents??0)+Number(row.wallet_cents)});
        await this.restoreGrants(client, parseGrantAllocations(row.grant_allocations));
      }
      for (const refund of refunds.values()) await client.query('UPDATE cod_users SET balance_cents=balance_cents+$3,updated_at=now() WHERE tenant_id=$1 AND user_id=$2',[refund.tenantId,refund.userId,refund.amountCents]);
    });
  }
  async close() { await this.pool.end(); }
  async health() { try { await this.pool.query('SELECT 1'); return true; } catch { return false; } }
  async ensurePrincipal(p: Principal) {
    await this.transaction(async(client)=>{
      const inserted=await client.query(`INSERT INTO cod_users (tenant_id,user_id,email,display_name) VALUES ($1,$2,$3,$4) ON CONFLICT (tenant_id,user_id) DO NOTHING RETURNING user_id`,[p.tenantId,p.userId,p.email,p.email.split('@')[0]]);
      if(!inserted.rows[0]){await client.query(`UPDATE cod_users SET email=$3,updated_at=now() WHERE tenant_id=$1 AND user_id=$2`,[p.tenantId,p.userId,p.email]);return;}
      const grantId=randomUUID();const key='trial-credit-v1';
      await client.query(`INSERT INTO cod_credit_grants (id,tenant_id,user_id,pack_id,name,purchase_price_cents,original_cents,remaining_cents,expires_at,status,idempotency_key) VALUES ($1,$2,$3,'trial','新用户试用金',0,1000,1000,now()+interval '30 days','active',$4)`,[grantId,p.tenantId,p.userId,key]);
      await client.query(`INSERT INTO cod_ledger (id,tenant_id,user_id,type,amount_cents,wallet_amount_cents,credit_amount_cents,reference,idempotency_key,payment_direction) VALUES ($1,$2,$3,'trial_credit',1000,0,1000,'新用户试用金',$4,'平台赠送 → COD 使用额度')`,[randomUUID(),p.tenantId,p.userId,key]);
    });
  }
  async findIdentityByEmail(email: string) {
    const { rows } = await this.pool.query('SELECT * FROM cod_users WHERE lower(email)=lower($1) LIMIT 1',[email]);
    return rows[0] ? identityFromRow(rows[0]) : null;
  }
  async registerIdentity(p: Principal, passwordHash: string, inviteCode: string | null, allowExisting: boolean) {
    return this.transaction(async(client)=>{
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`auth-register:${p.email.toLowerCase()}`]);
      const current=await client.query('SELECT * FROM cod_users WHERE lower(email)=lower($1) LIMIT 1 FOR UPDATE',[p.email]);
      const personalInviteCode=`KAI-${p.userId.replace(/^usr_/,'').slice(0,10).toUpperCase()}`;
      if(current.rows[0]){
        if(current.rows[0].password_hash)throw new HttpError('该邮箱已经注册，请直接登录',409,'email_registered');
        if(!allowExisting)throw new HttpError('这是旧试点账号，请使用旧访问码完成一次性迁移',409,'legacy_migration_required');
        const {rows}=await client.query(`UPDATE cod_users SET password_hash=$1,invite_code=COALESCE(invite_code,$2),updated_at=now() WHERE tenant_id=$3 AND user_id=$4 RETURNING *`,[passwordHash,personalInviteCode,current.rows[0].tenant_id,current.rows[0].user_id]);
        return {identity:identityFromRow(rows[0]),created:false};
      }
      let inviter:Record<string,unknown>|null=null;
      if(inviteCode){
        const found=await client.query('SELECT tenant_id,user_id,invite_code FROM cod_users WHERE upper(invite_code)=upper($1) LIMIT 1',[inviteCode]);
        inviter=found.rows[0]??null;
        if(!inviter)throw new HttpError('邀请码无效',400,'invalid_invite_code');
      }
      const inserted=await client.query(`INSERT INTO cod_users (tenant_id,user_id,email,display_name,password_hash,invite_code,referred_by_tenant_id,referred_by_user_id,referral_code_used) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,[p.tenantId,p.userId,p.email,p.email.split('@')[0],passwordHash,personalInviteCode,inviter?.tenant_id??null,inviter?.user_id??null,inviter?.invite_code??null]);
      const grantId=randomUUID();const key='trial-credit-v1';
      await client.query(`INSERT INTO cod_credit_grants (id,tenant_id,user_id,pack_id,name,purchase_price_cents,original_cents,remaining_cents,expires_at,status,idempotency_key) VALUES ($1,$2,$3,'trial','新用户试用金',0,1000,1000,now()+interval '30 days','active',$4)`,[grantId,p.tenantId,p.userId,key]);
      await client.query(`INSERT INTO cod_ledger (id,tenant_id,user_id,type,amount_cents,wallet_amount_cents,credit_amount_cents,reference,idempotency_key,payment_direction) VALUES ($1,$2,$3,'trial_credit',1000,0,1000,'新用户试用金',$4,'平台赠送 → COD 使用额度')`,[randomUUID(),p.tenantId,p.userId,key]);
      return {identity:identityFromRow(inserted.rows[0]),created:true};
    });
  }
  async getReferralSummary(p: Principal) {
    const {rows}=await this.pool.query(`SELECT u.invite_code,u.referral_commission_rate_bps,(SELECT count(*) FROM cod_users r WHERE r.referred_by_tenant_id=u.tenant_id AND r.referred_by_user_id=u.user_id)::integer AS referred_users FROM cod_users u WHERE u.tenant_id=$1 AND u.user_id=$2`,[p.tenantId,p.userId]);
    if(!rows[0]||!rows[0].invite_code)throw new HttpError('Referral profile not found',404,'referral_profile_not_found');
    return {inviteCode:String(rows[0].invite_code),referredUsers:Number(rows[0].referred_users),commissionRateBps:Number(rows[0].referral_commission_rate_bps),pendingCommissionCents:0,settledCommissionCents:0};
  }
  async getAccount(p: Principal) { const { rows } = await this.pool.query('SELECT * FROM cod_users WHERE tenant_id=$1 AND user_id=$2',[p.tenantId,p.userId]); if (!rows[0]) throw new HttpError('Account not found',404,'account_not_found'); return accountFromRow(rows[0]); }
  async getLedger(p: Principal) { const { rows } = await this.pool.query('SELECT * FROM cod_ledger WHERE tenant_id=$1 AND user_id=$2 ORDER BY created_at DESC LIMIT 200',[p.tenantId,p.userId]); return rows.map(ledgerFromRow); }
  async getCreditSummary(p: Principal) {
    await this.pool.query(`UPDATE cod_credit_grants SET status='expired' WHERE tenant_id=$1 AND user_id=$2 AND status='active' AND expires_at<=now()`,[p.tenantId,p.userId]);
    const { rows } = await this.pool.query(`SELECT * FROM cod_credit_grants WHERE tenant_id=$1 AND user_id=$2 ORDER BY expires_at,purchased_at`,[p.tenantId,p.userId]);
    const grants=rows.map(creditGrantFromRow);
    return { availableCents: grants.filter((grant)=>grant.status==='active').reduce((total,grant)=>total+grant.remainingCents,0), grants };
  }
  async purchaseCreditPack(p: Principal, packId: string, idempotencyKey: string) {
    const pack=creditPackCatalog.find((item)=>item.id===packId);
    if(!pack)throw new HttpError('Credit pack not found',404,'credit_pack_not_found');
    if(!idempotencyKey||idempotencyKey.length>200)throw new HttpError('Credit pack idempotency key is invalid',400,'invalid_idempotency_key');
    const grant=await this.transaction(async(client)=>{
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`credit-pack:${p.tenantId}:${p.userId}:${idempotencyKey}`]);
      const existing=await client.query('SELECT * FROM cod_credit_grants WHERE tenant_id=$1 AND user_id=$2 AND idempotency_key=$3',[p.tenantId,p.userId,idempotencyKey]);
      if(existing.rows[0]){
        if(String(existing.rows[0].pack_id)!==pack.id)throw new HttpError('Idempotency key was already used with another credit pack',409,'idempotency_conflict');
        return creditGrantFromRow(existing.rows[0]);
      }
      const account=await client.query('SELECT balance_cents FROM cod_users WHERE tenant_id=$1 AND user_id=$2 FOR UPDATE',[p.tenantId,p.userId]);
      if(!account.rows[0]||Number(account.rows[0].balance_cents)<pack.priceCents)throw new HttpError('Insufficient wallet balance',402,'insufficient_balance');
      const id=randomUUID();
      const inserted=await client.query(`INSERT INTO cod_credit_grants (id,tenant_id,user_id,pack_id,name,purchase_price_cents,original_cents,remaining_cents,expires_at,status,idempotency_key) VALUES ($1,$2,$3,$4,$5,$6,$7,$7,now()+interval '180 days','active',$8) RETURNING *`,[id,p.tenantId,p.userId,pack.id,pack.name,pack.priceCents,pack.creditCents,idempotencyKey]);
      await client.query('UPDATE cod_users SET balance_cents=balance_cents-$3,updated_at=now() WHERE tenant_id=$1 AND user_id=$2',[p.tenantId,p.userId,pack.priceCents]);
      await client.query(`INSERT INTO cod_ledger (id,tenant_id,user_id,type,amount_cents,wallet_amount_cents,credit_amount_cents,reference,idempotency_key,payment_direction) VALUES ($1,$2,$3,'pack_purchase',$4,$4,0,$5,$6,'COD 钱包 → 180 天额度包'),($7,$2,$3,'credit_grant',$8,0,$8,$5,$9,'额度包 → COD 使用额度')`,[randomUUID(),p.tenantId,p.userId,-pack.priceCents,pack.name,`pack-purchase:${idempotencyKey}`,randomUUID(),pack.creditCents,`credit-grant:${idempotencyKey}`]);
      return creditGrantFromRow(inserted.rows[0]);
    });
    return { grant, account: await this.getAccount(p), summary: await this.getCreditSummary(p) };
  }
  async topup(p: Principal, request: TopupRequest) {
    if (!Number.isInteger(request.amountCents) || request.amountCents < 100 || request.amountCents > 1_000_000) throw new HttpError('Top-up amount must be between 100 and 1000000 cents',400,'invalid_topup');
    return this.transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${p.tenantId}:${p.userId}:${request.idempotencyKey}`]);
      const existing = await client.query('SELECT * FROM cod_ledger WHERE tenant_id=$1 AND user_id=$2 AND idempotency_key=$3',[p.tenantId,p.userId,request.idempotencyKey]); if (existing.rows[0]) return ledgerFromRow(existing.rows[0]);
      const id=randomUUID(); const reference=`${request.channel}:${request.idempotencyKey}`;
      const inserted=await client.query(`INSERT INTO cod_ledger (id,tenant_id,user_id,type,amount_cents,wallet_amount_cents,reference,idempotency_key,payment_direction) VALUES ($1,$2,$3,'topup',$4,$4,$5,$6,$7) RETURNING *`,[id,p.tenantId,p.userId,request.amountCents,reference,request.idempotencyKey,'用户 → COD 钱包']);
      await client.query('UPDATE cod_users SET balance_cents=balance_cents+$3,updated_at=now() WHERE tenant_id=$1 AND user_id=$2',[p.tenantId,p.userId,request.amountCents]); return ledgerFromRow(inserted.rows[0]);
    });
  }
  async createPaymentOrder(p: Principal, request: PaymentOrderRequest) {
    if (!Number.isInteger(request.amountCents) || request.amountCents < 100 || request.amountCents > 1_000_000) throw new HttpError('Payment amount must be between 100 and 1000000 cents',400,'invalid_payment_amount');
    if (request.channel !== 'wechat' && request.channel !== 'alipay') throw new HttpError('Payment channel is invalid',400,'invalid_payment_channel');
    if (!request.idempotencyKey || request.idempotencyKey.length > 200) throw new HttpError('Payment idempotency key is invalid',400,'invalid_idempotency_key');
    return this.transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`payment:${p.tenantId}:${p.userId}:${request.idempotencyKey}`]);
      const existing = await client.query('SELECT * FROM cod_payment_orders WHERE tenant_id=$1 AND user_id=$2 AND idempotency_key=$3',[p.tenantId,p.userId,request.idempotencyKey]);
      if (existing.rows[0]) {
        const order = paymentOrderFromRow(existing.rows[0]);
        if (order.amountCents !== request.amountCents || order.channel !== request.channel) throw new HttpError('Idempotency key was already used with different payment parameters',409,'idempotency_conflict');
        return order;
      }
      const { rows } = await client.query(`INSERT INTO cod_payment_orders (id,tenant_id,user_id,amount_cents,currency,channel,status,idempotency_key) VALUES ($1,$2,$3,$4,'CNY',$5,'pending',$6) RETURNING *`,[randomUUID(),p.tenantId,p.userId,request.amountCents,request.channel,request.idempotencyKey]);
      return paymentOrderFromRow(rows[0]);
    });
  }
  async getPaymentOrder(p: Principal, orderId: string) {
    const { rows } = await this.pool.query('SELECT * FROM cod_payment_orders WHERE id=$1 AND tenant_id=$2 AND user_id=$3',[orderId,p.tenantId,p.userId]);
    if (!rows[0]) throw new HttpError('Payment order not found',404,'payment_order_not_found');
    return paymentOrderFromRow(rows[0]);
  }
  async completePaymentOrder(event: PaymentCompletion) {
    return this.transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1)),pg_advisory_xact_lock(hashtext($2))',[`payment-event:${event.providerEventId}`,`provider-payment:${event.channel}:${event.providerPaymentId}`]);
      const result = await client.query('SELECT * FROM cod_payment_orders WHERE id=$1 FOR UPDATE',[event.orderId]);
      if (!result.rows[0]) throw new HttpError('Payment order not found',404,'payment_order_not_found');
      const current = paymentOrderFromRow(result.rows[0]);
      if (current.amountCents !== event.amountCents || current.currency !== event.currency || current.channel !== event.channel) throw new HttpError('Payment event does not match the order',409,'payment_order_mismatch');
      const reused = await client.query('SELECT id FROM cod_payment_orders WHERE id<>$1 AND (provider_event_id=$2 OR (channel=$3 AND provider_payment_id=$4))',[current.id,event.providerEventId,event.channel,event.providerPaymentId]);
      if (reused.rows[0]) throw new HttpError('Provider payment or event was already used for another order',409,'payment_provider_reused');
      const ledgerKey = `payment-order:${current.id}`;
      if (current.status === 'paid') {
        if (current.providerPaymentId !== event.providerPaymentId) throw new HttpError('Payment order is already bound to another provider payment',409,'payment_provider_conflict');
        const existing = await client.query('SELECT * FROM cod_ledger WHERE tenant_id=$1 AND user_id=$2 AND idempotency_key=$3',[result.rows[0].tenant_id,result.rows[0].user_id,ledgerKey]);
        if (!existing.rows[0]) throw new HttpError('Paid order ledger entry is missing',500,'payment_ledger_missing');
        return { order: current, entry: ledgerFromRow(existing.rows[0]) };
      }
      if (current.status !== 'pending') throw new HttpError(`Payment order cannot be completed from ${current.status}`,409,'payment_order_not_pending');
      const inserted = await client.query(`INSERT INTO cod_ledger (id,tenant_id,user_id,type,amount_cents,wallet_amount_cents,reference,idempotency_key,payment_direction) VALUES ($1,$2,$3,'topup',$4,$4,$5,$6,$7) RETURNING *`,[randomUUID(),result.rows[0].tenant_id,result.rows[0].user_id,current.amountCents,`${event.channel}:${event.providerPaymentId}`,ledgerKey,'用户 → 支付渠道 → COD 钱包']);
      await client.query('UPDATE cod_users SET balance_cents=balance_cents+$3,updated_at=now() WHERE tenant_id=$1 AND user_id=$2',[result.rows[0].tenant_id,result.rows[0].user_id,current.amountCents]);
      const updated = await client.query(`UPDATE cod_payment_orders SET status='paid',provider_payment_id=$2,provider_event_id=$3,updated_at=now() WHERE id=$1 RETURNING *`,[current.id,event.providerPaymentId,event.providerEventId]);
      return { order: paymentOrderFromRow(updated.rows[0]), entry: ledgerFromRow(inserted.rows[0]) };
    });
  }
  async recordUsage(p: Principal, event: UsageEvent) {
    if (!Number.isInteger(event.costCents) || event.costCents < 0) throw new HttpError('Usage cost is invalid',400,'invalid_usage');
    return this.transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${p.tenantId}:${p.userId}:${event.idempotencyKey}`]);
      const existing=await client.query('SELECT * FROM cod_ledger WHERE tenant_id=$1 AND user_id=$2 AND idempotency_key=$3',[p.tenantId,p.userId,event.idempotencyKey]); if(existing.rows[0]) return ledgerFromRow(existing.rows[0]);
      const billedEvent=p.role==='admin'?{...event,costCents:0,paymentDirection:'管理员测试免计费'}:event;
      const allocation=await this.allocateFunds(client,p,billedEvent.costCents);
      const creditCents=allocation.grantAllocations.reduce((total,item)=>total+item.amountCents,0);
      return this.insertUsageLedger(client,p,billedEvent,allocation.walletCents,creditCents);
    });
  }
  async reserveUsage(p: Principal,reservationId:string,amountCents:number) {
    if(!Number.isInteger(amountCents)||amountCents<0) throw new HttpError('Reservation amount is invalid',400,'invalid_reservation');
    const reservableAmount=p.role==='admin'?0:amountCents;
    await this.transaction(async(client)=>{const existing=await client.query('SELECT status FROM cod_usage_reservations WHERE id=$1 AND tenant_id=$2 AND user_id=$3',[reservationId,p.tenantId,p.userId]);if(existing.rows[0])return;const allocation=await this.allocateFunds(client,p,reservableAmount);await client.query(`INSERT INTO cod_usage_reservations (id,tenant_id,user_id,amount_cents,wallet_cents,grant_allocations,status) VALUES ($1,$2,$3,$4,$5,$6,'reserved')`,[reservationId,p.tenantId,p.userId,reservableAmount,allocation.walletCents,JSON.stringify(allocation.grantAllocations)]);});
  }
  async settleUsage(p:Principal,reservationId:string,event:UsageEvent) {
    if(!Number.isInteger(event.costCents)||event.costCents<0)throw new HttpError('Usage cost is invalid',400,'invalid_usage');
    return this.transaction(async(client)=>{
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`${p.tenantId}:${p.userId}:${event.idempotencyKey}`]);
      const reservation=await client.query(`SELECT * FROM cod_usage_reservations WHERE id=$1 AND tenant_id=$2 AND user_id=$3 FOR UPDATE`,[reservationId,p.tenantId,p.userId]);
      const existing=await client.query('SELECT * FROM cod_ledger WHERE tenant_id=$1 AND user_id=$2 AND idempotency_key=$3',[p.tenantId,p.userId,event.idempotencyKey]);
      if(existing.rows[0]){if(reservation.rows[0]?.status==='reserved')await this.releaseReservation(client,p,reservation.rows[0],reservationId);return ledgerFromRow(existing.rows[0]);}
      if(!reservation.rows[0]||reservation.rows[0].status!=='reserved')throw new HttpError('Usage reservation not found',409,'reservation_not_found');
      if(event.taskId!=='chat'){
        const task=await client.query('SELECT status FROM cod_tasks WHERE id=$1 AND tenant_id=$2 AND user_id=$3 FOR UPDATE',[event.taskId,p.tenantId,p.userId]);
        if(!task.rows[0])throw new HttpError('Task not found',404,'task_not_found');
        if(task.rows[0].status==='cancelled')throw new HttpError('Task was cancelled before settlement',409,'task_cancelled');
        if(task.rows[0].status!=='running'&&task.rows[0].status!=='waiting')throw new HttpError('Task is not running',409,'task_not_running');
      }
      const billedEvent=p.role==='admin'?{...event,costCents:0,paymentDirection:'管理员测试免计费'}:event;
      const reservedGrants=parseGrantAllocations(reservation.rows[0].grant_allocations);const reservedWallet=Number(reservation.rows[0].wallet_cents);let remaining=billedEvent.costCents;let creditConsumed=0;
      for(const allocation of reservedGrants){const consumed=Math.min(allocation.amountCents,remaining);creditConsumed+=consumed;remaining-=consumed;const refund=allocation.amountCents-consumed;if(refund>0)await this.restoreGrants(client,[{grantId:allocation.grantId,amountCents:refund}]);}
      const walletConsumed=Math.min(reservedWallet,remaining);remaining-=walletConsumed;const walletRefund=reservedWallet-walletConsumed;if(walletRefund>0)await client.query('UPDATE cod_users SET balance_cents=balance_cents+$3,updated_at=now() WHERE tenant_id=$1 AND user_id=$2',[p.tenantId,p.userId,walletRefund]);
      let totalWalletConsumed=walletConsumed;
      if(remaining>0){const extra=await this.allocateFunds(client,p,remaining);totalWalletConsumed+=extra.walletCents;creditConsumed+=extra.grantAllocations.reduce((total,item)=>total+item.amountCents,0);}
      const inserted=await this.insertUsageLedger(client,p,billedEvent,totalWalletConsumed,creditConsumed);await client.query(`UPDATE cod_usage_reservations SET status='settled',updated_at=now() WHERE id=$1`,[reservationId]);return inserted;
    });
  }
  async releaseUsage(p:Principal,reservationId:string) { await this.transaction(async(client)=>{const reservation=await client.query(`SELECT * FROM cod_usage_reservations WHERE id=$1 AND tenant_id=$2 AND user_id=$3 FOR UPDATE`,[reservationId,p.tenantId,p.userId]);if(!reservation.rows[0]||reservation.rows[0].status!=='reserved')return;await this.releaseReservation(client,p,reservation.rows[0],reservationId);}); }
  async createComputeRequest(p:Principal,input:ComputeRequestInput,idempotencyKey:string) {
    if(!idempotencyKey||idempotencyKey.length>200)throw new HttpError('Compute request idempotency key is invalid',400,'invalid_idempotency_key');
    return this.transaction(async(client)=>{
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`compute:${p.tenantId}:${p.userId}:${idempotencyKey}`]);
      const existing=await client.query('SELECT * FROM cod_compute_requests WHERE tenant_id=$1 AND user_id=$2 AND idempotency_key=$3',[p.tenantId,p.userId,idempotencyKey]);
      if(existing.rows[0])return computeRequestFromRow(existing.rows[0]);
      const {rows}=await client.query(`INSERT INTO cod_compute_requests (id,tenant_id,user_id,email,kind,offer_id,payload,idempotency_key) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,[randomUUID(),p.tenantId,p.userId,p.email,input.kind,input.offerId??null,JSON.stringify(input),idempotencyKey]);
      return computeRequestFromRow(rows[0]);
    });
  }
  async listComputeRequests(p:Principal) { const {rows}=await this.pool.query('SELECT * FROM cod_compute_requests WHERE tenant_id=$1 AND user_id=$2 ORDER BY created_at DESC LIMIT 100',[p.tenantId,p.userId]);return rows.map(computeRequestFromRow); }
  async listDevices(p: Principal) { const {rows}=await this.pool.query('SELECT * FROM cod_devices WHERE tenant_id=$1 AND user_id=$2 ORDER BY created_at',[p.tenantId,p.userId]); return rows.map(deviceFromRow); }
  async registerDevice(p: Principal,input:Pick<DeviceRecord,'name'|'platform'>) { validateDeviceInput(input); const id=randomUUID(); const {rows}=await this.pool.query(`INSERT INTO cod_devices (id,tenant_id,user_id,name,platform,status,last_seen_at) VALUES ($1,$2,$3,$4,$5,'online',now()) RETURNING *`,[id,p.tenantId,p.userId,input.name.trim().slice(0,100),input.platform]); const device=deviceFromRow(rows[0]); await this.append(p,'device.registered',id,device); return device; }
  async heartbeat(p: Principal,id:string) { const {rows}=await this.pool.query(`UPDATE cod_devices SET status='online',last_seen_at=now() WHERE id=$1 AND tenant_id=$2 AND user_id=$3 RETURNING *`,[id,p.tenantId,p.userId]); if(!rows[0]) throw new HttpError('Device not found',404,'device_not_found'); return deviceFromRow(rows[0]); }
  async listTasks(p: Principal) { const {rows}=await this.pool.query('SELECT * FROM cod_tasks WHERE tenant_id=$1 AND user_id=$2 ORDER BY updated_at DESC',[p.tenantId,p.userId]); return rows.map(taskFromRow); }
  async getTask(p:Principal,id:string) { const {rows}=await this.pool.query('SELECT * FROM cod_tasks WHERE id=$1 AND tenant_id=$2 AND user_id=$3',[id,p.tenantId,p.userId]);if(!rows[0])throw new HttpError('Task not found',404,'task_not_found');return taskFromRow(rows[0]); }
  async createTask(p: Principal,input:Pick<SyncedTask,'title'|'deviceId'>) { if(!input.title?.trim()) throw new HttpError('Task title is required',400,'invalid_task'); const device=await this.pool.query('SELECT 1 FROM cod_devices WHERE id=$1 AND tenant_id=$2 AND user_id=$3',[input.deviceId,p.tenantId,p.userId]); if(!device.rows[0]) throw new HttpError('Device not found',404,'device_not_found'); const id=randomUUID(); const {rows}=await this.pool.query(`INSERT INTO cod_tasks (id,tenant_id,user_id,title,status,device_id) VALUES ($1,$2,$3,$4,'draft',$5) RETURNING *`,[id,p.tenantId,p.userId,input.title.trim().slice(0,500),input.deviceId]); const task=taskFromRow(rows[0]); await this.append(p,'task.created',id,task); return task; }
  async updateTask(p: Principal,id:string,status:TaskStatus,version:number,outcome:TaskOutcome={}) {
    return this.transaction(async (client) => {
      const currentResult = await client.query('SELECT * FROM cod_tasks WHERE id=$1 AND tenant_id=$2 AND user_id=$3 FOR UPDATE', [id,p.tenantId,p.userId]);
      if (!currentResult.rows[0]) throw new HttpError('Task not found',404,'task_not_found');
      const current = taskFromRow(currentResult.rows[0]);
      if (current.version !== version) throw new HttpError('Task version conflict',409,'version_conflict');
      validateTaskTransition(current.status, status);
      if (outcome.result !== undefined && outcome.result !== null && outcome.result.length > 50_000) throw new HttpError('Task result is too large', 400, 'task_result_too_large');
      if (outcome.error !== undefined && outcome.error !== null && outcome.error.length > 5_000) throw new HttpError('Task error is too large', 400, 'task_error_too_large');
      if (current.status === status && outcome.result === undefined && outcome.error === undefined) return current;
      let nextResult = outcome.result === undefined ? current.result : outcome.result;
      let nextError = outcome.error === undefined ? current.error : outcome.error;
      if (status === 'running' && current.status !== 'running') { nextResult = null; nextError = null; }
      if (status === 'complete') nextError = null;
      if (status === 'failed') nextResult = null;
      if (status === 'cancelled') { nextResult = null; nextError = null; }
      validateTaskOutcome(status, nextResult, nextError);
      const { rows } = await client.query('UPDATE cod_tasks SET status=$1,result=$3,error=$4,version=version+1,updated_at=now() WHERE id=$2 RETURNING *', [status,id,nextResult,nextError]);
      const task = taskFromRow(rows[0]);
      await client.query('INSERT INTO cod_events (tenant_id,user_id,type,entity_id,data) VALUES ($1,$2,$3,$4,$5)', [p.tenantId,p.userId,'task.updated',id,JSON.stringify(task)]);
      return task;
    });
  }
  async eventsAfter(p:Principal,cursor:number) { const {rows}=await this.pool.query('SELECT * FROM cod_events WHERE tenant_id=$1 AND user_id=$2 AND cursor>$3 ORDER BY cursor LIMIT 500',[p.tenantId,p.userId,cursor]); return rows.map((row)=>({cursor:Number(row.cursor),type:row.type,entityId:String(row.entity_id),data:row.data,createdAt:new Date(row.created_at).toISOString()})); }
  async audit(p:Principal,action:string,entityType:string,entityId:string|null,data:unknown={}) { await this.pool.query('INSERT INTO cod_audit (id,tenant_id,user_id,action,entity_type,entity_id,data) VALUES ($1,$2,$3,$4,$5,$6,$7)',[randomUUID(),p.tenantId,p.userId,action,entityType,entityId,JSON.stringify(data)]); }
  async listAudit(p:Principal,limit:number) { const {rows}=await this.pool.query('SELECT * FROM cod_audit WHERE tenant_id=$1 AND user_id=$2 ORDER BY created_at DESC LIMIT $3',[p.tenantId,p.userId,Math.min(Math.max(limit,1),200)]); return rows.map((row)=>({id:String(row.id),action:String(row.action),entityType:String(row.entity_type),entityId:row.entity_id?String(row.entity_id):null,data:row.data,createdAt:new Date(row.created_at).toISOString()})); }
  private async allocateFunds(client:PoolClient,p:Principal,amountCents:number):Promise<FundsAllocation>{
    const account=await client.query('SELECT balance_cents FROM cod_users WHERE tenant_id=$1 AND user_id=$2 FOR UPDATE',[p.tenantId,p.userId]);
    if(!account.rows[0])throw new HttpError('Account not found',404,'account_not_found');
    await client.query(`UPDATE cod_credit_grants SET status='expired' WHERE tenant_id=$1 AND user_id=$2 AND status='active' AND expires_at<=now()`,[p.tenantId,p.userId]);
    const grants=await client.query(`SELECT * FROM cod_credit_grants WHERE tenant_id=$1 AND user_id=$2 AND status='active' AND remaining_cents>0 AND expires_at>now() ORDER BY expires_at,purchased_at FOR UPDATE`,[p.tenantId,p.userId]);
    let remaining=amountCents;const grantAllocations:GrantAllocation[]=[];
    for(const row of grants.rows){if(remaining<=0)break;const amount=Math.min(Number(row.remaining_cents),remaining);if(amount<=0)continue;grantAllocations.push({grantId:String(row.id),amountCents:amount});remaining-=amount;await client.query(`UPDATE cod_credit_grants SET remaining_cents=remaining_cents-$2,status=CASE WHEN remaining_cents-$2=0 THEN 'depleted' ELSE 'active' END WHERE id=$1`,[row.id,amount]);}
    const walletCents=remaining;
    if(Number(account.rows[0].balance_cents)<walletCents)throw new HttpError('Insufficient balance',402,'insufficient_balance');
    if(walletCents>0)await client.query('UPDATE cod_users SET balance_cents=balance_cents-$3,updated_at=now() WHERE tenant_id=$1 AND user_id=$2',[p.tenantId,p.userId,walletCents]);
    return {walletCents,grantAllocations};
  }
  private async restoreGrants(client:PoolClient,allocations:GrantAllocation[]):Promise<void>{
    for(const allocation of allocations)await client.query(`UPDATE cod_credit_grants SET remaining_cents=LEAST(original_cents,remaining_cents+$2),status=CASE WHEN expires_at<=now() THEN 'expired' ELSE 'active' END WHERE id=$1`,[allocation.grantId,allocation.amountCents]);
  }
  private async releaseReservation(client:PoolClient,p:Principal,row:Record<string,unknown>,reservationId:string):Promise<void>{
    const walletCents=Number(row.wallet_cents??0);if(walletCents>0)await client.query('UPDATE cod_users SET balance_cents=balance_cents+$3,updated_at=now() WHERE tenant_id=$1 AND user_id=$2',[p.tenantId,p.userId,walletCents]);
    await this.restoreGrants(client,parseGrantAllocations(row.grant_allocations));
    await client.query(`UPDATE cod_usage_reservations SET status='released',updated_at=now() WHERE id=$1`,[reservationId]);
  }
  private async insertUsageLedger(client:PoolClient,p:Principal,event:UsageEvent,walletCents:number,creditCents:number):Promise<LedgerEntry>{
    const inserted=await client.query(`INSERT INTO cod_ledger (id,tenant_id,user_id,type,amount_cents,wallet_amount_cents,credit_amount_cents,reference,idempotency_key,source_id,upstream_source_id,model_id,payment_direction,commission_rate_bps,commission_cents) VALUES ($1,$2,$3,'usage',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,[randomUUID(),p.tenantId,p.userId,-event.costCents,-walletCents,-creditCents,`${event.sourceId}:${event.model}:${event.taskId}`,event.idempotencyKey,event.sourceId,event.upstreamSourceId??'ai-kai',event.model,event.paymentDirection,event.commissionRateBps??0,event.commissionCents??0]);
    return ledgerFromRow(inserted.rows[0]);
  }
  private async append(p:Principal,type:TaskEvent['type'],entityId:string,data:unknown) { await this.pool.query('INSERT INTO cod_events (tenant_id,user_id,type,entity_id,data) VALUES ($1,$2,$3,$4,$5)',[p.tenantId,p.userId,type,entityId,JSON.stringify(data)]); }
  private async transaction<T>(run:(client:PoolClient)=>Promise<T>):Promise<T> { const client=await this.pool.connect(); try { await client.query('BEGIN'); const value=await run(client); await client.query('COMMIT'); return value; } catch(error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); } }
}
