import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { TaskStatus, UsageEvent } from '@cod/contracts';
import { createSessionToken, verifySessionToken } from './auth.js';
import { BotService, parseBotCommand, verifyWebhookSignature, type BotPlatform } from './bots.js';
import { loadConfig, type ControlPlaneConfig } from './config.js';
import { type CodDatabase, type Principal, PostgresDatabase, type TopupRequest } from './database.js';
import { errorResponse, HttpError } from './errors.js';
import { AiGateway } from './gateway.js';
import { bearerToken, readJson, readText, sendJson } from './http.js';
import { KnowledgeAdapter } from './knowledge.js';
import { MemoryDatabase } from './memory-database.js';
import { ProductRegistry } from './products.js';
import { beginRequest, recordRequest, renderMetrics } from './metrics.js';

export interface ControlPlaneOptions {
  config?: ControlPlaneConfig;
  database?: CodDatabase;
}

const validStatuses = new Set<TaskStatus>(['draft', 'running', 'waiting', 'complete', 'failed']);
const userIdFor = (email: string) => `usr_${createHash('sha256').update(email).digest('hex').slice(0, 20)}`;
const tenantIdFor = (email: string) => `tenant_${email.split('@')[1]?.replace(/[^a-z0-9]+/g, '_') ?? 'unknown'}`;
const principalFromSession = (session: NonNullable<ReturnType<typeof verifySessionToken>>): Principal => ({ userId: session.sub, tenantId: session.tenantId, email: session.email, role: session.role });

function validateLoginEmail(raw: string | undefined, config: ControlPlaneConfig): string {
  const email = (raw ?? '').trim().toLowerCase();
  if (!config.developmentLoginEnabled) throw new HttpError('Development login is disabled', 503, 'login_unavailable');
  if (!/^\S+@\S+\.\S+$/.test(email)) throw new HttpError('Valid email is required', 400, 'invalid_email');
  if (email !== config.developmentLoginEmail) throw new HttpError('Development login account is not allowed', 403, 'login_forbidden');
  const domain = email.split('@')[1] ?? '';
  if (!config.allowedEmailDomains.includes(domain)) throw new HttpError('Email domain is not allowed', 403, 'domain_forbidden');
  return email;
}

function usageFromResponse(body: unknown): { inputTokens: number; outputTokens: number } | null {
  if (!body || typeof body !== 'object') return null;
  const usage = (body as { usage?: Record<string, unknown> }).usage;
  if (!usage) return null;
  const inputTokens = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0);
  const outputTokens = Number(usage.completion_tokens ?? usage.output_tokens ?? 0);
  return Number.isInteger(inputTokens) && Number.isInteger(outputTokens) && inputTokens >= 0 && outputTokens >= 0 ? { inputTokens, outputTokens } : null;
}

function estimatedInputTokens(body: unknown): number {
  return Buffer.byteLength(JSON.stringify(body), 'utf8');
}

