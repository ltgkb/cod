import { createHash, randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import type { AccountSummary, DeviceRecord, TaskStatus, UsageEvent } from '@cod/contracts';
import { HttpError } from './errors.js';
import type { ComputeRequest, ComputeRequestInput } from './compute-market.js';
import { recordUsageReservationsReaped } from './metrics.js';

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
  type: 'topup' | 'usage' | 'pack_purchase' | 'credit_grant' | 'trial_credit' | 'opening_balance';
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

export interface TaskExecutionCredential {
  executionId: string;
  leaseToken: string;
}

export interface TaskExecutionClaimCredential {
  claimId: string;
  leaseToken: string;
}

export interface TaskLeaseHeartbeat extends TaskExecutionCredential {
  taskId: string;
}

export interface TaskExecutionClaim {
  task: SyncedTask;
  executionId: string;
  leaseToken: string;
  leaseExpiresAt: string;
  replayed: boolean;
}

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

export interface ChatRequestCompletion {
  requestKey: string;
  fingerprint: string;
  executionId?: string;
  responsePayload: Record<string, unknown>;
  audit: {
    entityId: string;
    data: unknown;
  };
}

export type ChatRequestClaim =
  | { state: 'claimed' }
  | { state: 'pending' }
  | { state: 'complete'; responsePayload: Record<string, unknown> };

export const CHAT_RESPONSE_CACHE_MAX_BYTES = 512 * 1024;

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
  claimChatRequest(principal: Principal, requestKey: string, fingerprint: string, executionId?: string): Promise<ChatRequestClaim>;
  failChatRequest(principal: Principal, requestKey: string, fingerprint: string, executionId?: string): Promise<void>;
  reserveUsage(principal: Principal, reservationId: string, amountCents: number, taskExecution?: { taskId: string; executionId: string }): Promise<void>;
  renewUsageReservation(principal: Principal, reservationId: string): Promise<void>;
  reapExpiredUsageReservations(limit?: number): Promise<number>;
  settleUsage(principal: Principal, reservationId: string, event: UsageEvent, completion?: ChatRequestCompletion, executionId?: string): Promise<LedgerEntry>;
  releaseUsage(principal: Principal, reservationId: string): Promise<void>;
  createComputeRequest(principal: Principal, input: ComputeRequestInput, idempotencyKey: string): Promise<ComputeRequest>;
  listComputeRequests(principal: Principal): Promise<ComputeRequest[]>;
  listDevices(principal: Principal): Promise<DeviceRecord[]>;
  registerDevice(principal: Principal, input: Pick<DeviceRecord, 'name' | 'platform'>): Promise<DeviceRecord>;
  heartbeat(principal: Principal, deviceId: string, taskLease?: TaskLeaseHeartbeat): Promise<DeviceRecord>;
  listTasks(principal: Principal): Promise<SyncedTask[]>;
  getTask(principal: Principal, taskId: string): Promise<SyncedTask>;
  createTask(principal: Principal, input: Pick<SyncedTask, 'title' | 'deviceId'>): Promise<SyncedTask>;
  claimTask(principal: Principal, taskId: string, expectedVersion: number, claim: TaskExecutionClaimCredential): Promise<TaskExecutionClaim>;
  assertTaskLease(principal: Principal, taskId: string, execution: TaskExecutionCredential): Promise<SyncedTask>;
  assertTaskExecution(principal: Principal, taskId: string, executionId: string): Promise<SyncedTask>;
  renewTaskExecution(principal: Principal, taskId: string, executionId: string): Promise<void>;
  updateTask(principal: Principal, taskId: string, status: TaskStatus, expectedVersion: number, outcome?: TaskOutcome, execution?: TaskExecutionCredential): Promise<SyncedTask>;
  eventsAfter(principal: Principal, cursor: number): Promise<TaskEvent[]>;
  audit(principal: Principal, action: string, entityType: string, entityId: string | null, data?: unknown): Promise<void>;
  listAudit(principal: Principal, limit: number): Promise<AuditEntry[]>;
  close(): Promise<void>;
}

const devicePlatforms = new Set<DeviceRecord['platform']>(['macos', 'windows', 'linux', 'web', 'mobile']);
export const DEVICE_OFFLINE_AFTER_MS = 45_000;
export const TASK_LEASE_DURATION_MS = 90_000;
export const USAGE_RESERVATION_LEASE_DURATION_MS = 90_000;
export const USAGE_RESERVATION_KEEPALIVE_INTERVAL_MS = 30_000;
export const USAGE_RESERVATION_REAP_BATCH_SIZE = 100;
export const USAGE_RESERVATION_REAP_INTERVAL_MS = 60_000;
export const TASK_LEASE_EXPIRED_ERROR = '执行设备已断开，任务租约过期，本次执行已中断。请检查项目状态后重新执行。';
export const LEGACY_TASK_INTERRUPTED_ERROR = '服务升级后无法确认原执行会话仍在运行，任务已安全中断。请检查项目状态后重新执行。';
const taskExecutionIdPattern = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const taskLeaseTokenPattern = /^[A-Za-z0-9_-]{43}$/;
const taskClaimIdPattern = taskLeaseTokenPattern;
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

export function validateTaskExecutionCredential(execution: TaskExecutionCredential): void {
  if (!taskExecutionIdPattern.test(execution.executionId) || !taskLeaseTokenPattern.test(execution.leaseToken) || ('taskId' in execution && (typeof execution.taskId !== 'string' || !taskExecutionIdPattern.test(execution.taskId)))) {
    throw new HttpError('Task execution lease is invalid', 400, 'invalid_task_lease');
  }
}

export function validateTaskExecutionClaimCredential(claim: TaskExecutionClaimCredential): void {
  if (!taskClaimIdPattern.test(claim.claimId) || !taskLeaseTokenPattern.test(claim.leaseToken)) {
    throw new HttpError('Task execution claim is invalid', 400, 'invalid_task_claim');
  }
}

export const hashTaskLeaseToken = (token: string): string => createHash('sha256').update(token).digest('hex');

export const legacyInviteCodeBackfillMigration = `
UPDATE cod_users
SET invite_code='KAI-' || upper(substr(md5(tenant_id || ':' || user_id),1,20))
WHERE invite_code IS NULL;
`;

export const ledgerAllocationBackfillMigration = `
UPDATE cod_ledger
SET wallet_amount_cents=amount_cents
WHERE wallet_amount_cents=0 AND credit_amount_cents=0 AND amount_cents<>0
  AND type IN ('topup','usage','pack_purchase');
UPDATE cod_ledger
SET credit_amount_cents=amount_cents
WHERE wallet_amount_cents=0 AND credit_amount_cents=0 AND amount_cents<>0
  AND type IN ('credit_grant','trial_credit');
DO $ledger_allocation$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='cod_ledger'::regclass AND conname='cod_ledger_allocation_check'
  ) THEN
    ALTER TABLE cod_ledger ADD CONSTRAINT cod_ledger_allocation_check
      CHECK (amount_cents=wallet_amount_cents+credit_amount_cents) NOT VALID;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='cod_ledger'::regclass AND conname='cod_ledger_allocation_check' AND NOT convalidated
  ) THEN
    ALTER TABLE cod_ledger VALIDATE CONSTRAINT cod_ledger_allocation_check;
  END IF;
END
$ledger_allocation$;
`;

