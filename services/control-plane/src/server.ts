import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { TaskStatus, UsageEvent } from '@cod/contracts';
import { createSessionToken, verifySessionToken } from './auth.js';
import { BotService, parseBotCommand, parseFeishuWebhook, replyFeishuMessage, verifyWebhookSignature, type BotPlatform } from './bots.js';
import { loadConfig, type ControlPlaneConfig } from './config.js';
import { creditPackCatalog, type CodDatabase, type Principal, PostgresDatabase, type TopupRequest } from './database.js';
import { errorResponse, HttpError } from './errors.js';
import { AiGateway } from './gateway.js';
import { bearerToken, readJson, readText, sendJson } from './http.js';
import { KnowledgeAdapter } from './knowledge.js';
import { MemoryDatabase } from './memory-database.js';
import { ProductRegistry } from './products.js';
import { beginRequest, recordRequest, renderMetrics } from './metrics.js';
import { computeOfferCatalog, validateComputeRequest } from './compute-market.js';

export interface ControlPlaneOptions {
  config?: ControlPlaneConfig;
  database?: CodDatabase;
}

const validStatuses = new Set<TaskStatus>(['draft', 'running', 'waiting', 'complete', 'failed']);
const userIdFor = (email: string) => `usr_${createHash('sha256').update(email).digest('hex').slice(0, 20)}`;
const tenantIdFor = (email: string) => `tenant_${email.split('@')[1]?.replace(/[^a-z0-9]+/g, '_') ?? 'unknown'}`;
const principalFromSession = (session: NonNullable<ReturnType<typeof verifySessionToken>>): Principal => ({ userId: session.sub, tenantId: session.tenantId, email: session.email, role: session.role });

function validateLoginEmail(raw: string | undefined, accessCode: string | undefined, config: ControlPlaneConfig): string {
  const email = (raw ?? '').trim().toLowerCase();
  if (!config.developmentLoginEnabled) throw new HttpError('Development login is disabled', 503, 'login_unavailable');
  if (!/^\S+@\S+\.\S+$/.test(email)) throw new HttpError('Valid email is required', 400, 'invalid_email');
  if (email !== config.developmentLoginEmail) throw new HttpError('Development login account is not allowed', 403, 'login_forbidden');
  const domain = email.split('@')[1] ?? '';
  if (!config.allowedEmailDomains.includes(domain)) throw new HttpError('Email domain is not allowed', 403, 'domain_forbidden');
  if (config.pilotAccessCodeHash) {
    const expected = Buffer.from(config.pilotAccessCodeHash, 'hex');
    const actual = createHash('sha256').update(accessCode ?? '').digest();
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new HttpError('Email or access code is incorrect', 403, 'login_forbidden');
  }
  return email;
}

export function usageFromResponse(body: unknown, requestBody: unknown, content: string): { inputTokens: number; outputTokens: number; estimated: boolean } {
  if (!body || typeof body !== 'object') return { inputTokens: estimatedInputTokens(requestBody), outputTokens: estimatedTextTokens(content), estimated: true };
  const usage = (body as { usage?: Record<string, unknown> }).usage;
  if (!usage) return { inputTokens: estimatedInputTokens(requestBody), outputTokens: estimatedTextTokens(content), estimated: true };
  const inputTokens = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0);
  const outputTokens = Number(usage.completion_tokens ?? usage.output_tokens ?? 0);
  return Number.isInteger(inputTokens) && Number.isInteger(outputTokens) && inputTokens >= 0 && outputTokens >= 0 && inputTokens + outputTokens > 0
    ? { inputTokens, outputTokens, estimated: false }
    : { inputTokens: estimatedInputTokens(requestBody), outputTokens: estimatedTextTokens(content), estimated: true };
}