export function createControlPlane(options: ControlPlaneOptions = {}) {
  const config = options.config ?? loadConfig();
  const database = options.database ?? (config.databaseUrl ? new PostgresDatabase(config.databaseUrl) : new MemoryDatabase());
  const gateway = new AiGateway(config);
  const knowledge = new KnowledgeAdapter(config);
  const products = new ProductRegistry(config);

  return createServer(async (request, response) => {
    const requestId = /^[a-zA-Z0-9._-]{1,100}$/.test(String(request.headers['x-request-id'] ?? '')) ? String(request.headers['x-request-id']) : randomUUID();
    const started = process.hrtime.bigint();
    const finishInflight = beginRequest();
    response.setHeader('x-request-id', requestId);
    response.once('finish', () => {
      finishInflight();
      const durationSeconds = Number(process.hrtime.bigint() - started) / 1_000_000_000;
      recordRequest(request.method ?? 'UNKNOWN', new URL(request.url ?? '/', 'http://localhost').pathname, response.statusCode, durationSeconds);
      console.log(JSON.stringify({ level: 'info', event: 'http.request', requestId, method: request.method, path: new URL(request.url ?? '/', 'http://localhost').pathname, status: response.statusCode, durationMs: Math.round(durationSeconds * 1000) }));
    });
    if (request.method === 'OPTIONS') return sendJson(response, 204, null);
    const url = new URL(request.url ?? '/', 'http://localhost');
    try {
      if (request.method === 'GET' && url.pathname === '/health') return sendJson(response, 200, { status: 'ok', service: 'cod-control-plane' });
      if (request.method === 'GET' && url.pathname === '/ready') { const ready=await database.health(); return sendJson(response, ready ? 200 : 503, { status: ready ? 'ready' : 'not_ready', database: config.databaseUrl ? 'postgres' : 'memory' }); }
      if (request.method === 'GET' && url.pathname === '/metrics') { const ready=await database.health(); response.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' }); response.end(renderMetrics(ready)); return; }
      if (request.method === 'GET' && url.pathname === '/version') return sendJson(response, 200, { revision: process.env.COD_REVISION ?? 'development', node: process.version });
      if (request.method === 'POST' && url.pathname === '/api/auth/login') {
        const body = await readJson<{ email?: string }>(request);
        const email = validateLoginEmail(body.email, config);
        const principal: Principal = { userId: userIdFor(email), tenantId: tenantIdFor(email), email, role: 'member' };
        await database.ensurePrincipal(principal);
        await database.audit(principal, 'auth.login', 'session', null);
        const token = createSessionToken({ sub: principal.userId, tenantId: principal.tenantId, email, role: principal.role }, config.sessionSecret);
        return sendJson(response, 200, { token, user: { id: principal.userId, email } });
      }
      if (request.method === 'POST' && url.pathname.match(/^\/api\/webhooks\/(feishu|wecom)$/)) {
        const rawBody = await readText(request);
        const raw = JSON.parse(rawBody || '{}') as { text?: string; userId?: string; tenantId?: string; email?: string };
        const platform = url.pathname.split('/')[3] as BotPlatform;
        const timestamp = String(request.headers['x-cod-timestamp'] ?? '');
        const signature = String(request.headers['x-cod-signature'] ?? '');
        const secret = process.env.COD_BOT_WEBHOOK_SECRET;
        if (!secret || !verifyWebhookSignature(rawBody, timestamp, signature, secret)) return sendJson(response, 401, { error: 'invalid_signature' });
        if (!raw.userId || !raw.tenantId || !raw.email) throw new HttpError('Bot identity binding is required', 400, 'bot_identity_required');
        const principal: Principal = { userId: raw.userId, tenantId: raw.tenantId, email: raw.email, role: 'member' };
        return sendJson(response, 200, await new BotService(database, principal).execute(platform, parseBotCommand(raw.text ?? '')));
      }
      const session = verifySessionToken(bearerToken(request) ?? '', config.sessionSecret);
      if (!session) return sendJson(response, 401, { error: 'unauthorized' });
      const principal = principalFromSession(session);
      if (request.method === 'GET' && url.pathname === '/api/account') return sendJson(response, 200, await database.getAccount(principal));
      if (request.method === 'GET' && url.pathname === '/api/ledger') return sendJson(response, 200, await database.getLedger(principal));
      if (request.method === 'GET' && url.pathname === '/api/audit') return sendJson(response, 200, await database.listAudit(principal, Number(url.searchParams.get('limit') ?? 50)));
      if (request.method === 'GET' && url.pathname === '/api/models') return sendJson(response, 200, gateway.listModels());
      if (request.method === 'GET' && url.pathname === '/api/products') return sendJson(response, 200, products.list());
      if (request.method === 'GET' && url.pathname === '/api/knowledge/search') return sendJson(response, 200, await knowledge.search(url.searchParams.get('q') ?? ''));
      if (request.method === 'GET' && url.pathname === '/api/devices') return sendJson(response, 200, await database.listDevices(principal));
      if (request.method === 'POST' && url.pathname === '/api/devices') { const device=await database.registerDevice(principal,await readJson(request)); await database.audit(principal,'device.register','device',device.id); return sendJson(response,201,device); }
      if (request.method === 'POST' && url.pathname.match(/^\/api\/devices\/[^/]+\/heartbeat$/)) return sendJson(response, 200, await database.heartbeat(principal, url.pathname.split('/')[3]));
      if (request.method === 'GET' && url.pathname === '/api/tasks') return sendJson(response, 200, await database.listTasks(principal));
      if (request.method === 'POST' && url.pathname === '/api/tasks') { const task=await database.createTask(principal,await readJson(request)); await database.audit(principal,'task.create','task',task.id); return sendJson(response,201,task); }
      if (request.method === 'POST' && url.pathname.match(/^\/api\/tasks\/[^/]+\/status$/)) { const body=await readJson<{status:TaskStatus;expectedVersion:number}>(request); if(!validStatuses.has(body.status)) throw new HttpError('Invalid task status',400,'invalid_status'); const task=await database.updateTask(principal,url.pathname.split('/')[3],body.status,body.expectedVersion); await database.audit(principal,'task.status','task',task.id,{status:body.status}); return sendJson(response,200,task); }
      if (request.method === 'GET' && url.pathname === '/api/events') return sendJson(response, 200, await database.eventsAfter(principal, Number(url.searchParams.get('cursor') ?? 0)));
      if (request.method === 'POST' && url.pathname === '/api/topups') {
        if (!config.developmentTopupEnabled) throw new HttpError('Direct top-up is disabled; use a verified payment callback', 403, 'topup_disabled');
        const body = await readJson<Omit<TopupRequest, 'idempotencyKey'>>(request); const key=String(request.headers['idempotency-key']??''); if(!key)throw new HttpError('idempotency-key is required',400,'idempotency_required');
        const entry=await database.topup(principal,{...body,idempotencyKey:key}); await database.audit(principal,'wallet.topup','ledger',entry.id,{amountCents:body.amountCents}); return sendJson(response,201,{entry,account:await database.getAccount(principal)});
      }
      if (request.method === 'POST' && url.pathname === '/api/usage') {
        if (principal.role !== 'admin') throw new HttpError('Usage ingestion requires a trusted service identity', 403, 'usage_forbidden');
        const event=await readJson<UsageEvent>(request); const entry=await database.recordUsage(principal,event); return sendJson(response,201,{entry,account:await database.getAccount(principal)});
      }
      if (request.method === 'POST' && url.pathname === '/v1/chat/completions') {
        const body = await readJson<{ model?: string } & Record<string, unknown>>(request);
        if(body.stream===true)throw new HttpError('Streaming through the billed gateway is not enabled yet',400,'streaming_not_supported');
        const model=body.model??'coder-pro'; if(!gateway.listModels().some((item)=>item.id===model))throw new HttpError('Unknown model',400,'unknown_model');
        const maxOutput=Number(body.max_completion_tokens??body.max_tokens??4096);if(!Number.isInteger(maxOutput)||maxOutput<1||maxOutput>65536)throw new HttpError('Invalid max output tokens',400,'invalid_max_tokens');
        const reservationId=randomUUID();const reservedCost=gateway.costCents(model,estimatedInputTokens(body),maxOutput);await database.reserveUsage(principal,reservationId,reservedCost);
        try {
          const upstream=await gateway.proxyChat(body);const raw=Buffer.from(await upstream.arrayBuffer());
          if(!upstream.ok){await database.releaseUsage(principal,reservationId);response.writeHead(upstream.status,{'content-type':upstream.headers.get('content-type')??'application/json'});response.end(raw);return;}
          const parsed=JSON.parse(raw.toString('utf8')) as unknown;const usage=usageFromResponse(parsed);if(!usage){await database.releaseUsage(principal,reservationId);throw new HttpError('Upstream response did not include billable usage',502,'usage_missing');}
          const costCents=gateway.costCents(model,usage.inputTokens,usage.outputTokens);await database.settleUsage(principal,reservationId,{idempotencyKey:`chat:${(parsed as {id?:string}).id??createHash('sha256').update(raw).digest('hex')}`,taskId:'chat',model,inputTokens:usage.inputTokens,outputTokens:usage.outputTokens,costCents});await database.audit(principal,'chat.complete','model',model,{...usage,costCents});
          response.writeHead(upstream.status,{'content-type':upstream.headers.get('content-type')??'application/json'});response.end(raw);return;
        } catch(error) { await database.releaseUsage(principal,reservationId); throw error; }
      }
      return sendJson(response, 404, { error: 'not_found' });
    } catch (error) {
      console.error(JSON.stringify({ level: 'error', event: 'http.error', requestId, method: request.method, path: url.pathname, error: error instanceof Error ? error.message : String(error) }));
      const result=errorResponse(error); return sendJson(response,result.status,result.body);
    }
  });
}

if (process.env.NODE_ENV !== 'test') {
  const config=loadConfig(); const database=config.databaseUrl?new PostgresDatabase(config.databaseUrl):new MemoryDatabase();
  if (process.env.NODE_ENV === 'production' && !config.databaseUrl) throw new Error('DATABASE_URL is required in production');
  await database.initialize();
  const server=createControlPlane({config,database});
  server.listen(config.port,'127.0.0.1',()=>console.log(JSON.stringify({level:'info',event:'service.started',port:config.port,revision:process.env.COD_REVISION??'development'})));
  const shutdown=async(signal:string)=>{console.log(JSON.stringify({level:'info',event:'service.stopping',signal}));server.close(async()=>{await database.close();process.exit(0);});setTimeout(()=>process.exit(1),10_000).unref();};
  process.once('SIGTERM',()=>void shutdown('SIGTERM'));process.once('SIGINT',()=>void shutdown('SIGINT'));
}