export const ledgerTypeConstraintMigration = `
DO $ledger_type$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='cod_ledger'::regclass AND conname='cod_ledger_type_check'
      AND position('opening_balance' in pg_get_constraintdef(oid))=0
  ) THEN
    ALTER TABLE cod_ledger DROP CONSTRAINT cod_ledger_type_check;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='cod_ledger'::regclass AND conname='cod_ledger_type_check'
  ) THEN
    ALTER TABLE cod_ledger ADD CONSTRAINT cod_ledger_type_check
      CHECK (type IN ('topup','usage','pack_purchase','credit_grant','trial_credit','opening_balance')) NOT VALID;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='cod_ledger'::regclass AND conname='cod_ledger_type_check' AND NOT convalidated
  ) THEN
    ALTER TABLE cod_ledger VALIDATE CONSTRAINT cod_ledger_type_check;
  END IF;
END
$ledger_type$;
`;

export const walletOpeningBalanceMigration = `
WITH wallet_ledger AS (
  SELECT tenant_id,user_id,sum(wallet_amount_cents) AS wallet_net
  FROM cod_ledger GROUP BY tenant_id,user_id
), reserved_wallet AS (
  SELECT tenant_id,user_id,sum(wallet_cents) AS reserved_cents
  FROM cod_usage_reservations WHERE status='reserved' GROUP BY tenant_id,user_id
), opening_balances AS (
  SELECT u.tenant_id,u.user_id,
    u.balance_cents+coalesce(r.reserved_cents,0)-coalesce(l.wallet_net,0) AS opening_cents
  FROM cod_users u
  LEFT JOIN wallet_ledger l USING (tenant_id,user_id)
  LEFT JOIN reserved_wallet r USING (tenant_id,user_id)
)
INSERT INTO cod_ledger (
  id,tenant_id,user_id,type,amount_cents,wallet_amount_cents,credit_amount_cents,
  reference,idempotency_key,payment_direction
)
SELECT md5(tenant_id || ':' || user_id || ':opening-balance-v1')::uuid,
  tenant_id,user_id,'opening_balance',opening_cents,opening_cents,0,
  '历史钱包期初余额迁移','opening-balance-v1','历史期初余额 → COD 钱包'
FROM opening_balances
WHERE opening_cents<>0
ON CONFLICT (tenant_id,user_id,idempotency_key) DO NOTHING;
`;

export const chatRequestSchemaMigration = `
CREATE TABLE IF NOT EXISTS cod_chat_requests (
  tenant_id text NOT NULL, user_id text NOT NULL, request_key text NOT NULL,
  request_fingerprint text NOT NULL, status text NOT NULL CHECK (status IN ('pending','complete','failed')),
  task_execution_id uuid, response_payload jsonb, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now()+interval '1 hour'),
  PRIMARY KEY (tenant_id,user_id,request_key),
  CHECK (char_length(request_key) BETWEEN 1 AND 240),
  CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
  CHECK ((status='complete')=(response_payload IS NOT NULL))
);
ALTER TABLE cod_chat_requests ADD COLUMN IF NOT EXISTS expires_at timestamptz;
ALTER TABLE cod_chat_requests ADD COLUMN IF NOT EXISTS task_execution_id uuid;
UPDATE cod_chat_requests SET expires_at=CASE WHEN status='complete' THEN updated_at+interval '24 hours' ELSE updated_at+interval '1 hour' END WHERE expires_at IS NULL;
ALTER TABLE cod_chat_requests ALTER COLUMN expires_at SET DEFAULT (now()+interval '1 hour');
ALTER TABLE cod_chat_requests ALTER COLUMN expires_at SET NOT NULL;
CREATE INDEX IF NOT EXISTS cod_chat_requests_owner_expiry_idx ON cod_chat_requests(tenant_id,user_id,expires_at);
CREATE INDEX IF NOT EXISTS cod_chat_requests_expiry_idx ON cod_chat_requests(expires_at);
`;

export const taskExecutionLeaseSchemaMigration = `
DO $task_execution_lease$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='cod_tasks'::regclass AND conname='cod_tasks_execution_lease_check'
  ) THEN
    ALTER TABLE cod_tasks ADD CONSTRAINT cod_tasks_execution_lease_check CHECK (
      (status IN ('running','waiting') AND execution_id IS NOT NULL AND claim_id_hash IS NOT NULL AND claim_id_hash ~ '^[a-f0-9]{64}$' AND lease_token_hash IS NOT NULL AND lease_token_hash ~ '^[a-f0-9]{64}$' AND lease_expires_at IS NOT NULL)
      OR
      (status NOT IN ('running','waiting') AND execution_id IS NULL AND claim_id_hash IS NULL AND lease_token_hash IS NULL AND lease_expires_at IS NULL)
    ) NOT VALID;
  END IF;
END
$task_execution_lease$;
`;

export const usageReservationLeaseSchemaMigration = `
ALTER TABLE cod_usage_reservations ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz;
UPDATE cod_usage_reservations
SET lease_expires_at=CASE WHEN status='reserved' THEN now()+interval '15 minutes' ELSE updated_at END
WHERE lease_expires_at IS NULL;
ALTER TABLE cod_usage_reservations ALTER COLUMN lease_expires_at SET DEFAULT (now()+interval '90 seconds');
ALTER TABLE cod_usage_reservations ALTER COLUMN lease_expires_at SET NOT NULL;
CREATE INDEX IF NOT EXISTS cod_usage_reservations_expired_lease_idx
  ON cod_usage_reservations(lease_expires_at,id) WHERE status='reserved';
`;

