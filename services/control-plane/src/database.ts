import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import type { AccountSummary, DeviceRecord, TaskStatus, UsageEvent } from '@cod/contracts';
import { HttpError } from './errors.js';

export interface Principal {
  userId: string;
  tenantId: string;
  email: string;
  role: 'member' | 'admin';
}

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

export interface SyncedTask {
  id: string;
  title: string;
  status: TaskStatus;
  deviceId: string;
  updatedAt: string;
  version: number;
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

export interface CodDatabase {
  initialize(): Promise<void>;
  health(): Promise<boolean>;
  ensurePrincipal(principal: Principal): Promise<void>;
  getAccount(principal: Principal): Promise<AccountSummary>;
  getLedger(principal: Principal): Promise<LedgerEntry[]>;
  topup(principal: Principal, request: TopupRequest): Promise<LedgerEntry>;
  recordUsage(principal: Principal, event: UsageEvent): Promise<LedgerEntry>;
  reserveUsage(principal: Principal, reservationId: string, amountCents: number): Promise<void>;
  settleUsage(principal: Principal, reservationId: string, event: UsageEvent): Promise<LedgerEntry>;
  releaseUsage(principal: Principal, reservationId: string): Promise<void>;
  listDevices(principal: Principal): Promise<DeviceRecord[]>;
  registerDevice(principal: Principal, input: Pick<DeviceRecord, 'name' | 'platform'>): Promise<DeviceRecord>;
  heartbeat(principal: Principal, deviceId: string): Promise<DeviceRecord>;
  listTasks(principal: Principal): Promise<SyncedTask[]>;
  createTask(principal: Principal, input: Pick<SyncedTask, 'title' | 'deviceId'>): Promise<SyncedTask>;
  updateTask(principal: Principal, taskId: string, status: TaskStatus, expectedVersion: number): Promise<SyncedTask>;
  eventsAfter(principal: Principal, cursor: number): Promise<TaskEvent[]>;
  audit(principal: Principal, action: string, entityType: string, entityId: string | null, data?: unknown): Promise<void>;
  listAudit(principal: Principal, limit: number): Promise<AuditEntry[]>;
  close(): Promise<void>;
}

const devicePlatforms = new Set<DeviceRecord['platform']>(['macos', 'windows', 'linux', 'web', 'mobile']);
const taskTransitions: Record<TaskStatus, ReadonlySet<TaskStatus>> = {
  draft: new Set(['running', 'failed']),
  running: new Set(['waiting', 'complete', 'failed']),
  waiting: new Set(['running', 'complete', 'failed']),
  complete: new Set(['running']),
  failed: new Set(['running']),
};

export function validateDeviceInput(input: Pick<DeviceRecord, 'name' | 'platform'>): void {
  if (!input.name?.trim()) throw new HttpError('Device name is required', 400, 'invalid_device');
  if (!devicePlatforms.has(input.platform)) throw new HttpError('Device platform is invalid', 400, 'invalid_device_platform');
}

export function validateTaskTransition(current: TaskStatus, next: TaskStatus): void {
  if (current === next) return;
  if (!taskTransitions[current].has(next)) throw new HttpError(`Task cannot move from ${current} to ${next}`, 409, 'invalid_task_transition');
}

const schema = `
CREATE TABLE IF NOT EXISTS cod_users (
  tenant_id text NOT NULL, user_id text NOT NULL, email text NOT NULL, display_name text NOT NULL,
  balance_cents bigint NOT NULL DEFAULT 6840 CHECK (balance_cents >= 0), currency text NOT NULL DEFAULT 'CNY', plan text NOT NULL DEFAULT 'developer',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id, user_id), UNIQUE (tenant_id, email)
);
CREATE TABLE IF NOT EXISTS cod_ledger (
  id uuid PRIMARY KEY, tenant_id text NOT NULL, user_id text NOT NULL, type text NOT NULL CHECK (type IN ('topup','usage')),
  amount_cents bigint NOT NULL, reference text NOT NULL, idempotency_key text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id, idempotency_key)
);
CREATE TABLE IF NOT EXISTS cod_usage_reservations (
  id uuid PRIMARY KEY, tenant_id text NOT NULL, user_id text NOT NULL, amount_cents bigint NOT NULL CHECK (amount_cents >= 0),
  status text NOT NULL CHECK (status IN ('reserved','settled','released')), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS cod_devices (
  id uuid PRIMARY KEY, tenant_id text NOT NULL, user_id text NOT NULL, name text NOT NULL, platform text NOT NULL,
  status text NOT NULL, last_seen_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS cod_tasks (
  id uuid PRIMARY KEY, tenant_id text NOT NULL, user_id text NOT NULL, title text NOT NULL, status text NOT NULL,
  device_id uuid NOT NULL REFERENCES cod_devices(id), version integer NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now()
);
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
`;

const accountFromRow = (row: Record<string, unknown>): AccountSummary => ({
  userId: String(row.user_id), displayName: String(row.display_name), balanceCents: Number(row.balance_cents), currency: 'CNY', plan: row.plan === 'team' ? 'team' : 'developer',
});
const ledgerFromRow = (row: Record<string, unknown>): LedgerEntry => ({ id: String(row.id), type: row.type as LedgerEntry['type'], amountCents: Number(row.amount_cents), reference: String(row.reference), createdAt: new Date(String(row.created_at)).toISOString() });
const deviceFromRow = (row: Record<string, unknown>): DeviceRecord => {
  const lastSeenAt = new Date(String(row.last_seen_at)).toISOString();
  const stale = Date.now() - new Date(lastSeenAt).getTime() > 45_000;
  return { id: String(row.id), name: String(row.name), platform: row.platform as DeviceRecord['platform'], status: stale ? 'offline' : row.status as DeviceRecord['status'], lastSeenAt };
};
const taskFromRow = (row: Record<string, unknown>): SyncedTask => ({ id: String(row.id), title: String(row.title), status: row.status as TaskStatus, deviceId: String(row.device_id), updatedAt: new Date(String(row.updated_at)).toISOString(), version: Number(row.version) });

export class PostgresDatabase implements CodDatabase {
  private readonly pool: Pool;
  constructor(databaseUrl: string) { this.pool = new Pool({ connectionString: databaseUrl, max: 10, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000 }); }
  async initialize() { await this.pool.query(schema); }
  async close() { await this.pool.end(); }
  async health() { try { await this.pool.query('SELECT 1'); return true; } catch { return false; } }
  async ensurePrincipal(p: Principal) {
    await this.pool.query(`INSERT INTO cod_users (tenant_id,user_id,email,display_name) VALUES ($1,$2,$3,$4) ON CONFLICT (tenant_id,user_id) DO UPDATE SET email=EXCLUDED.email,updated_at=now()`, [p.tenantId,p.userId,p.email,p.email.split('@')[0]]);
  }
  async getAccount(p: Principal) { const { rows } = await this.pool.query('SELECT * FROM cod_users WHERE tenant_id=$1 AND user_id=$2',[p.tenantId,p.userId]); if (!rows[0]) throw new HttpError('Account not found',404,'account_not_found'); return accountFromRow(rows[0]); }
  async getLedger(p: Principal) { const { rows } = await this.pool.query('SELECT * FROM cod_ledger WHERE tenant_id=$1 AND user_id=$2 ORDER BY created_at DESC LIMIT 200',[p.tenantId,p.userId]); return rows.map(ledgerFromRow); }
  async topup(p: Principal, request: TopupRequest) {
    if (!Number.isInteger(request.amountCents) || request.amountCents < 100 || request.amountCents > 1_000_000) throw new HttpError('Top-up amount must be between 100 and 1000000 cents',400,'invalid_topup');
    return this.transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${p.tenantId}:${p.userId}:${request.idempotencyKey}`]);
      const existing = await client.query('SELECT * FROM cod_ledger WHERE tenant_id=$1 AND user_id=$2 AND idempotency_key=$3',[p.tenantId,p.userId,request.idempotencyKey]); if (existing.rows[0]) return ledgerFromRow(existing.rows[0]);
      const id=randomUUID(); const reference=`${request.channel}:${request.idempotencyKey}`;
      const inserted=await client.query(`INSERT INTO cod_ledger (id,tenant_id,user_id,type,amount_cents,reference,idempotency_key) VALUES ($1,$2,$3,'topup',$4,$5,$6) RETURNING *`,[id,p.tenantId,p.userId,request.amountCents,reference,request.idempotencyKey]);
      await client.query('UPDATE cod_users SET balance_cents=balance_cents+$3,updated_at=now() WHERE tenant_id=$1 AND user_id=$2',[p.tenantId,p.userId,request.amountCents]); return ledgerFromRow(inserted.rows[0]);
    });
  }
  async recordUsage(p: Principal, event: UsageEvent) {
    if (!Number.isInteger(event.costCents) || event.costCents < 0) throw new HttpError('Usage cost is invalid',400,'invalid_usage');
    return this.transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${p.tenantId}:${p.userId}:${event.idempotencyKey}`]);
      const existing=await client.query('SELECT * FROM cod_ledger WHERE tenant_id=$1 AND user_id=$2 AND idempotency_key=$3',[p.tenantId,p.userId,event.idempotencyKey]); if(existing.rows[0]) return ledgerFromRow(existing.rows[0]);
      const account=await client.query('SELECT balance_cents FROM cod_users WHERE tenant_id=$1 AND user_id=$2 FOR UPDATE',[p.tenantId,p.userId]); if(!account.rows[0] || Number(account.rows[0].balance_cents)<event.costCents) throw new HttpError('Insufficient balance',402,'insufficient_balance');
      const inserted=await client.query(`INSERT INTO cod_ledger (id,tenant_id,user_id,type,amount_cents,reference,idempotency_key) VALUES ($1,$2,$3,'usage',$4,$5,$6) RETURNING *`,[randomUUID(),p.tenantId,p.userId,-event.costCents,`${event.model}:${event.taskId}`,event.idempotencyKey]);
      await client.query('UPDATE cod_users SET balance_cents=balance_cents-$3,updated_at=now() WHERE tenant_id=$1 AND user_id=$2',[p.tenantId,p.userId,event.costCents]); return ledgerFromRow(inserted.rows[0]);
    });
  }
  async reserveUsage(p: Principal,reservationId:string,amountCents:number) {
    if(!Number.isInteger(amountCents)||amountCents<0) throw new HttpError('Reservation amount is invalid',400,'invalid_reservation');
    await this.transaction(async(client)=>{const existing=await client.query('SELECT status FROM cod_usage_reservations WHERE id=$1 AND tenant_id=$2 AND user_id=$3',[reservationId,p.tenantId,p.userId]);if(existing.rows[0])return;const account=await client.query('SELECT balance_cents FROM cod_users WHERE tenant_id=$1 AND user_id=$2 FOR UPDATE',[p.tenantId,p.userId]);if(!account.rows[0]||Number(account.rows[0].balance_cents)<amountCents)throw new HttpError('Insufficient balance',402,'insufficient_balance');await client.query('UPDATE cod_users SET balance_cents=balance_cents-$3,updated_at=now() WHERE tenant_id=$1 AND user_id=$2',[p.tenantId,p.userId,amountCents]);await client.query(`INSERT INTO cod_usage_reservations (id,tenant_id,user_id,amount_cents,status) VALUES ($1,$2,$3,$4,'reserved')`,[reservationId,p.tenantId,p.userId,amountCents]);});
  }
  async settleUsage(p:Principal,reservationId:string,event:UsageEvent) {
    if(!Number.isInteger(event.costCents)||event.costCents<0)throw new HttpError('Usage cost is invalid',400,'invalid_usage');
    return this.transaction(async(client)=>{await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`${p.tenantId}:${p.userId}:${event.idempotencyKey}`]);const existing=await client.query('SELECT * FROM cod_ledger WHERE tenant_id=$1 AND user_id=$2 AND idempotency_key=$3',[p.tenantId,p.userId,event.idempotencyKey]);if(existing.rows[0])return ledgerFromRow(existing.rows[0]);const reservation=await client.query(`SELECT * FROM cod_usage_reservations WHERE id=$1 AND tenant_id=$2 AND user_id=$3 FOR UPDATE`,[reservationId,p.tenantId,p.userId]);if(!reservation.rows[0]||reservation.rows[0].status!=='reserved')throw new HttpError('Usage reservation not found',409,'reservation_not_found');const reserved=Number(reservation.rows[0].amount_cents);if(event.costCents>reserved){const extra=event.costCents-reserved;const account=await client.query('SELECT balance_cents FROM cod_users WHERE tenant_id=$1 AND user_id=$2 FOR UPDATE',[p.tenantId,p.userId]);if(Number(account.rows[0]?.balance_cents??0)<extra)throw new HttpError('Insufficient balance',402,'insufficient_balance');await client.query('UPDATE cod_users SET balance_cents=balance_cents-$3,updated_at=now() WHERE tenant_id=$1 AND user_id=$2',[p.tenantId,p.userId,extra]);}else if(reserved>event.costCents){await client.query('UPDATE cod_users SET balance_cents=balance_cents+$3,updated_at=now() WHERE tenant_id=$1 AND user_id=$2',[p.tenantId,p.userId,reserved-event.costCents]);}const inserted=await client.query(`INSERT INTO cod_ledger (id,tenant_id,user_id,type,amount_cents,reference,idempotency_key) VALUES ($1,$2,$3,'usage',$4,$5,$6) RETURNING *`,[randomUUID(),p.tenantId,p.userId,-event.costCents,`${event.model}:${event.taskId}`,event.idempotencyKey]);await client.query(`UPDATE cod_usage_reservations SET status='settled',updated_at=now() WHERE id=$1`,[reservationId]);return ledgerFromRow(inserted.rows[0]);});
  }
  async releaseUsage(p:Principal,reservationId:string) { await this.transaction(async(client)=>{const reservation=await client.query(`SELECT * FROM cod_usage_reservations WHERE id=$1 AND tenant_id=$2 AND user_id=$3 FOR UPDATE`,[reservationId,p.tenantId,p.userId]);if(!reservation.rows[0]||reservation.rows[0].status!=='reserved')return;await client.query('UPDATE cod_users SET balance_cents=balance_cents+$3,updated_at=now() WHERE tenant_id=$1 AND user_id=$2',[p.tenantId,p.userId,Number(reservation.rows[0].amount_cents)]);await client.query(`UPDATE cod_usage_reservations SET status='released',updated_at=now() WHERE id=$1`,[reservationId]);}); }
  async listDevices(p: Principal) { const {rows}=await this.pool.query('SELECT * FROM cod_devices WHERE tenant_id=$1 AND user_id=$2 ORDER BY created_at',[p.tenantId,p.userId]); return rows.map(deviceFromRow); }
  async registerDevice(p: Principal,input:Pick<DeviceRecord,'name'|'platform'>) { validateDeviceInput(input); const id=randomUUID(); const {rows}=await this.pool.query(`INSERT INTO cod_devices (id,tenant_id,user_id,name,platform,status,last_seen_at) VALUES ($1,$2,$3,$4,$5,'online',now()) RETURNING *`,[id,p.tenantId,p.userId,input.name.trim().slice(0,100),input.platform]); const device=deviceFromRow(rows[0]); await this.append(p,'device.registered',id,device); return device; }
  async heartbeat(p: Principal,id:string) { const {rows}=await this.pool.query(`UPDATE cod_devices SET status='online',last_seen_at=now() WHERE id=$1 AND tenant_id=$2 AND user_id=$3 RETURNING *`,[id,p.tenantId,p.userId]); if(!rows[0]) throw new HttpError('Device not found',404,'device_not_found'); return deviceFromRow(rows[0]); }
  async listTasks(p: Principal) { const {rows}=await this.pool.query('SELECT * FROM cod_tasks WHERE tenant_id=$1 AND user_id=$2 ORDER BY updated_at DESC',[p.tenantId,p.userId]); return rows.map(taskFromRow); }
  async createTask(p: Principal,input:Pick<SyncedTask,'title'|'deviceId'>) { if(!input.title?.trim()) throw new HttpError('Task title is required',400,'invalid_task'); const device=await this.pool.query('SELECT 1 FROM cod_devices WHERE id=$1 AND tenant_id=$2 AND user_id=$3',[input.deviceId,p.tenantId,p.userId]); if(!device.rows[0]) throw new HttpError('Device not found',404,'device_not_found'); const id=randomUUID(); const {rows}=await this.pool.query(`INSERT INTO cod_tasks (id,tenant_id,user_id,title,status,device_id) VALUES ($1,$2,$3,$4,'draft',$5) RETURNING *`,[id,p.tenantId,p.userId,input.title.trim().slice(0,500),input.deviceId]); const task=taskFromRow(rows[0]); await this.append(p,'task.created',id,task); return task; }
  async updateTask(p: Principal,id:string,status:TaskStatus,version:number) {
    return this.transaction(async (client) => {
      const currentResult = await client.query('SELECT * FROM cod_tasks WHERE id=$1 AND tenant_id=$2 AND user_id=$3 FOR UPDATE', [id,p.tenantId,p.userId]);
      if (!currentResult.rows[0]) throw new HttpError('Task not found',404,'task_not_found');
      const current = taskFromRow(currentResult.rows[0]);
      if (current.version !== version) throw new HttpError('Task version conflict',409,'version_conflict');
      validateTaskTransition(current.status, status);
      if (current.status === status) return current;
      const { rows } = await client.query('UPDATE cod_tasks SET status=$1,version=version+1,updated_at=now() WHERE id=$2 RETURNING *', [status,id]);
      const task = taskFromRow(rows[0]);
      await client.query('INSERT INTO cod_events (tenant_id,user_id,type,entity_id,data) VALUES ($1,$2,$3,$4,$5)', [p.tenantId,p.userId,'task.updated',id,JSON.stringify(task)]);
      return task;
    });
  }
  async eventsAfter(p:Principal,cursor:number) { const {rows}=await this.pool.query('SELECT * FROM cod_events WHERE tenant_id=$1 AND user_id=$2 AND cursor>$3 ORDER BY cursor LIMIT 500',[p.tenantId,p.userId,cursor]); return rows.map((row)=>({cursor:Number(row.cursor),type:row.type,entityId:String(row.entity_id),data:row.data,createdAt:new Date(row.created_at).toISOString()})); }
  async audit(p:Principal,action:string,entityType:string,entityId:string|null,data:unknown={}) { await this.pool.query('INSERT INTO cod_audit (id,tenant_id,user_id,action,entity_type,entity_id,data) VALUES ($1,$2,$3,$4,$5,$6,$7)',[randomUUID(),p.tenantId,p.userId,action,entityType,entityId,JSON.stringify(data)]); }
  async listAudit(p:Principal,limit:number) { const {rows}=await this.pool.query('SELECT * FROM cod_audit WHERE tenant_id=$1 AND user_id=$2 ORDER BY created_at DESC LIMIT $3',[p.tenantId,p.userId,Math.min(Math.max(limit,1),200)]); return rows.map((row)=>({id:String(row.id),action:String(row.action),entityType:String(row.entity_type),entityId:row.entity_id?String(row.entity_id):null,data:row.data,createdAt:new Date(row.created_at).toISOString()})); }
  private async append(p:Principal,type:TaskEvent['type'],entityId:string,data:unknown) { await this.pool.query('INSERT INTO cod_events (tenant_id,user_id,type,entity_id,data) VALUES ($1,$2,$3,$4,$5)',[p.tenantId,p.userId,type,entityId,JSON.stringify(data)]); }
  private async transaction<T>(run:(client:PoolClient)=>Promise<T>):Promise<T> { const client=await this.pool.connect(); try { await client.query('BEGIN'); const value=await run(client); await client.query('COMMIT'); return value; } catch(error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); } }
}
