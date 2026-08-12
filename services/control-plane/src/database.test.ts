import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { PostgresDatabase, USAGE_RESERVATION_REAP_BATCH_SIZE, USAGE_RESERVATION_REAP_INTERVAL_MS, usageReservationLeaseSchemaMigration, usageReservationReapSql } from './database.js';

describe('PostgresDatabase pool lifecycle', () => {
  it('logs idle pool errors instead of letting EventEmitter terminate the service', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const database = new PostgresDatabase('postgresql://cod:test@127.0.0.1:5432/cod');
    const pool = (database as unknown as { pool: EventEmitter }).pool;

    expect(() => pool.emit('error', new Error('terminating connection due to administrator command'))).not.toThrow();
    expect(log).toHaveBeenCalledWith(JSON.stringify({
      level: 'error',
      event: 'postgres.pool.error',
      error: 'terminating connection due to administrator command',
    }));

    log.mockRestore();
    await database.close();
  });

  it('leases usage reservations and reaps only bounded expired rows with concurrent-worker fencing',()=>{
    const databaseSource=readFileSync(new URL('./database.ts',import.meta.url),'utf8');
    expect(usageReservationLeaseSchemaMigration).toContain('ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz');
    expect(usageReservationLeaseSchemaMigration).toContain("status='reserved' THEN now()+interval '15 minutes'");
    expect(usageReservationLeaseSchemaMigration).toContain("SET DEFAULT (now()+interval '90 seconds')");
    expect(usageReservationLeaseSchemaMigration).toContain('ALTER COLUMN lease_expires_at SET NOT NULL');
    expect(usageReservationLeaseSchemaMigration).toContain("WHERE status='reserved'");
    expect(usageReservationReapSql).toContain("WHERE status='reserved' AND lease_expires_at<=statement_timestamp()");
    expect(usageReservationReapSql).toContain('LIMIT $1');
    expect(usageReservationReapSql).toContain('FOR UPDATE SKIP LOCKED');
    expect(usageReservationReapSql).toContain("r.status='reserved' AND r.lease_expires_at<=statement_timestamp()");
    expect(usageReservationReapSql).toContain('RETURNING r.id,r.tenant_id,r.user_id,r.wallet_cents,r.grant_allocations');
    expect(USAGE_RESERVATION_REAP_BATCH_SIZE).toBe(100);
    expect(USAGE_RESERVATION_REAP_INTERVAL_MS).toBe(60_000);
    expect(databaseSource).toContain("status='reserved' AND lease_expires_at>clock_timestamp()");
    expect(databaseSource).toContain('clock_timestamp()+$9::double precision*interval');
    expect(databaseSource).toContain('this.startUsageReservationReaper()');
    expect(databaseSource).toContain('clearInterval(this.reservationReaperTimer)');
    expect(databaseSource).not.toContain("UPDATE cod_usage_reservations SET status='released',updated_at=now() WHERE status='reserved' RETURNING");
  });

  it('refunds every row returned by the atomic Postgres reaper once and clamps its batch size',async()=>{
    const database=new PostgresDatabase('postgresql://cod:test@127.0.0.1:5432/cod');let reapPass=0;
    const query=vi.fn(async(sql:string,parameters?:unknown[])=>{
      if(sql===usageReservationReapSql){reapPass+=1;return reapPass===1?{rowCount:2,rows:[
        {id:'reservation-1',tenant_id:'tenant',user_id:'user',wallet_cents:'25',grant_allocations:[{grantId:'grant-1',amountCents:40},{grantId:'grant-2',amountCents:10}]},
        {id:'reservation-2',tenant_id:'tenant',user_id:'user',wallet_cents:'50',grant_allocations:[{grantId:'grant-2',amountCents:20}]},
      ]}:{rowCount:0,rows:[]};}
      return{rowCount:1,rows:[],parameters};
    });
    type FakeClient={query:typeof query};
    const client:FakeClient={query};
    (database as unknown as {transaction:<T>(run:(client:FakeClient)=>Promise<T>)=>Promise<T>}).transaction=async<T>(run:(client:FakeClient)=>Promise<T>)=>run(client);
    const info=vi.spyOn(console,'info').mockImplementation(()=>undefined);
    expect(await database.reapExpiredUsageReservations(10_000)).toBe(2);
    expect(query).toHaveBeenCalledWith(usageReservationReapSql,[USAGE_RESERVATION_REAP_BATCH_SIZE]);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('UPDATE cod_credit_grants SET remaining_cents=LEAST'),['grant-1',40]);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('UPDATE cod_credit_grants SET remaining_cents=LEAST'),['grant-2',10]);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('UPDATE cod_credit_grants SET remaining_cents=LEAST'),['grant-2',20]);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('UPDATE cod_users SET balance_cents=balance_cents+$3'),['tenant','user',75]);
    const refundCallsAfterFirst=query.mock.calls.filter(([sql])=>String(sql).includes('UPDATE cod_users SET balance_cents')).length;
    expect(await database.reapExpiredUsageReservations(10_000)).toBe(0);
    expect(query.mock.calls.filter(([sql])=>String(sql).includes('UPDATE cod_users SET balance_cents'))).toHaveLength(refundCallsAfterFirst);
    expect(info).toHaveBeenCalledWith(expect.stringContaining('"event":"usage.reservations.reaped"'));
    info.mockRestore();await database.close();
  });
});