export const usageReservationReapSql = `
WITH candidates AS (
  SELECT id
  FROM cod_usage_reservations
  WHERE status='reserved' AND lease_expires_at<=statement_timestamp()
  ORDER BY lease_expires_at,id
  LIMIT $1
  FOR UPDATE SKIP LOCKED
), released AS (
  UPDATE cod_usage_reservations r
  SET status='released',updated_at=now()
  FROM candidates c
  WHERE r.id=c.id AND r.status='reserved' AND r.lease_expires_at<=statement_timestamp()
  RETURNING r.id,r.tenant_id,r.user_id,r.wallet_cents,r.grant_allocations
)
SELECT * FROM released;
`;

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
${legacyInviteCodeBackfillMigration}
CREATE UNIQUE INDEX IF NOT EXISTS cod_users_email_global_unique ON cod_users (lower(email));
CREATE UNIQUE INDEX IF NOT EXISTS cod_users_invite_code_unique ON cod_users (upper(invite_code)) WHERE invite_code IS NOT NULL;
CREATE TABLE IF NOT EXISTS cod_ledger (
  id uuid PRIMARY KEY, tenant_id text NOT NULL, user_id text NOT NULL, type text NOT NULL,
  amount_cents bigint NOT NULL, reference text NOT NULL, idempotency_key text NOT NULL, source_id text, model_id text, payment_direction text, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id, idempotency_key)
);
${ledgerTypeConstraintMigration}
ALTER TABLE cod_ledger ADD COLUMN IF NOT EXISTS source_id text;
ALTER TABLE cod_ledger ADD COLUMN IF NOT EXISTS upstream_source_id text;
ALTER TABLE cod_ledger ADD COLUMN IF NOT EXISTS model_id text;
ALTER TABLE cod_ledger ADD COLUMN IF NOT EXISTS payment_direction text;
ALTER TABLE cod_ledger ADD COLUMN IF NOT EXISTS commission_rate_bps integer NOT NULL DEFAULT 0;
ALTER TABLE cod_ledger ADD COLUMN IF NOT EXISTS commission_cents bigint NOT NULL DEFAULT 0;
ALTER TABLE cod_ledger ADD COLUMN IF NOT EXISTS wallet_amount_cents bigint NOT NULL DEFAULT 0;
ALTER TABLE cod_ledger ADD COLUMN IF NOT EXISTS credit_amount_cents bigint NOT NULL DEFAULT 0;
${ledgerAllocationBackfillMigration}
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
  status text NOT NULL CHECK (status IN ('reserved','settled','released')), task_id uuid, task_execution_id uuid,
  lease_expires_at timestamptz NOT NULL DEFAULT (now()+interval '90 seconds'),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE cod_usage_reservations ADD COLUMN IF NOT EXISTS task_id uuid;
ALTER TABLE cod_usage_reservations ADD COLUMN IF NOT EXISTS task_execution_id uuid;
ALTER TABLE cod_usage_reservations ADD COLUMN IF NOT EXISTS wallet_cents bigint;
UPDATE cod_usage_reservations SET wallet_cents=amount_cents WHERE wallet_cents IS NULL;
ALTER TABLE cod_usage_reservations ALTER COLUMN wallet_cents SET DEFAULT 0;
ALTER TABLE cod_usage_reservations ALTER COLUMN wallet_cents SET NOT NULL;
ALTER TABLE cod_usage_reservations ADD COLUMN IF NOT EXISTS grant_allocations jsonb NOT NULL DEFAULT '[]';
${usageReservationLeaseSchemaMigration}
${chatRequestSchemaMigration}
${walletOpeningBalanceMigration}
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
  device_id uuid NOT NULL REFERENCES cod_devices(id), version integer NOT NULL DEFAULT 1, result text, error text,
  execution_id uuid, claim_id_hash text, lease_token_hash text, lease_expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE cod_tasks ADD COLUMN IF NOT EXISTS result text;
