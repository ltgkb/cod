import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { adminComputeRequestIndexMigration, chatRequestSchemaMigration, computeRequestHostingMigration, ledgerAllocationBackfillMigration, ledgerTypeConstraintMigration, legacyInviteCodeBackfillMigration, taskExecutionLeaseSchemaMigration, userEmailGlobalUniqueIndexMigration, walletOpeningBalanceMigration } from './database.js';

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

  it('fails fast on duplicate case-insensitive emails before building the unique index concurrently',()=>{
    const databaseSource=readFileSync(new URL('./database.ts',import.meta.url),'utf8');
    expect(userEmailGlobalUniqueIndexMigration).toContain('CREATE UNIQUE INDEX CONCURRENTLY cod_users_email_global_unique ON cod_users (lower(email))');
    expect(userEmailGlobalUniqueIndexMigration).not.toContain('IF NOT EXISTS');
    expect(databaseSource).not.toContain('CREATE UNIQUE INDEX IF NOT EXISTS cod_users_email_global_unique');
    expect(databaseSource).toMatch(/GROUP BY\s+lower\(email\)[\s\S]*HAVING\s+count\(\*\)\s*>\s*1/i);
    expect(databaseSource).toContain('pg_index');
    expect(databaseSource).toContain('indisvalid');
    expect(databaseSource).toContain('userEmailGlobalUniqueIndexMigration');
  });

  it('bounds registration challenge PII retention in Postgres and memory storage',()=>{
    const databaseSource=readFileSync(new URL('./database.ts',import.meta.url),'utf8');
    const memorySource=readFileSync(new URL('./memory-database.ts',import.meta.url),'utf8');
    const serverSource=readFileSync(new URL('./server.ts',import.meta.url),'utf8');
    expect(databaseSource).toContain("ON cod_registration_challenges (updated_at,id) WHERE status IN ('locked','superseded')");
    expect(databaseSource).toContain("ON cod_registration_challenges (replay_until,id) WHERE status='consumed'");
    expect(databaseSource).toContain('LIMIT $2 FOR UPDATE SKIP LOCKED');
    expect(databaseSource).toMatch(/DELETE FROM cod_registration_challenges[\s\S]*RETURNING c\.id/i);
    expect(databaseSource).toMatch(/status='consumed'[\s\S]*replay_until\s*<=?\s*\$1/i);
    expect(databaseSource).toContain('24*60*60*1000');
    expect(memorySource).toContain('cleanupRegistrationChallenges');
    expect(memorySource).toContain('24*60*60*1000');
    expect(serverSource).toContain('cleanupRegistrationChallenges(instant)');
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

  it('widens the existing compute request kind constraint without rewriting payloads', () => {
    const databaseSource=readFileSync(new URL('./database.ts',import.meta.url),'utf8');
    expect(computeRequestHostingMigration).toContain("position('hosting' in pg_get_constraintdef(oid))=0");
    expect(computeRequestHostingMigration).toContain("CHECK (kind IN ('rental','supply','installment','hosting')) NOT VALID");
    expect(computeRequestHostingMigration).toContain('VALIDATE CONSTRAINT cod_compute_requests_kind_check');
    expect(computeRequestHostingMigration).not.toContain('UPDATE cod_compute_requests');
    expect(adminComputeRequestIndexMigration).toContain('CREATE INDEX CONCURRENTLY IF NOT EXISTS');
    expect(adminComputeRequestIndexMigration).toContain('cod_compute_requests_admin_created_idx ON cod_compute_requests(created_at DESC, id DESC)');
    expect(databaseSource).not.toContain('CREATE INDEX IF NOT EXISTS cod_compute_requests_admin_created_idx');
  });

  it('adds execution fencing without exposing or storing reusable lease secrets',()=>{
    const databaseSource=readFileSync(new URL('./database.ts',import.meta.url),'utf8');
    expect(databaseSource).toContain('ALTER TABLE cod_tasks ADD COLUMN IF NOT EXISTS claim_id_hash text');
    expect(databaseSource).toContain('ALTER TABLE cod_tasks ADD COLUMN IF NOT EXISTS lease_token_hash text');
    expect(databaseSource).toContain('cod_tasks_active_lease_idx');
    expect(taskExecutionLeaseSchemaMigration).toContain("status IN ('running','waiting')");
    expect(taskExecutionLeaseSchemaMigration).toContain("cod:task-execution-lease-compatibility-v1");
    expect(taskExecutionLeaseSchemaMigration).toContain('ADD CONSTRAINT cod_tasks_execution_lease_check');
    expect(taskExecutionLeaseSchemaMigration).toContain('ALTER TABLE cod_tasks DROP CONSTRAINT cod_tasks_execution_lease_check');
    expect(taskExecutionLeaseSchemaMigration).toContain('cod_tasks_normalize_terminal_lease_trigger');
    expect(taskExecutionLeaseSchemaMigration).toContain("IF NEW.status NOT IN ('running','waiting')");
    expect(taskExecutionLeaseSchemaMigration).toContain('execution_id IS NULL AND claim_id_hash IS NULL AND lease_token_hash IS NULL AND lease_expires_at IS NULL');
    expect(taskExecutionLeaseSchemaMigration).toContain('execution_id IS NOT NULL AND claim_id_hash IS NOT NULL');
    expect(taskExecutionLeaseSchemaMigration).toContain("claim_id_hash ~ '^[a-f0-9]{64}$'");
    expect(taskExecutionLeaseSchemaMigration).toContain('lease_token_hash IS NOT NULL');
    expect(taskExecutionLeaseSchemaMigration).toContain("lease_token_hash ~ '^[a-f0-9]{64}$'");
    expect(taskExecutionLeaseSchemaMigration).toContain('NOT VALID');
    expect(databaseSource).not.toMatch(/SET\s+lease_token_hash=\$\d[^\n]*claim\.leaseToken/);
    expect(databaseSource).toContain("status NOT IN ('running','waiting') AND (execution_id IS NOT NULL");
    expect(databaseSource).toContain('ALTER TABLE cod_tasks VALIDATE CONSTRAINT cod_tasks_execution_lease_check');
  });

  it('trusts only the observed multi-AZ ALB subnets and isolates heartbeat bursts', () => {
    const httpConfig = readFileSync(new URL('../../../deploy/nginx-http.conf', import.meta.url), 'utf8');
    const siteConfig = readFileSync(new URL('../../../deploy/cod.nginx.conf', import.meta.url), 'utf8');

    for (const subnet of ['172.31.0.0/20', '172.31.16.0/20', '172.31.32.0/20']) {
      expect(httpConfig).toContain(`set_real_ip_from ${subnet};`);
      expect(httpConfig).toContain(`${subnet} 1;`);
    }
    expect(httpConfig).toContain('real_ip_header X-Forwarded-For;');
    expect(httpConfig).toContain('real_ip_recursive on;');
    expect(httpConfig).not.toMatch(/set_real_ip_from\s+(?:0\.0\.0\.0\/0|10\.0\.0\.0\/8|172\.16\.0\.0\/12|172\.31\.0\.0\/16)/);
    expect(httpConfig).toContain('geo $realip_remote_addr $cod_trusted_origin_peer');
    expect(httpConfig).not.toMatch(/geo\s+\$remote_addr\s+\$cod_trusted_origin_peer/);
    expect(siteConfig.match(/if \(\$cod_trusted_origin_peer = 0\)/g)).toHaveLength(3);
    expect(siteConfig).toContain('return 308 https://cod.kai.com$request_uri;');
    expect(siteConfig.match(/if \(\$cod_trusted_origin_peer = 0\) \{ return 404; \}/g)).toHaveLength(2);
    expect(httpConfig).toContain('limit_req_zone $binary_remote_addr zone=cod_heartbeat_ip:10m rate=50r/s');
    expect(httpConfig).toContain('limit_req_zone $binary_remote_addr$uri zone=cod_heartbeat_device:10m rate=2r/s');
    expect(siteConfig).toContain('limit_req zone=cod_heartbeat_ip burst=100 nodelay;');
    expect(siteConfig).toContain('limit_req zone=cod_heartbeat_device burst=5 nodelay;');
    const genericApiLocation = siteConfig.match(/location \/api\/ \{([\s\S]*?)\n    \}/)?.[1] ?? '';
    const adminApiLocation = siteConfig.match(/location \^~ \/api\/admin\/compute\/requests \{([\s\S]*?)\n    \}/)?.[1] ?? '';
    expect(genericApiLocation).toContain('limit_req zone=cod_api burst=40 nodelay;');
    expect(adminApiLocation).toContain('limit_req zone=cod_api burst=40 nodelay;');
    expect(siteConfig).toContain('error_page 429 = @cod_rate_limited;');
    expect(siteConfig).toContain('return 429 \'{"error":"rate_limited"');
    expect(siteConfig).toContain('add_header Retry-After 1 always;');
    expect(httpConfig).toContain('map $http_x_request_id $cod_request_id');
    expect(httpConfig).toContain('default $http_x_request_id;');
    expect(httpConfig).toContain('"" $request_id;');
    expect(siteConfig.match(/proxy_set_header X-Request-ID \$cod_request_id;/g)).toHaveLength(5);
    expect(siteConfig).not.toContain('proxy_set_header X-Request-ID $request_id;');
  });

  it('compresses large JSON catalogs and static text assets at the Nginx boundary', () => {
    const httpConfig = readFileSync(new URL('../../../deploy/nginx-http.conf', import.meta.url), 'utf8');
    const siteConfig = readFileSync(new URL('../../../deploy/cod.nginx.conf', import.meta.url), 'utf8');

    expect(httpConfig).not.toContain('gzip on;');
    expect(siteConfig).toContain('gzip on;');
    expect(siteConfig).toContain('gzip_vary on;');
    expect(siteConfig).toContain('gzip_min_length 1024;');
    expect(siteConfig).toContain('gzip_proxied any;');
    expect(siteConfig).toMatch(/gzip_types[\s\S]*?application\/json[\s\S]*?application\/javascript[\s\S]*?text\/javascript[\s\S]*?text\/css[\s\S]*?image\/svg\+xml;/);
    expect(siteConfig).toContain('proxy_hide_header X-Content-Type-Options;');
  });

  it('serves static shell resources with explicit cache, MIME, and security boundaries', () => {
    const siteConfig = readFileSync(new URL('../../../deploy/cod.nginx.conf', import.meta.url), 'utf8');

    expect(siteConfig).toContain('location = /health { return 404; }');
    expect(siteConfig).toContain('location = /ready { return 404; }');
    expect(siteConfig).toContain('location = /_cod/expo-dom-bootstrap { return 404; }');
    expect(siteConfig).toContain('location ^~ /health/ { return 404; }');
    expect(siteConfig).toContain('location ^~ /ready/ { return 404; }');
    expect(siteConfig).toContain('location ^~ /_cod/expo-dom-bootstrap/ { return 404; }');
    expect(siteConfig).toMatch(/location = \/manifest\.webmanifest \{[\s\S]*?types \{ application\/manifest\+json webmanifest; \}[\s\S]*?expires -1;[\s\S]*?\}/);
    expect(siteConfig).toMatch(/location = \/index\.html \{[\s\S]*?try_files \$uri =404;[\s\S]*?expires -1;[\s\S]*?\}/);
    const assetLocation = siteConfig.match(/location \/assets\/ \{([\s\S]*?)\n    \}/)?.[1] ?? '';
    const rateLimitLocation = siteConfig.match(/location @cod_rate_limited \{([\s\S]*?)\n    \}/)?.[1] ?? '';
    for (const location of [assetLocation, rateLimitLocation]) {
      expect(location).toContain('add_header X-Content-Type-Options nosniff always;');
      expect(location).toContain('add_header Strict-Transport-Security');
      expect(location).toContain('add_header Referrer-Policy');
      expect(location).toContain('add_header X-Frame-Options');
      expect(location).toContain('add_header Permissions-Policy');
      expect(location).toContain('add_header Content-Security-Policy');
    }
    expect(assetLocation).toContain('add_header Cache-Control "public, immutable";');
    expect(rateLimitLocation).toContain('add_header Retry-After 1 always;');
    const defaultServer = siteConfig.slice(0, siteConfig.indexOf('\nserver {', 1));
    expect(defaultServer).toContain('proxy_hide_header X-Content-Type-Options;');
    expect(defaultServer).toContain('add_header X-Content-Type-Options nosniff always;');
  });

  it('runs the control plane without Linux capabilities or namespace creation', () => {
    const service = readFileSync(new URL('../../../deploy/cod-control-plane.service', import.meta.url), 'utf8');

    expect(service).toMatch(/^User=cod$/m);
    expect(service).toMatch(/^Group=cod$/m);
    expect(service).toMatch(/^ExecStart=\/opt\/cod\/current\/bin\/node \/opt\/cod\/current\/start\.mjs$/m);
    expect(service).toMatch(/^NoNewPrivileges=true$/m);
    expect(service).toMatch(/^CapabilityBoundingSet=$/m);
    expect(service).toMatch(/^AmbientCapabilities=$/m);
    expect(service).toMatch(/^PrivateIPC=true$/m);
    expect(service).toMatch(/^ProtectClock=true$/m);
    expect(service).toMatch(/^ProtectHostname=true$/m);
    expect(service).toMatch(/^ProtectKernelLogs=true$/m);
    expect(service).toMatch(/^ProtectProc=invisible$/m);
    expect(service).toMatch(/^RestrictNamespaces=true$/m);
    expect(service).toMatch(/^ProtectHome=true$/m);

    const deployScript = readFileSync(new URL('../../../scripts/deploy-server.sh', import.meta.url), 'utf8');
    expect(deployScript).toContain("node_binary=\"$(node -p 'process.execPath')\"");
    expect(deployScript).not.toContain('node_binary="$(command -v node)"');
    expect(deployScript).toContain('env -i HOME=/nonexistent PATH=/usr/bin:/bin "${node_binary}"');
    expect(deployScript).toContain('sudo -u cod -- env -i HOME=/nonexistent PATH=/usr/bin:/bin "${release}/bin/node"');
    expect(deployScript).toContain('sudo -u cod -- env -i HOME=/nonexistent PATH=/usr/bin:/bin "${release_staging}/bin/node"');
    expect(deployScript).toContain('Resolved Node runtime is not self-contained');
    expect(deployScript).toContain('Staged Node runtime is not self-contained');
    expect(deployScript).toContain('sudo install -o root -g root -m 755 "${node_binary}" "${release_staging}/bin/node"');
    expect(deployScript).toContain('sudo useradd --system --gid cod --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin cod');
    expect(deployScript).toContain('sudo chown -R root:root "${release_staging}"');
    expect(deployScript).toContain('sudo chmod -R go-w "${release_staging}"');
    expect(deployScript).toContain('! -user root -o ! -group root -o -perm /022');
    expect(deployScript.indexOf('sudo useradd --system')).toBeLessThan(deployScript.indexOf('sudo -u cod -- env -i'));
    expect(deployScript.indexOf('sudo -u cod -- env -i')).toBeLessThan(deployScript.indexOf('release=%s (already active)'));
  });

  it('keeps production registration closed until email ownership is verified', () => {
    const runtime = readFileSync(new URL('../../../deploy/runtime.env', import.meta.url), 'utf8');
    const example = readFileSync(new URL('../../../deploy/control-plane.env.example', import.meta.url), 'utf8');
    const service = readFileSync(new URL('../../../deploy/cod-control-plane.service', import.meta.url), 'utf8');

    expect(runtime).toMatch(/^COD_REGISTRATION_ENABLED=false$/m);
    expect(runtime).toMatch(/^NODE_ENV=production$/m);
    expect(example).not.toMatch(/^COD_REGISTRATION_ENABLED=/m);
    expect(example).toContain('secret-file drift cannot reopen features');
    expect(service.indexOf('EnvironmentFile=-/etc/cod/control-plane.env')).toBeLessThan(service.indexOf('EnvironmentFile=/etc/cod/runtime.env'));
    const deployScript = readFileSync(new URL('../../../scripts/deploy-server.sh', import.meta.url), 'utf8');
    expect(deployScript).toContain("sudo grep -zqx 'NODE_ENV=production' \"/proc/${main_pid}/environ\"");
    expect(deployScript.indexOf('if [[ "${ready}" != true ]]')).toBeLessThan(deployScript.indexOf("sudo grep -zqx 'NODE_ENV=production'"));
  });
});