export function assistantContentFromResponse(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const choices = (body as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || !choices[0] || typeof choices[0] !== 'object') return null;
  const message = (choices[0] as { message?: unknown }).message;
  if (message && typeof message === 'object') {
    const content = (message as { content?: unknown }).content;
    if (typeof content === 'string' && content.trim()) return content.trim();
    if (Array.isArray(content)) {
      const text = content.flatMap((part) => part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string' ? [String((part as { text: string }).text).trim()] : []).filter(Boolean).join('\n');
      if (text) return text;
    }
  }
  const text = (choices[0] as { text?: unknown }).text;
  return typeof text === 'string' && text.trim() ? text.trim() : null;
}

function estimatedInputTokens(body: unknown): number {
  const messages = body && typeof body === 'object' && Array.isArray((body as { messages?: unknown }).messages) ? (body as { messages: unknown[] }).messages : body;
  return Math.max(1, Math.ceil(Buffer.byteLength(JSON.stringify(messages), 'utf8') / 4));
}

const estimatedTextTokens = (text: string): number => Math.max(1, Math.ceil(Buffer.byteLength(text, 'utf8') / 4));

async function readResponseBuffer(response: Response, maximumBytes = 5 * 1024 * 1024): Promise<Buffer> {
  const advertisedLength = Number(response.headers.get('content-length') ?? 0);
  if (Number.isFinite(advertisedLength) && advertisedLength > maximumBytes) throw new HttpError('Model response is too large', 502, 'model_response_too_large');
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximumBytes) {
      await reader.cancel();
      throw new HttpError('Model response is too large', 502, 'model_response_too_large');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, size);
}

function queryInteger(raw: string | null, fallback: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) throw new HttpError('Query parameter is invalid', 400, 'invalid_query');
  return value;
}