ALTER TABLE cod_tasks ADD COLUMN IF NOT EXISTS error text;
ALTER TABLE cod_tasks ADD COLUMN IF NOT EXISTS execution_id uuid;
ALTER TABLE cod_tasks ADD COLUMN IF NOT EXISTS claim_id_hash text;
ALTER TABLE cod_tasks ADD COLUMN IF NOT EXISTS lease_token_hash text;
ALTER TABLE cod_tasks ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz;
${taskExecutionLeaseSchemaMigration}
CREATE TABLE IF NOT EXISTS cod_events (
  cursor bigserial PRIMARY KEY, tenant_id text NOT NULL, user_id text NOT NULL, type text NOT NULL, entity_id text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS cod_audit (
  id uuid PRIMARY KEY, tenant_id text NOT NULL, user_id text NOT NULL, action text NOT NULL, entity_type text NOT NULL,
  entity_id text, data jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cod_devices_owner_idx ON cod_devices(tenant_id, user_id);
CREATE INDEX IF NOT EXISTS cod_devices_owner_seen_idx ON cod_devices(tenant_id, user_id, last_seen_at);
CREATE INDEX IF NOT EXISTS cod_tasks_owner_idx ON cod_tasks(tenant_id, user_id);
CREATE INDEX IF NOT EXISTS cod_tasks_active_lease_idx ON cod_tasks(lease_expires_at) WHERE status IN ('running','waiting');
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
const validateChatRequestIdentity = (requestKey: string, fingerprint: string): void => {
  if (!requestKey || requestKey.length > 240) throw new HttpError('Chat request key is invalid', 400, 'invalid_idempotency_key');
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new HttpError('Chat request fingerprint is invalid', 400, 'invalid_request_fingerprint');
};
const deviceFromRow = (row: Record<string, unknown>): DeviceRecord => {
  const lastSeenAt = new Date(String(row.last_seen_at)).toISOString();
  const stale = Date.now() - new Date(lastSeenAt).getTime() > DEVICE_OFFLINE_AFTER_MS;
  return { id: String(row.id), name: String(row.name), platform: row.platform as DeviceRecord['platform'], status: stale ? 'offline' : row.status as DeviceRecord['status'], lastSeenAt };
};
const taskFromRow = (row: Record<string, unknown>): SyncedTask => ({ id: String(row.id), title: String(row.title), status: row.status as TaskStatus, deviceId: String(row.device_id), updatedAt: new Date(String(row.updated_at)).toISOString(), version: Number(row.version), result: row.result === null || row.result === undefined ? null : String(row.result), error: row.error === null || row.error === undefined ? null : String(row.error) });

export class PostgresDatabase implements CodDatabase {
  private readonly pool: Pool;
  private reservationReaperTimer: NodeJS.Timeout | null = null;
  private reservationReaperRun: Promise<number> | null = null;
  constructor(databaseUrl: string) {
    this.pool = new Pool({ connectionString: databaseUrl, max: 10, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000 });
    // PostgreSQL can report an error on an idle pooled client after a restart or
    // network interruption. EventEmitter treats an unhandled `error` as fatal,
    // so consume it here and let subsequent requests/readiness checks reconnect.
    this.pool.on('error', (error) => {
      console.error(JSON.stringify({ level: 'error', event: 'postgres.pool.error', error: error.message }));
    });
  }
  async initialize() {
    await this.pool.query(schema);
    await this.transaction(async (client) => {
      await client.query(`UPDATE cod_tasks SET execution_id=NULL,claim_id_hash=NULL,lease_token_hash=NULL,lease_expires_at=NULL
        WHERE status NOT IN ('running','waiting') AND (execution_id IS NOT NULL OR claim_id_hash IS NOT NULL OR lease_token_hash IS NOT NULL OR lease_expires_at IS NOT NULL)`);
      await this.expireTaskLeases(client);
      await client.query('ALTER TABLE cod_tasks VALIDATE CONSTRAINT cod_tasks_execution_lease_check');
    });
    await this.reapExpiredUsageReservations();
    this.startUsageReservationReaper();
  }
  async close() { if(this.reservationReaperTimer){clearInterval(this.reservationReaperTimer);this.reservationReaperTimer=null;}if(this.reservationReaperRun)await this.reservationReaperRun.catch(()=>undefined);await this.pool.end(); }
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
      const billedEvent=p.role==='admin'?{...event,costCents:0,paymentDirection:'管理员测试免计费',commissionRateBps:0,commissionCents:0}:event;
      const allocation=await this.allocateFunds(client,p,billedEvent.costCents);
      const creditCents=allocation.grantAllocations.reduce((total,item)=>total+item.amountCents,0);
      return this.insertUsageLedger(client,p,billedEvent,allocation.walletCents,creditCents);
    });
  }
  async claimChatRequest(p: Principal, requestKey: string, fingerprint: string, executionId?: string): Promise<ChatRequestClaim> {
    validateChatRequestIdentity(requestKey, fingerprint);
    if(executionId&&!taskExecutionIdPattern.test(executionId))throw new HttpError('Task execution is invalid',400,'invalid_task_execution');
    return this.transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`chat-request:${p.tenantId}:${p.userId}:${requestKey}`]);
      await client.query(`WITH expired AS (
        SELECT ctid FROM cod_chat_requests WHERE expires_at<=now() ORDER BY expires_at LIMIT 1000
      ) DELETE FROM cod_chat_requests WHERE ctid IN (SELECT ctid FROM expired)`);
      const existing = await client.query(
        'SELECT request_fingerprint,status,response_payload,task_execution_id FROM cod_chat_requests WHERE tenant_id=$1 AND user_id=$2 AND request_key=$3 FOR UPDATE',
        [p.tenantId,p.userId,requestKey],
      );
      const row = existing.rows[0] as Record<string, unknown> | undefined;
      if (!row) {
        await client.query(
          `INSERT INTO cod_chat_requests (tenant_id,user_id,request_key,request_fingerprint,task_execution_id,status,expires_at) VALUES ($1,$2,$3,$4,$5,'pending',now()+interval '1 hour')`,
          [p.tenantId,p.userId,requestKey,fingerprint,executionId??null],
        );
        return { state: 'claimed' };
      }
      if (String(row.request_fingerprint) !== fingerprint) throw new HttpError('Request ID was already used for a different chat request',409,'idempotency_conflict');
      if((row.task_execution_id?String(row.task_execution_id):null)!==(executionId??null))throw new HttpError('Request ID belongs to another task execution',409,'idempotency_conflict');
      if (row.status === 'complete') {
        const payload = row.response_payload;
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new HttpError('Cached chat response is invalid',500,'chat_cache_invalid');
        return { state: 'complete', responsePayload: payload as Record<string, unknown> };
      }
      if (row.status === 'pending') return { state: 'pending' };
      await client.query(
        `UPDATE cod_chat_requests SET status='pending',response_payload=NULL,updated_at=now(),expires_at=now()+interval '1 hour' WHERE tenant_id=$1 AND user_id=$2 AND request_key=$3`,
        [p.tenantId,p.userId,requestKey],
      );
      return { state: 'claimed' };
    });
  }
  async failChatRequest(p: Principal, requestKey: string, fingerprint: string, executionId?: string): Promise<void> {
    validateChatRequestIdentity(requestKey, fingerprint);
    if(executionId&&!taskExecutionIdPattern.test(executionId))throw new HttpError('Task execution is invalid',400,'invalid_task_execution');
    await this.transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`chat-request:${p.tenantId}:${p.userId}:${requestKey}`]);
      await client.query(
        `UPDATE cod_chat_requests r SET status='failed',response_payload=NULL,updated_at=now(),expires_at=now()+interval '1 hour'
         WHERE r.tenant_id=$1 AND r.user_id=$2 AND r.request_key=$3 AND r.request_fingerprint=$4
           AND r.task_execution_id IS NOT DISTINCT FROM $5::uuid AND r.status='pending'
           AND NOT EXISTS (
             SELECT 1 FROM cod_ledger l
             WHERE l.tenant_id=r.tenant_id AND l.user_id=r.user_id AND l.idempotency_key=$6
           )`,
        [p.tenantId,p.userId,requestKey,fingerprint,executionId??null,`chat:${requestKey}:${fingerprint}`],
      );
    });
  }
  async reserveUsage(p: Principal,reservationId:string,amountCents:number,taskExecution?:{taskId:string;executionId:string}) {
    if(!Number.isInteger(amountCents)||amountCents<0) throw new HttpError('Reservation amount is invalid',400,'invalid_reservation');
    if(taskExecution&&(!taskExecutionIdPattern.test(taskExecution.taskId)||!taskExecutionIdPattern.test(taskExecution.executionId)))throw new HttpError('Task execution is invalid',400,'invalid_task_execution');
    await this.reapExpiredUsageReservations();
    if(taskExecution)await this.reapTaskLeases(p,taskExecution.taskId);
    const reservableAmount=p.role==='admin'?0:amountCents;
    await this.transaction(async(client)=>{
      const existing=await client.query('SELECT status,task_id,task_execution_id,lease_expires_at>clock_timestamp() AS lease_active FROM cod_usage_reservations WHERE id=$1 AND tenant_id=$2 AND user_id=$3',[reservationId,p.tenantId,p.userId]);
      if(existing.rows[0]){if((existing.rows[0].task_id?String(existing.rows[0].task_id):null)!==(taskExecution?.taskId??null)||(existing.rows[0].task_execution_id?String(existing.rows[0].task_execution_id):null)!==(taskExecution?.executionId??null))throw new HttpError('Reservation belongs to another task execution',409,'reservation_execution_conflict');if(existing.rows[0].status!=='reserved'||existing.rows[0].lease_active!==true)throw new HttpError('Usage reservation lease is no longer active',409,'reservation_lease_expired');return;}
      if(taskExecution){const task=await client.query(`SELECT 1 FROM cod_tasks WHERE id=$1 AND tenant_id=$2 AND user_id=$3 AND execution_id=$4 AND status IN ('running','waiting') AND lease_expires_at>now() FOR UPDATE`,[taskExecution.taskId,p.tenantId,p.userId,taskExecution.executionId]);if(!task.rows[0])throw new HttpError('Task execution lease is no longer active',409,'task_lease_expired');}
      const allocation=await this.allocateFunds(client,p,reservableAmount);
      await client.query(`INSERT INTO cod_usage_reservations (id,tenant_id,user_id,amount_cents,wallet_cents,grant_allocations,task_id,task_execution_id,status,lease_expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'reserved',clock_timestamp()+$9::double precision*interval '1 millisecond')`,[reservationId,p.tenantId,p.userId,reservableAmount,allocation.walletCents,JSON.stringify(allocation.grantAllocations),taskExecution?.taskId??null,taskExecution?.executionId??null,USAGE_RESERVATION_LEASE_DURATION_MS]);
    });
  }
  async renewUsageReservation(p:Principal,reservationId:string):Promise<void>{
    const renewed=await this.pool.query(`UPDATE cod_usage_reservations SET lease_expires_at=clock_timestamp()+$4::double precision*interval '1 millisecond',updated_at=now() WHERE id=$1 AND tenant_id=$2 AND user_id=$3 AND status='reserved' AND lease_expires_at>clock_timestamp()`,[reservationId,p.tenantId,p.userId,USAGE_RESERVATION_LEASE_DURATION_MS]);
    if(renewed.rowCount!==1)throw new HttpError('Usage reservation lease is no longer active',409,'reservation_lease_expired');
  }
  async reapExpiredUsageReservations(limit:number=USAGE_RESERVATION_REAP_BATCH_SIZE):Promise<number>{
    const boundedLimit=Math.min(Math.max(Number.isFinite(limit)?Math.trunc(limit):USAGE_RESERVATION_REAP_BATCH_SIZE,1),USAGE_RESERVATION_REAP_BATCH_SIZE);
    const count=await this.transaction(async(client)=>{
      const released=await client.query(usageReservationReapSql,[boundedLimit]);
      const refunds=new Map<string,{tenantId:string;userId:string;amountCents:number}>();
      for(const row of released.rows){
        const tenantId=String(row.tenant_id);const userId=String(row.user_id);const key=`${tenantId}:${userId}`;const current=refunds.get(key);
        refunds.set(key,{tenantId,userId,amountCents:(current?.amountCents??0)+Number(row.wallet_cents)});
        await this.restoreGrants(client,parseGrantAllocations(row.grant_allocations));
      }
      for(const refund of refunds.values())if(refund.amountCents>0)await client.query('UPDATE cod_users SET balance_cents=balance_cents+$3,updated_at=now() WHERE tenant_id=$1 AND user_id=$2',[refund.tenantId,refund.userId,refund.amountCents]);
      return released.rowCount??released.rows.length;
    });
    if(count>0){recordUsageReservationsReaped(count);console.info(JSON.stringify({level:'info',event:'usage.reservations.reaped',count,limit:boundedLimit}));}
    return count;
  }
  async settleUsage(p:Principal,reservationId:string,event:UsageEvent,completion?:ChatRequestCompletion,executionId?:string) {
    if(!Number.isInteger(event.costCents)||event.costCents<0)throw new HttpError('Usage cost is invalid',400,'invalid_usage');
    if(executionId&&!taskExecutionIdPattern.test(executionId))throw new HttpError('Task execution is invalid',400,'invalid_task_execution');
    if(event.taskId!=='chat')await this.reapTaskLeases(p,event.taskId);
    if(completion){
      validateChatRequestIdentity(completion.requestKey,completion.fingerprint);
      if(event.idempotencyKey!==`chat:${completion.requestKey}:${completion.fingerprint}`)throw new HttpError('Chat settlement key is invalid',400,'invalid_idempotency_key');
      if(!completion.responsePayload||typeof completion.responsePayload!=='object'||Array.isArray(completion.responsePayload))throw new HttpError('Chat response payload is invalid',400,'invalid_chat_response');
      if(Buffer.byteLength(JSON.stringify(completion.responsePayload),'utf8')>CHAT_RESPONSE_CACHE_MAX_BYTES)throw new HttpError('Model response is too large to cache safely',502,'chat_response_cache_too_large');
    }
    return this.transaction(async(client)=>{
      if(completion)await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`chat-request:${p.tenantId}:${p.userId}:${completion.requestKey}`]);
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`${p.tenantId}:${p.userId}:${event.idempotencyKey}`]);
      const chatRequest=completion?await client.query(
        'SELECT request_fingerprint,status,task_execution_id FROM cod_chat_requests WHERE tenant_id=$1 AND user_id=$2 AND request_key=$3 FOR UPDATE',
        [p.tenantId,p.userId,completion.requestKey],
      ):null;
      if(completion){
        const row=chatRequest?.rows[0] as Record<string,unknown>|undefined;
        if(!row||String(row.request_fingerprint)!==completion.fingerprint)throw new HttpError('Chat request claim was not found',409,'chat_request_not_claimed');
        if((row.task_execution_id?String(row.task_execution_id):null)!==(completion.executionId??null))throw new HttpError('Chat request belongs to another task execution',409,'chat_request_not_claimed');
        if(row.status==='failed')throw new HttpError('Chat request is no longer pending',409,'chat_request_not_pending');
      }
      const reservation=await client.query(`SELECT *,lease_expires_at>clock_timestamp() AS lease_active FROM cod_usage_reservations WHERE id=$1 AND tenant_id=$2 AND user_id=$3 FOR UPDATE`,[reservationId,p.tenantId,p.userId]);
      const existing=await client.query('SELECT * FROM cod_ledger WHERE tenant_id=$1 AND user_id=$2 AND idempotency_key=$3',[p.tenantId,p.userId,event.idempotencyKey]);
      if(existing.rows[0]){
        if(event.taskId!=='chat'&&((reservation.rows[0]?.task_id?String(reservation.rows[0].task_id):null)!==event.taskId||(reservation.rows[0]?.task_execution_id?String(reservation.rows[0].task_execution_id):null)!==executionId))throw new HttpError('Reservation belongs to another task execution',409,'reservation_execution_conflict');
        if(reservation.rows[0]?.status==='reserved')await this.releaseReservation(client,p,reservation.rows[0],reservationId);
        if(completion&&chatRequest?.rows[0]?.status==='pending')await client.query(
          `UPDATE cod_chat_requests SET status='complete',response_payload=$4,updated_at=now(),expires_at=now()+interval '24 hours' WHERE tenant_id=$1 AND user_id=$2 AND request_key=$3`,
          [p.tenantId,p.userId,completion.requestKey,JSON.stringify(completion.responsePayload)],
        );
        return ledgerFromRow(existing.rows[0]);
      }
      if(event.taskId!=='chat'){
        if(!executionId)throw new HttpError('Task execution is required for settlement',409,'task_lease_required');
        if((reservation.rows[0]?.task_id?String(reservation.rows[0].task_id):null)!==event.taskId||(reservation.rows[0]?.task_execution_id?String(reservation.rows[0].task_execution_id):null)!==executionId)throw new HttpError('Reservation belongs to another task execution',409,'reservation_execution_conflict');
        const task=await client.query(`SELECT 1 FROM cod_tasks WHERE id=$1 AND tenant_id=$2 AND user_id=$3 AND execution_id=$4 AND status IN ('running','waiting') AND lease_expires_at>now() FOR UPDATE`,[event.taskId,p.tenantId,p.userId,executionId]);
        if(!task.rows[0])throw new HttpError('Task execution lease is no longer active',409,'task_lease_expired');
      }
      if(completion&&chatRequest?.rows[0]?.status==='complete')throw new HttpError('Completed chat request is missing its billing record',500,'chat_billing_inconsistent');
      if(!reservation.rows[0]||reservation.rows[0].status!=='reserved'||reservation.rows[0].lease_active!==true)throw new HttpError('Usage reservation lease is no longer active',409,'reservation_lease_expired');
      const billedEvent=p.role==='admin'?{...event,costCents:0,paymentDirection:'管理员测试免计费',commissionRateBps:0,commissionCents:0}:event;
      const reservedGrants=parseGrantAllocations(reservation.rows[0].grant_allocations);const reservedWallet=Number(reservation.rows[0].wallet_cents);let remaining=billedEvent.costCents;let creditConsumed=0;
      for(const allocation of reservedGrants){const consumed=Math.min(allocation.amountCents,remaining);creditConsumed+=consumed;remaining-=consumed;const refund=allocation.amountCents-consumed;if(refund>0)await this.restoreGrants(client,[{grantId:allocation.grantId,amountCents:refund}]);}
      const walletConsumed=Math.min(reservedWallet,remaining);remaining-=walletConsumed;const walletRefund=reservedWallet-walletConsumed;if(walletRefund>0)await client.query('UPDATE cod_users SET balance_cents=balance_cents+$3,updated_at=now() WHERE tenant_id=$1 AND user_id=$2',[p.tenantId,p.userId,walletRefund]);
      let totalWalletConsumed=walletConsumed;
      if(remaining>0){const extra=await this.allocateFunds(client,p,remaining);totalWalletConsumed+=extra.walletCents;creditConsumed+=extra.grantAllocations.reduce((total,item)=>total+item.amountCents,0);}
      const inserted=await this.insertUsageLedger(client,p,billedEvent,totalWalletConsumed,creditConsumed);
      await client.query(`UPDATE cod_usage_reservations SET status='settled',updated_at=now() WHERE id=$1`,[reservationId]);
      if(completion){
        const cached=await client.query(
          `UPDATE cod_chat_requests SET status='complete',response_payload=$4,updated_at=now(),expires_at=now()+interval '24 hours'
           WHERE tenant_id=$1 AND user_id=$2 AND request_key=$3 AND request_fingerprint=$5 AND status='pending'`,
          [p.tenantId,p.userId,completion.requestKey,JSON.stringify(completion.responsePayload),completion.fingerprint],
        );
        if(cached.rowCount!==1)throw new HttpError('Chat response could not be committed atomically',409,'chat_request_not_pending');
        await client.query(
          'INSERT INTO cod_audit (id,tenant_id,user_id,action,entity_type,entity_id,data) VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [randomUUID(),p.tenantId,p.userId,'chat.complete','model',completion.audit.entityId,JSON.stringify(completion.audit.data)],
        );
      }
      return inserted;
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
  async listDevices(p: Principal) {
    return this.transaction(async (client) => {
      await client.query(
        `UPDATE cod_devices SET status='offline'
         WHERE tenant_id=$1 AND user_id=$2 AND status<>'offline'
           AND last_seen_at<=now()-$3::double precision*interval '1 millisecond'`,
        [p.tenantId,p.userId,DEVICE_OFFLINE_AFTER_MS],
      );
      const {rows}=await client.query('SELECT * FROM cod_devices WHERE tenant_id=$1 AND user_id=$2 ORDER BY created_at',[p.tenantId,p.userId]);
      return rows.map(deviceFromRow);
    });
  }
  async registerDevice(p: Principal,input:Pick<DeviceRecord,'name'|'platform'>) { validateDeviceInput(input); const id=randomUUID(); const {rows}=await this.pool.query(`INSERT INTO cod_devices (id,tenant_id,user_id,name,platform,status,last_seen_at) VALUES ($1,$2,$3,$4,$5,'online',now()) RETURNING *`,[id,p.tenantId,p.userId,input.name.trim().slice(0,100),input.platform]); const device=deviceFromRow(rows[0]); await this.append(p,'device.registered',id,device); return device; }
  async heartbeat(p: Principal,id:string,taskLease?:TaskLeaseHeartbeat) {
    if(taskLease)validateTaskExecutionCredential(taskLease);
    return this.transaction(async(client)=>{
      const {rows}=await client.query(`UPDATE cod_devices SET status='online',last_seen_at=now() WHERE id=$1 AND tenant_id=$2 AND user_id=$3 RETURNING *`,[id,p.tenantId,p.userId]);
      if(!rows[0])throw new HttpError('Device not found',404,'device_not_found');
      if(taskLease){
        const renewed=await client.query(
          `UPDATE cod_tasks SET lease_expires_at=now()+$7::double precision*interval '1 millisecond'
           WHERE id=$1 AND tenant_id=$2 AND user_id=$3 AND device_id=$4
             AND execution_id=$5 AND lease_token_hash=$6 AND status IN ('running','waiting') AND lease_expires_at>now()`,
          [taskLease.taskId,p.tenantId,p.userId,id,taskLease.executionId,hashTaskLeaseToken(taskLease.leaseToken),TASK_LEASE_DURATION_MS],
        );
        if(renewed.rowCount!==1)throw new HttpError('Task execution lease is no longer active',409,'task_lease_expired');
      }
      return deviceFromRow(rows[0]);
    });
  }
  async listTasks(p: Principal) {
    await this.reapTaskLeases(p);const {rows}=await this.pool.query('SELECT * FROM cod_tasks WHERE tenant_id=$1 AND user_id=$2 ORDER BY updated_at DESC',[p.tenantId,p.userId]);return rows.map(taskFromRow);
  }
  async getTask(p:Principal,id:string) {
    await this.reapTaskLeases(p,id);const {rows}=await this.pool.query('SELECT * FROM cod_tasks WHERE id=$1 AND tenant_id=$2 AND user_id=$3',[id,p.tenantId,p.userId]);if(!rows[0])throw new HttpError('Task not found',404,'task_not_found');return taskFromRow(rows[0]);
  }
  async createTask(p: Principal,input:Pick<SyncedTask,'title'|'deviceId'>) {
    if(!input.title?.trim())throw new HttpError('Task title is required',400,'invalid_task');
    const device=await this.pool.query(`SELECT 1 FROM cod_devices WHERE id=$1 AND tenant_id=$2 AND user_id=$3 AND status='online' AND last_seen_at>now()-$4::double precision*interval '1 millisecond'`,[input.deviceId,p.tenantId,p.userId,DEVICE_OFFLINE_AFTER_MS]);
    if(!device.rows[0]){const exists=await this.pool.query('SELECT 1 FROM cod_devices WHERE id=$1 AND tenant_id=$2 AND user_id=$3',[input.deviceId,p.tenantId,p.userId]);if(!exists.rows[0])throw new HttpError('Device not found',404,'device_not_found');throw new HttpError('Device is offline',409,'device_offline');}
    const id=randomUUID();const {rows}=await this.pool.query(`INSERT INTO cod_tasks (id,tenant_id,user_id,title,status,device_id) VALUES ($1,$2,$3,$4,'draft',$5) RETURNING *`,[id,p.tenantId,p.userId,input.title.trim().slice(0,500),input.deviceId]);const task=taskFromRow(rows[0]);await this.append(p,'task.created',id,task);return task;
  }
  async claimTask(p:Principal,id:string,version:number,claim:TaskExecutionClaimCredential):Promise<TaskExecutionClaim>{
    validateTaskExecutionClaimCredential(claim);
    await this.reapTaskLeases(p,id);
    return this.transaction(async(client)=>{
      const currentResult=await client.query('SELECT *,lease_expires_at>now() AS lease_active FROM cod_tasks WHERE id=$1 AND tenant_id=$2 AND user_id=$3 FOR UPDATE',[id,p.tenantId,p.userId]);
      if(!currentResult.rows[0])throw new HttpError('Task not found',404,'task_not_found');
      const current=taskFromRow(currentResult.rows[0]);
      if(current.status==='running'||current.status==='waiting'){
        const sameClaim=String(currentResult.rows[0].claim_id_hash??'')===hashTaskLeaseToken(claim.claimId)
          && String(currentResult.rows[0].lease_token_hash??'')===hashTaskLeaseToken(claim.leaseToken)
          && Boolean(currentResult.rows[0].execution_id)
          && currentResult.rows[0].lease_active===true;
        if(!sameClaim)throw new HttpError('Task already has an active execution',409,'task_already_running');
        return{task:current,executionId:String(currentResult.rows[0].execution_id),leaseToken:claim.leaseToken,leaseExpiresAt:new Date(String(currentResult.rows[0].lease_expires_at)).toISOString(),replayed:true};
      }
      if(current.version!==version)throw new HttpError('Task version conflict',409,'version_conflict');
      validateTaskTransition(current.status,'running');
      const device=await client.query(`SELECT 1 FROM cod_devices WHERE id=$1 AND tenant_id=$2 AND user_id=$3 AND status='online' AND last_seen_at>now()-$4::double precision*interval '1 millisecond'`,[current.deviceId,p.tenantId,p.userId,DEVICE_OFFLINE_AFTER_MS]);
      if(!device.rows[0])throw new HttpError('Device is offline',409,'device_offline');
      const executionId=randomUUID();
      const updated=await client.query(
        `UPDATE cod_tasks SET status='running',result=NULL,error=NULL,execution_id=$2,claim_id_hash=$3,lease_token_hash=$4,
           lease_expires_at=now()+$5::double precision*interval '1 millisecond',version=version+1,updated_at=now()
         WHERE id=$1 RETURNING *`,
        [id,executionId,hashTaskLeaseToken(claim.claimId),hashTaskLeaseToken(claim.leaseToken),TASK_LEASE_DURATION_MS],
      );
      const task=taskFromRow(updated.rows[0]);const leaseExpiresAt=new Date(String(updated.rows[0].lease_expires_at)).toISOString();
      await client.query('INSERT INTO cod_events (tenant_id,user_id,type,entity_id,data) VALUES ($1,$2,$3,$4,$5)',[p.tenantId,p.userId,'task.updated',id,JSON.stringify(task)]);
      await client.query('INSERT INTO cod_audit (id,tenant_id,user_id,action,entity_type,entity_id,data) VALUES ($1,$2,$3,$4,$5,$6,$7)',[randomUUID(),p.tenantId,p.userId,'task.execution.claim','task',id,JSON.stringify({executionId,leaseExpiresAt})]);
      return{task,executionId,leaseToken:claim.leaseToken,leaseExpiresAt,replayed:false};
    });
  }
  async assertTaskExecution(p:Principal,id:string,executionId:string){
    if(!taskExecutionIdPattern.test(executionId))throw new HttpError('Task execution is invalid',400,'invalid_task_execution');
    await this.reapTaskLeases(p,id);const {rows}=await this.pool.query(`SELECT * FROM cod_tasks WHERE id=$1 AND tenant_id=$2 AND user_id=$3 AND execution_id=$4 AND status IN ('running','waiting') AND lease_expires_at>now()`,[id,p.tenantId,p.userId,executionId]);if(!rows[0])throw new HttpError('Task execution lease is no longer active',409,'task_lease_expired');return taskFromRow(rows[0]);
  }
  async assertTaskLease(p:Principal,id:string,execution:TaskExecutionCredential){
    validateTaskExecutionCredential(execution);await this.reapTaskLeases(p,id);const {rows}=await this.pool.query(`SELECT * FROM cod_tasks WHERE id=$1 AND tenant_id=$2 AND user_id=$3 AND execution_id=$4 AND lease_token_hash=$5 AND status IN ('running','waiting') AND lease_expires_at>now()`,[id,p.tenantId,p.userId,execution.executionId,hashTaskLeaseToken(execution.leaseToken)]);if(!rows[0])throw new HttpError('Task execution lease is no longer active',409,'task_lease_expired');return taskFromRow(rows[0]);
  }
  async renewTaskExecution(p:Principal,id:string,executionId:string){if(!taskExecutionIdPattern.test(executionId))throw new HttpError('Task execution is invalid',400,'invalid_task_execution');const renewed=await this.pool.query(`UPDATE cod_tasks SET lease_expires_at=now()+$5::double precision*interval '1 millisecond' WHERE id=$1 AND tenant_id=$2 AND user_id=$3 AND execution_id=$4 AND status IN ('running','waiting') AND lease_expires_at>now()`,[id,p.tenantId,p.userId,executionId,TASK_LEASE_DURATION_MS]);if(renewed.rowCount!==1)throw new HttpError('Task execution lease is no longer active',409,'task_lease_expired');}
  async updateTask(p: Principal,id:string,status:TaskStatus,version:number,outcome:TaskOutcome={},execution?:TaskExecutionCredential) {
    await this.reapTaskLeases(p,id);
    return this.transaction(async (client) => {
      const currentResult = await client.query('SELECT * FROM cod_tasks WHERE id=$1 AND tenant_id=$2 AND user_id=$3 FOR UPDATE', [id,p.tenantId,p.userId]);
      if (!currentResult.rows[0]) throw new HttpError('Task not found',404,'task_not_found');
      const current = taskFromRow(currentResult.rows[0]);
      if (current.version !== version) throw new HttpError('Task version conflict',409,'version_conflict');
      if(status==='running'&&current.status!=='waiting'&&current.status!=='running')throw new HttpError('Running tasks must claim a new execution lease',409,'task_claim_required');
      validateTaskTransition(current.status, status);
      if((current.status==='running'||current.status==='waiting')&&status!=='cancelled'){
        if(!execution)throw new HttpError('Task execution lease is required',409,'task_lease_required');
        validateTaskExecutionCredential(execution);
        const validLease=await client.query(`SELECT 1 FROM cod_tasks WHERE id=$1 AND execution_id=$2 AND lease_token_hash=$3 AND lease_expires_at>now()`,[id,execution.executionId,hashTaskLeaseToken(execution.leaseToken)]);
        if(!validLease.rows[0])throw new HttpError('Task execution lease is no longer active',409,'task_lease_expired');
      }
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
      const terminal=status==='complete'||status==='failed'||status==='cancelled';
      const { rows } = await client.query('UPDATE cod_tasks SET status=$1,result=$3,error=$4,execution_id=CASE WHEN $5 THEN NULL ELSE execution_id END,claim_id_hash=CASE WHEN $5 THEN NULL ELSE claim_id_hash END,lease_token_hash=CASE WHEN $5 THEN NULL ELSE lease_token_hash END,lease_expires_at=CASE WHEN $5 THEN NULL ELSE lease_expires_at END,version=version+1,updated_at=now() WHERE id=$2 RETURNING *', [status,id,nextResult,nextError,terminal]);
      const task = taskFromRow(rows[0]);
      await client.query('INSERT INTO cod_events (tenant_id,user_id,type,entity_id,data) VALUES ($1,$2,$3,$4,$5)', [p.tenantId,p.userId,'task.updated',id,JSON.stringify(task)]);
      return task;
    });
  }
  async eventsAfter(p:Principal,cursor:number) { const {rows}=await this.pool.query('SELECT * FROM cod_events WHERE tenant_id=$1 AND user_id=$2 AND cursor>$3 ORDER BY cursor LIMIT 500',[p.tenantId,p.userId,cursor]); return rows.map((row)=>({cursor:Number(row.cursor),type:row.type,entityId:String(row.entity_id),data:row.data,createdAt:new Date(row.created_at).toISOString()})); }
  async audit(p:Principal,action:string,entityType:string,entityId:string|null,data:unknown={}) { await this.pool.query('INSERT INTO cod_audit (id,tenant_id,user_id,action,entity_type,entity_id,data) VALUES ($1,$2,$3,$4,$5,$6,$7)',[randomUUID(),p.tenantId,p.userId,action,entityType,entityId,JSON.stringify(data)]); }
  async listAudit(p:Principal,limit:number) { const {rows}=await this.pool.query('SELECT * FROM cod_audit WHERE tenant_id=$1 AND user_id=$2 ORDER BY created_at DESC LIMIT $3',[p.tenantId,p.userId,Math.min(Math.max(limit,1),200)]); return rows.map((row)=>({id:String(row.id),action:String(row.action),entityType:String(row.entity_type),entityId:row.entity_id?String(row.entity_id):null,data:row.data,createdAt:new Date(row.created_at).toISOString()})); }
  private async reapTaskLeases(p?:Principal,taskId?:string):Promise<SyncedTask[]>{return this.transaction((client)=>this.expireTaskLeases(client,p,taskId));}
  private async expireTaskLeases(client:PoolClient,p?:Principal,taskId?:string):Promise<SyncedTask[]>{
    const values:unknown[]=[LEGACY_TASK_INTERRUPTED_ERROR,TASK_LEASE_EXPIRED_ERROR];
    const conditions=[`t.status IN ('running','waiting')`,`(t.execution_id IS NULL OR t.claim_id_hash IS NULL OR t.claim_id_hash !~ '^[a-f0-9]{64}$' OR t.lease_token_hash IS NULL OR t.lease_token_hash !~ '^[a-f0-9]{64}$' OR t.lease_expires_at IS NULL OR t.lease_expires_at<=now())`];
    if(p){values.push(p.tenantId);conditions.push(`t.tenant_id=$${values.length}`);values.push(p.userId);conditions.push(`t.user_id=$${values.length}`);}
    if(taskId){values.push(taskId);conditions.push(`t.id=$${values.length}`);}
    const expired=await client.query(
      `WITH candidates AS (
         SELECT t.id,t.tenant_id,t.user_id,t.execution_id AS previous_execution_id,
           (t.execution_id IS NULL OR t.claim_id_hash IS NULL OR t.claim_id_hash !~ '^[a-f0-9]{64}$' OR t.lease_token_hash IS NULL OR t.lease_token_hash !~ '^[a-f0-9]{64}$' OR t.lease_expires_at IS NULL) AS legacy
         FROM cod_tasks t WHERE ${conditions.join(' AND ')} FOR UPDATE
       ), updated AS (
         UPDATE cod_tasks t SET status='failed',result=NULL,error=CASE WHEN c.legacy THEN $1 ELSE $2 END,
           execution_id=NULL,claim_id_hash=NULL,lease_token_hash=NULL,lease_expires_at=NULL,version=t.version+1,updated_at=now()
         FROM candidates c WHERE t.id=c.id RETURNING t.*,c.legacy,c.previous_execution_id
       ) SELECT * FROM updated`,
      values,
    );
    const tasks:SyncedTask[]=[];
    for(const row of expired.rows){
      const task=taskFromRow(row);tasks.push(task);const reason=row.legacy?'legacy_missing_lease':'lease_expired';
      await client.query('INSERT INTO cod_events (tenant_id,user_id,type,entity_id,data) VALUES ($1,$2,$3,$4,$5)',[row.tenant_id,row.user_id,'task.updated',task.id,JSON.stringify(task)]);
      await client.query('INSERT INTO cod_audit (id,tenant_id,user_id,action,entity_type,entity_id,data) VALUES ($1,$2,$3,$4,$5,$6,$7)',[randomUUID(),row.tenant_id,row.user_id,'task.execution.interrupted','task',task.id,JSON.stringify({reason,executionId:row.previous_execution_id??null})]);
    }
    return tasks;
  }
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
  private startUsageReservationReaper():void{
    if(this.reservationReaperTimer)return;
    this.reservationReaperTimer=setInterval(()=>{
      if(this.reservationReaperRun)return;
      const run=this.reapExpiredUsageReservations();this.reservationReaperRun=run;
      void run.catch((error:unknown)=>console.error(JSON.stringify({level:'error',event:'usage.reservations.reap_failed',error:error instanceof Error?error.message:String(error)}))).finally(()=>{if(this.reservationReaperRun===run)this.reservationReaperRun=null;});
    },USAGE_RESERVATION_REAP_INTERVAL_MS);
    this.reservationReaperTimer.unref();
  }
  private async append(p:Principal,type:TaskEvent['type'],entityId:string,data:unknown) { await this.pool.query('INSERT INTO cod_events (tenant_id,user_id,type,entity_id,data) VALUES ($1,$2,$3,$4,$5)',[p.tenantId,p.userId,type,entityId,JSON.stringify(data)]); }
  private async transaction<T>(run:(client:PoolClient)=>Promise<T>):Promise<T> { const client=await this.pool.connect(); try { await client.query('BEGIN'); const value=await run(client); await client.query('COMMIT'); return value; } catch(error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); } }
}
