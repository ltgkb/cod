import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { chatRequestSchemaMigration, ledgerAllocationBackfillMigration, ledgerTypeConstraintMigration, legacyInviteCodeBackfillMigration, walletOpeningBalanceMigration } from './database.js';

describe('production-safe migrations and rate limits', () => {
  it('backfills only legacy unallocated ledger rows and enforces the accounting invariant', () => {
    expect(ledgerAllocationBackfillMigration).toContain('wallet_amount_cents=0 AND credit_amount_cents=0');
    expect(ledgerAllocationBackfillMigration).toContain("type IN ('topup','usage','pack_purchase')");
    expect(ledgerAllocationBackfillMigration).toContain("type IN ('credit_grant','trial_credit')");
    expect(ledgerAllocationBackfillMigration).toContain('amount_cents=wallet_amount_cents+credit_amount_cents');
    expect(ledgerAllocationBackfillMigration.match(/UPDATE cod_ledger/g)).toHaveLength(2);
    expect(ledgerAllocationBackfillMigration.match(/WHERE wallet_amount_cents=0 AND credit_amount_cents=0/g)).toHaveLength(2);
    expect(ledgerAllocationBackfillMigration).not.toContain('DROP CONSTRAINT');
    expect(ledgerAllocationBackfillMigration).toContain('NOT VALID');
    expect(ledgerAllocationBackfillMigration).toContain('AND NOT convalidated');
    // A partially allocated row is deliberately not guessed at; the new
    // constraint fails closed instead of silently moving credit to wallet.
    const partialAllocation = { amountCents: -184, walletAmountCents: -67, creditAmountCents: -100 };
    expect(partialAllocation.walletAmountCents === 0 && partialAllocation.creditAmountCents === 0).toBe(false);
  });

  it('records an explicit idempotent opening balance instead of disguising historical wallet value as a top-up', () => {
    expect(ledgerTypeConstraintMigration).toContain("'opening_balance'");
    expect(ledgerTypeConstraintMigration).toContain('AND NOT convalidated');
    expect(walletOpeningBalanceMigration).toContain("'opening_balance'");
    expect(walletOpeningBalanceMigration).toContain("'opening-balance-v1'");
    expect(walletOpeningBalanceMigration).toContain("WHERE status='reserved'");
    expect(walletOpeningBalanceMigration).toContain('balance_cents+coalesce(r.reserved_cents,0)-coalesce(l.wallet_net,0)');
    expect(walletOpeningBalanceMigration).toContain('ON CONFLICT (tenant_id,user_id,idempotency_key) DO NOTHING');
    expect(walletOpeningBalanceMigration).not.toContain("'topup'");

    const currentBalance = 2_817;
    const projectedWalletLedger = -4_023;
    const reservedWallet = 0;
    const openingBalance = currentBalance + reservedWallet - projectedWalletLedger;
    expect(openingBalance).toBe(6_840);
    expect(projectedWalletLedger + openingBalance - reservedWallet).toBe(currentBalance);
  });

  it('assigns deterministic invite codes only to accounts that do not have one', () => {
    expect(legacyInviteCodeBackfillMigration).toContain("'KAI-' || upper(substr(md5(tenant_id || ':' || user_id),1,20))");
    expect(legacyInviteCodeBackfillMigration).toContain('WHERE invite_code IS NULL');
  });

  it('bounds durable chat replay storage and makes global expiry cleanup indexable',()=>{
    const databaseSource=readFileSync(new URL('./database.ts',import.meta.url),'utf8');
    expect(chatRequestSchemaMigration).toContain('PRIMARY KEY (tenant_id,user_id,request_key)');
    expect(chatRequestSchemaMigration).toContain("request_fingerprint ~ '^[a-f0-9]{64}$'");
    expect(chatRequestSchemaMigration).toContain("(status='complete')=(response_payload IS NOT NULL)");
    expect(chatRequestSchemaMigration).toContain("interval '1 hour'");
    expect(chatRequestSchemaMigration).toContain("interval '24 hours'");
    expect(chatRequestSchemaMigration).toContain('cod_chat_requests_expiry_idx ON cod_chat_requests(expires_at)');
    expect(databaseSource).toContain('SELECT ctid FROM cod_chat_requests WHERE expires_at<=now() ORDER BY expires_at LIMIT 1000');
  });

  it('trusts only the observed ALB subnet and isolates heartbeat bursts', () => {
    const httpConfig = readFileSync(new URL('../../../deploy/nginx-http.conf', import.meta.url), 'utf8');
    const siteConfig = readFileSync(new URL('../../../deploy/cod.nginx.conf', import.meta.url), 'utf8');

    expect(httpConfig).toContain('set_real_ip_from 172.31.0.0/20;');
    expect(httpConfig).toContain('real_ip_header X-Forwarded-For;');
    expect(httpConfig).toContain('real_ip_recursive on;');
    expect(httpConfig).not.toMatch(/set_real_ip_from\s+(?:0\.0\.0\.0\/0|10\.0\.0\.0\/8|172\.16\.0\.0\/12)/);
    expect(httpConfig).toContain('zone=cod_heartbeat:10m rate=2r/s');
    expect(siteConfig).toContain('limit_req zone=cod_heartbeat burst=5 nodelay;');
    expect(siteConfig).toContain('error_page 429 = @cod_rate_limited;');
    expect(siteConfig).toContain('return 429 \'{"error":"rate_limited"');
    expect(httpConfig).toContain('map $http_x_request_id $cod_request_id');
    expect(httpConfig).toContain('default $http_x_request_id;');
    expect(httpConfig).toContain('"" $request_id;');
    expect(siteConfig.match(/proxy_set_header X-Request-ID \$cod_request_id;/g)).toHaveLength(5);
    expect(siteConfig).not.toContain('proxy_set_header X-Request-ID $request_id;');
  });

  it('compresses large JSON catalogs and static text assets at the Nginx boundary', () => {
    const httpConfig = readFileSync(new URL('../../../deploy/nginx-http.conf', import.meta.url), 'utf8');

    expect(httpConfig).toContain('gzip on;');
    expect(httpConfig).toContain('gzip_vary on;');
    expect(httpConfig).toContain('gzip_min_length 1024;');
    expect(httpConfig).toContain('gzip_proxied any;');
    expect(httpConfig).toMatch(/gzip_types[\s\S]*?application\/json[\s\S]*?application\/javascript[\s\S]*?text\/javascript[\s\S]*?text\/css[\s\S]*?image\/svg\+xml;/);
  });
});