export function createControlPlane(options: ControlPlaneOptions = {}) {
  const config = options.config ?? loadConfig();
  const database = options.database ?? (config.databaseUrl ? new PostgresDatabase(config.databaseUrl) : new MemoryDatabase());
  const gateway = new AiGateway(config);
  const knowledge = new KnowledgeAdapter(config);
  const products = new ProductRegistry(config);
  const seenFeishuMessages = new Set<string>();

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
    const url = new URL(request.url ?? '/', 'http://localhost');
    try {
      const origin = request.headers.origin;
      if (origin && !config.allowedOrigins.includes(origin)) throw new HttpError('Request origin is not allowed', 403, 'origin_forbidden');
      if (origin) {
        response.setHeader('access-control-allow-origin', origin);
        response.setHeader('vary', 'Origin');
      }
      response.setHeader('access-control-allow-headers', 'authorization,content-type,idempotency-key,x-request-id');
      response.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
      if (request.method === 'OPTIONS') return sendJson(response, 204, null);
      if (request.method === 'GET' && url.pathname === '/health') return sendJson(response, 200, { status: 'ok', service: 'cod-control-plane' });
      if (request.method === 'GET' && url.pathname === '/ready') { const ready=await database.health(); return sendJson(response, ready ? 200 : 503, { status: ready ? 'ready' : 'not_ready', database: config.databaseUrl ? 'postgres' : 'memory' }); }
      if (request.method === 'GET' && url.pathname === '/metrics') { const ready=await database.health(); response.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' }); response.end(renderMetrics(ready)); return; }
      if (request.method === 'GET' && url.pathname === '/version') return sendJson(response, 200, { revision: process.env.COD_REVISION ?? 'development', node: process.version });
      if (request.method === 'GET' && url.pathname === '/api/capabilities') return sendJson(response, 200, {
        authentication: { mode: 'pilot', accessCodeRequired: Boolean(config.pilotAccessCodeHash) },
        ai: { mode: await gateway.mode(), streaming: false },
        knowledge: { mode: knowledge.mode() },
        payments: { topupEnabled: config.developmentTopupEnabled, orderApi: true, mode: config.paymentWebhookSecret ? 'verified-webhook' : config.developmentTopupEnabled ? 'pilot-credit' : 'unavailable' },
        synchronization: { transport: 'polling', taskStatusVersioning: true },
        remote: {
          feishu: config.feishuVerificationToken && config.feishuAppId && config.feishuAppSecret && Object.keys(config.feishuBindings).length ? 'live' : 'unavailable',
          wecom: process.env.COD_BOT_WEBHOOK_SECRET ? 'adapter' : 'unavailable',
        },
      });
      if (request.method === 'GET' && url.pathname === '/api/model-catalog') return sendJson(response, 200, await gateway.listSources());
      if (request.method === 'GET' && url.pathname === '/api/compute/offers') return sendJson(response, 200, computeOfferCatalog);
      if (request.method === 'POST' && url.pathname === '/api/auth/login') {
        const body = await readJson<{ email?: string; accessCode?: string }>(request);
        const email = validateLoginEmail(body.email, body.accessCode, config);
        const principal: Principal = { userId: userIdFor(email), tenantId: tenantIdFor(email), email, role: 'member' };
        await database.ensurePrincipal(principal);
        await database.audit(principal, 'auth.login', 'session', null);
        const token = createSessionToken({ sub: principal.userId, tenantId: principal.tenantId, email, role: principal.role }, config.sessionSecret);
        return sendJson(response, 200, { token, user: { id: principal.userId, email } });
      }
      if (request.method === 'POST' && url.pathname === '/api/webhooks/feishu') {
        if (!config.feishuVerificationToken) throw new HttpError('Feishu integration is not configured', 503, 'feishu_unavailable');
        const rawBody = await readText(request);
        let event;
        try {
          event = parseFeishuWebhook(rawBody, {
            timestamp: String(request.headers['x-lark-request-timestamp'] ?? ''),
            nonce: String(request.headers['x-lark-request-nonce'] ?? ''),
            signature: String(request.headers['x-lark-signature'] ?? ''),
          }, { verificationToken: config.feishuVerificationToken, encryptKey: config.feishuEncryptKey, bindings: config.feishuBindings });
        } catch (error) {
          throw new HttpError(error instanceof Error ? error.message : 'Invalid Feishu event', 401, 'invalid_feishu_event');
        }
        if (event.kind === 'challenge') return sendJson(response, 200, { challenge: event.challenge });
        if (!event.email || !event.messageId) throw new HttpError('Feishu event is incomplete', 400, 'invalid_feishu_event');
        if (seenFeishuMessages.has(event.messageId)) return sendJson(response, 200, { ok: true, duplicate: true });
        if (seenFeishuMessages.size >= 10_000) seenFeishuMessages.clear();
        seenFeishuMessages.add(event.messageId);
        const domain = event.email.split('@')[1] ?? '';
        if (!config.allowedEmailDomains.includes(domain)) throw new HttpError('Feishu account is not allowed', 403, 'feishu_account_forbidden');
        const principal: Principal = { userId: userIdFor(event.email), tenantId: tenantIdFor(event.email), email: event.email, role: 'member' };
        await database.ensurePrincipal(principal);
        const result = await new BotService(database, principal).execute('feishu', parseBotCommand(event.text ?? ''));
        await database.audit(principal, 'feishu.message.received', 'message', event.messageId, { eventId: event.eventId });
        if (config.feishuAppId && config.feishuAppSecret) void replyFeishuMessage(event.messageId, result.text, config.feishuAppId, config.feishuAppSecret).catch((error) => console.error(JSON.stringify({ level: 'error', event: 'feishu.reply.failed', messageId: event.messageId, error: error instanceof Error ? error.message : String(error) })));
        return sendJson(response, 200, { ok: true });
      }
      if (request.method === 'POST' && url.pathname === '/api/webhooks/wecom') {
        const rawBody = await readText(request);
        let raw: { text?: string; userId?: string; tenantId?: string; email?: string };
        try { raw = JSON.parse(rawBody || '{}') as typeof raw; }
        catch { throw new HttpError('Request body must be valid JSON', 400, 'invalid_json'); }
        const platform: BotPlatform = 'wecom';
        const timestamp = String(request.headers['x-cod-timestamp'] ?? '');
        const signature = String(request.headers['x-cod-signature'] ?? '');
        const secret = process.env.COD_BOT_WEBHOOK_SECRET;
        if (!secret || !verifyWebhookSignature(rawBody, timestamp, signature, secret)) return sendJson(response, 401, { error: 'invalid_signature' });
        if (!raw.userId || !raw.tenantId || !raw.email) throw new HttpError('Bot identity binding is required', 400, 'bot_identity_required');
        const principal: Principal = { userId: raw.userId, tenantId: raw.tenantId, email: raw.email, role: 'member' };
        return sendJson(response, 200, await new BotService(database, principal).execute(platform, parseBotCommand(raw.text ?? '')));
      }
      if (request.method === 'POST' && url.pathname === '/api/webhooks/payments') {
        const rawBody = await readText(request);
        const timestamp = String(request.headers['x-cod-timestamp'] ?? '');
        const signature = String(request.headers['x-cod-signature'] ?? '');
        if (!config.paymentWebhookSecret || !verifyWebhookSignature(rawBody, timestamp, signature, config.paymentWebhookSecret)) return sendJson(response, 401, { error: 'invalid_signature' });
        let event: { eventId?: string; orderId?: string; status?: string; amountCents?: number; currency?: string; channel?: string; providerPaymentId?: string };
        try { event = JSON.parse(rawBody || '{}') as typeof event; }
        catch { throw new HttpError('Request body must be valid JSON', 400, 'invalid_json'); }
        if (event.status !== 'paid') return sendJson(response, 202, { accepted: true, credited: false });
        const channel = event.channel === 'wechat' || event.channel === 'alipay' ? event.channel : null;
        if (!channel || event.currency !== 'CNY' || !event.eventId || !event.orderId || !event.providerPaymentId || !Number.isInteger(event.amountCents)) throw new HttpError('Payment event is invalid', 400, 'invalid_payment_event');
        const completed = await database.completePaymentOrder({ orderId: event.orderId, amountCents: Number(event.amountCents), currency: 'CNY', channel, providerPaymentId: event.providerPaymentId, providerEventId: event.eventId });
        return sendJson(response, 200, { accepted: true, credited: true, order: completed.order, ledgerId: completed.entry.id });
      }
      const session = verifySessionToken(bearerToken(request) ?? '', config.sessionSecret);
      if (!session) return sendJson(response, 401, { error: 'unauthorized' });
      const principal = principalFromSession(session);
      if (request.method === 'GET' && url.pathname === '/api/account') return sendJson(response, 200, await database.getAccount(principal));
      if (request.method === 'GET' && url.pathname === '/api/ledger') return sendJson(response, 200, await database.getLedger(principal));
      if (request.method === 'GET' && url.pathname === '/api/compute/requests') return sendJson(response,200,await database.listComputeRequests(principal));
      if (request.method === 'POST' && url.pathname === '/api/compute/requests') {
        const key=String(request.headers['idempotency-key']??'');if(!key)throw new HttpError('idempotency-key is required',400,'idempotency_required');
        const input=validateComputeRequest(await readJson(request));const result=await database.createComputeRequest(principal,input,key);
        await database.audit(principal,'compute.request.created','compute_request',result.id,{kind:result.kind,offerId:result.offerId,gpuModel:result.gpuModel,quantity:result.quantity});
        return sendJson(response,201,result);
      }
      if (request.method === 'GET' && url.pathname === '/api/credit-packs') return sendJson(response,200,{packs:creditPackCatalog,summary:await database.getCreditSummary(principal)});
      if (request.method === 'POST' && url.pathname.match(/^\/api\/credit-packs\/[^/]+\/purchase$/)) {
        const key=String(request.headers['idempotency-key']??'');if(!key)throw new HttpError('idempotency-key is required',400,'idempotency_required');
        const packId=decodeURIComponent(url.pathname.split('/')[3]);const result=await database.purchaseCreditPack(principal,packId,key);
        await database.audit(principal,'credit_pack.purchase','credit_grant',result.grant.id,{packId,creditCents:result.grant.originalCents,expiresAt:result.grant.expiresAt});
        return sendJson(response,201,result);
      }
      if (request.method === 'POST' && url.pathname === '/api/payment-orders') {
        const key=String(request.headers['idempotency-key']??'');if(!key)throw new HttpError('idempotency-key is required',400,'idempotency_required');
        const body=await readJson<{amountCents?:number;channel?:'wechat'|'alipay'}>(request);
        const order=await database.createPaymentOrder(principal,{amountCents:Number(body.amountCents),channel:body.channel as 'wechat'|'alipay',idempotencyKey:key});
        await database.audit(principal,'payment.order.created','payment_order',order.id,{amountCents:order.amountCents,channel:order.channel});
        return sendJson(response,201,order);
      }
      if (request.method === 'GET' && url.pathname.match(/^\/api\/payment-orders\/[^/]+$/)) return sendJson(response,200,await database.getPaymentOrder(principal,url.pathname.split('/')[3]));
      if (request.method === 'GET' && url.pathname === '/api/audit') return sendJson(response, 200, await database.listAudit(principal, queryInteger(url.searchParams.get('limit'), 50, 200)));
      if (request.method === 'GET' && url.pathname === '/api/model-sources') return sendJson(response, 200, await gateway.listSources());
      if (request.method === 'GET' && url.pathname === '/api/models') return sendJson(response, 200, (await gateway.listSources()).flatMap((source) => source.models.map((model) => ({ ...model, sourceId: source.id }))));
      if (request.method === 'GET' && url.pathname === '/api/products') return sendJson(response, 200, products.list());
      if (request.method === 'POST' && url.pathname.match(/^\/api\/products\/[^/]+\/launch$/)) {
        const productId = decodeURIComponent(url.pathname.split('/')[3]);
        const launch = products.launch(productId, principal);
        await database.audit(principal, 'product.launch', 'product', productId, { mode: launch.mode });
        return sendJson(response, 200, launch);
      }
      if (request.method === 'GET' && url.pathname === '/api/knowledge/search') return sendJson(response, 200, await knowledge.search(url.searchParams.get('q') ?? '', principal));
      if (request.method === 'GET' && url.pathname === '/api/devices') return sendJson(response, 200, await database.listDevices(principal));
      if (request.method === 'POST' && url.pathname === '/api/devices') { const device=await database.registerDevice(principal,await readJson(request)); await database.audit(principal,'device.register','device',device.id); return sendJson(response,201,device); }
      if (request.method === 'POST' && url.pathname.match(/^\/api\/devices\/[^/]+\/heartbeat$/)) return sendJson(response, 200, await database.heartbeat(principal, url.pathname.split('/')[3]));
      if (request.method === 'GET' && url.pathname === '/api/tasks') return sendJson(response, 200, await database.listTasks(principal));
      if (request.method === 'POST' && url.pathname === '/api/tasks') { const task=await database.createTask(principal,await readJson(request)); await database.audit(principal,'task.create','task',task.id); return sendJson(response,201,task); }
      if (request.method === 'POST' && url.pathname.match(/^\/api\/tasks\/[^/]+\/status$/)) { const body=await readJson<{status:TaskStatus;expectedVersion:number;result?:string|null;error?:string|null}>(request); if(!validStatuses.has(body.status)) throw new HttpError('Invalid task status',400,'invalid_status'); const task=await database.updateTask(principal,url.pathname.split('/')[3],body.status,body.expectedVersion,{result:body.result,error:body.error}); await database.audit(principal,'task.status','task',task.id,{status:body.status,hasResult:Boolean(body.result),hasError:Boolean(body.error)}); return sendJson(response,200,task); }
      if (request.method === 'GET' && url.pathname === '/api/events') return sendJson(response, 200, await database.eventsAfter(principal, queryInteger(url.searchParams.get('cursor'), 0)));
      if (request.method === 'POST' && url.pathname === '/api/topups') {
        if (!config.developmentTopupEnabled) throw new HttpError('Direct top-up is disabled; use a verified payment callback', 403, 'topup_disabled');
        const body = await readJson<Omit<TopupRequest, 'idempotencyKey'>>(request); const key=String(request.headers['idempotency-key']??''); if(!key)throw new HttpError('idempotency-key is required',400,'idempotency_required');
        const entry=await database.topup(principal,{...body,idempotencyKey:key}); await database.audit(principal,'wallet.topup','ledger',entry.id,{amountCents:body.amountCents}); return sendJson(response,201,{entry,account:await database.getAccount(principal)});
      }
      if (request.method === 'POST' && url.pathname === '/api/usage') {
        if (principal.role !== 'admin') throw new HttpError('Usage ingestion requires a trusted service identity', 403, 'usage_forbidden');
        const event=await readJson<UsageEvent>(request); const entry=await database.recordUsage(principal,event); return sendJson(response,201,{entry,account:await database.getAccount(principal)});
      }
      const chatRoute = url.pathname.match(/^\/v1(?:\/sources\/([a-z0-9-]{2,40}))?\/chat\/completions$/);
      if (request.method === 'POST' && chatRoute) {
        const body = await readJson<{ model?: string; source?: string } & Record<string, unknown>>(request);
        if(body.stream===true)throw new HttpError('Streaming through the billed gateway is not enabled yet',400,'streaming_not_supported');
        if(!Array.isArray(body.messages) || body.messages.length === 0 || body.messages.length > 40)throw new HttpError('Chat must contain between 1 and 40 messages',400,'invalid_messages');
        const validMessages = body.messages.every((message) => {
          if (!message || typeof message !== 'object') return false;
          const value = message as { role?: unknown; content?: unknown };
          return (value.role === 'user' || value.role === 'assistant' || value.role === 'system') && typeof value.content === 'string' && value.content.length > 0 && value.content.length <= 50_000;
        });
        if (!validMessages) throw new HttpError('Chat messages are invalid',400,'invalid_messages');
        const routeSource = chatRoute[1];
        if (routeSource && body.source && routeSource !== body.source) throw new HttpError('Model source conflicts with the gateway route', 400, 'source_conflict');
        const sourceId=routeSource??body.source??(config.modelSources.some((source)=>source.apiKey)?config.modelSources.find((source)=>source.apiKey)!.id:'demo');
        const model=typeof body.model==='string'?body.model.trim():'';
        if(!model)throw new HttpError('Model is required',400,'model_required');
        const selection=await gateway.getModel(sourceId,model);const fallbackCandidate=sourceId==='demo'?null:await gateway.getFallbackModel(sourceId,model);
        const maxOutput=Number(body.max_completion_tokens??body.max_tokens??4096);if(!Number.isInteger(maxOutput)||maxOutput<1||maxOutput>65536)throw new HttpError('Invalid max output tokens',400,'invalid_max_tokens');
        const {source: _source, ...rawProviderBody}=body;const providerMaxOutput=Math.max(512,maxOutput);const providerBody={...rawProviderBody,...(body.max_completion_tokens!==undefined?{max_completion_tokens:providerMaxOutput}:{max_tokens:providerMaxOutput})};const reservationId=randomUUID();const estimatedInput=estimatedInputTokens(providerBody);const reservedCost=Math.max(gateway.costCents(selection.model,estimatedInput,providerMaxOutput),fallbackCandidate?gateway.costCents(fallbackCandidate,estimatedInput,providerMaxOutput):0);await database.reserveUsage(principal,reservationId,reservedCost);
        try {
          let actualModel=model;let actualSelection=selection;let actualProviderBody=providerBody;let upstream=await gateway.proxyChat(sourceId,actualProviderBody,requestId);let raw=await readResponseBuffer(upstream);
          if(!upstream.ok){await database.releaseUsage(principal,reservationId);response.writeHead(upstream.status,{'content-type':upstream.headers.get('content-type')??'application/json'});response.end(raw);return;}
          let parsed:unknown;try{parsed=JSON.parse(raw.toString('utf8')) as unknown;}catch{throw new HttpError('Model returned an invalid response',502,'invalid_model_response');}let content=assistantContentFromResponse(parsed);
          if(!content&&fallbackCandidate){actualModel=fallbackCandidate.id;actualSelection={source:selection.source,model:fallbackCandidate};actualProviderBody={...providerBody,model:actualModel};upstream=await gateway.proxyChat(sourceId,actualProviderBody,`${requestId}.fallback`);raw=await readResponseBuffer(upstream);if(!upstream.ok){await database.releaseUsage(principal,reservationId);response.writeHead(upstream.status,{'content-type':upstream.headers.get('content-type')??'application/json'});response.end(raw);return;}try{parsed=JSON.parse(raw.toString('utf8')) as unknown;}catch{throw new HttpError('Fallback model returned an invalid response',502,'invalid_model_response');}content=assistantContentFromResponse(parsed);}
          if(!content)throw new HttpError('Model returned an empty response after retry and fallback',502,'empty_model_response');const usage=usageFromResponse(parsed,actualProviderBody,content);const requestFingerprint=createHash('sha256').update(JSON.stringify(actualProviderBody)).digest('hex').slice(0,24);
          const costCents=gateway.costCents(actualSelection.model,usage.inputTokens,usage.outputTokens);const commissionRateBps=actualSelection.source.commissionRateBps;const commissionCents=Math.round(costCents*commissionRateBps/10_000);await database.settleUsage(principal,reservationId,{idempotencyKey:`chat:${requestId}:${requestFingerprint}`,taskId:'chat',sourceId,upstreamSourceId:actualSelection.source.upstreamSourceId,paymentDirection:actualSelection.source.paymentDirection,model:actualModel,inputTokens:usage.inputTokens,outputTokens:usage.outputTokens,costCents,commissionRateBps,commissionCents});await database.audit(principal,'chat.complete','model',actualModel,{requestedModel:model,fallbackUsed:actualModel!==model,sourceId,upstreamSourceId:actualSelection.source.upstreamSourceId,paymentDirection:actualSelection.source.paymentDirection,...usage,costCents,commissionRateBps,commissionCents});
          const result={...(parsed as Record<string,unknown>),model:actualModel,usage:{...((parsed as {usage?:Record<string,unknown>}).usage??{}),prompt_tokens:usage.inputTokens,completion_tokens:usage.outputTokens},cod_source:sourceId,cod_upstream_source:actualSelection.source.upstreamSourceId,cod_payment_direction:actualSelection.source.paymentDirection,cod_charge_cents:costCents,cod_commission_rate_bps:commissionRateBps,cod_usage_estimated:usage.estimated,cod_requested_model:model,cod_fallback_used:actualModel!==model};const output=Buffer.from(JSON.stringify(result));response.writeHead(upstream.status,{'content-type':'application/json; charset=utf-8','content-length':output.length});response.end(output);return;
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
  if (process.env.NODE_ENV === 'production' && (config.sessionSecret === 'cod-local-development-secret' || config.sessionSecret.length < 32)) throw new Error('COD_SESSION_SECRET must contain at least 32 characters in production');
  if (process.env.NODE_ENV === 'production' && config.developmentLoginEnabled && !config.pilotAccessCodeHash) throw new Error('COD_PILOT_ACCESS_CODE_HASH is required when pilot login is enabled in production');
  await database.initialize();
  const server=createControlPlane({config,database});
  server.listen(config.port,'127.0.0.1',()=>console.log(JSON.stringify({level:'info',event:'service.started',port:config.port,revision:process.env.COD_REVISION??'development'})));
  const shutdown=async(signal:string)=>{console.log(JSON.stringify({level:'info',event:'service.stopping',signal}));server.close(async()=>{await database.close();process.exit(0);});setTimeout(()=>process.exit(1),10_000).unref();};
  process.once('SIGTERM',()=>void shutdown('SIGTERM'));process.once('SIGINT',()=>void shutdown('SIGINT'));
}
