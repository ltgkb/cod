import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import type { TaskStatus, UsageEvent } from '@cod/contracts';
import { AGENT_SESSION_TTL_MS, createAgentSessionToken, createSessionToken, hashPassword, validatePassword, verifyAgentSessionToken, verifyPassword, verifySessionToken } from './auth.js';
import { BotService, parseBotCommand, parseFeishuWebhook, replyFeishuMessage, verifyWebhookSignature, type BotPlatform } from './bots.js';
import { loadConfig, type ControlPlaneConfig } from './config.js';
import { CHAT_RESPONSE_CACHE_MAX_BYTES, creditPackCatalog, type CodDatabase, type Principal, PostgresDatabase, type TopupRequest } from './database.js';
import { errorResponse, HttpError } from './errors.js';
import { AiGateway, type ModelSourceInfo } from './gateway.js';
import { bearerToken, readJson, readText, sendJson, sendText } from './http.js';
import { KnowledgeAdapter } from './knowledge.js';
import { MemoryDatabase } from './memory-database.js';
import { ProductRegistry } from './products.js';
import { beginRequest, recordRequest, renderMetrics } from './metrics.js';
import { computeOfferCatalog, validateComputeRequest } from './compute-market.js';
import { OfficialPaymentService } from './payments.js';

export interface ControlPlaneOptions {
  config?: ControlPlaneConfig;
  database?: CodDatabase;
  gateway?: AiGateway;
}

const validStatuses = new Set<TaskStatus>(['draft', 'running', 'waiting', 'complete', 'failed', 'cancelled']);
const uuidPattern=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const userIdFor = (email: string) => `usr_${createHash('sha256').update(email).digest('hex').slice(0, 20)}`;
const tenantIdFor = (email: string) => `tenant_${email.split('@')[1]?.replace(/[^a-z0-9]+/g, '_') ?? 'unknown'}`;
const principalFromSession = (session: { sub: string; tenantId: string; email: string; role: Principal['role'] }): Principal => ({ userId: session.sub, tenantId: session.tenantId, email: session.email, role: session.role });

function pathUuid(raw:string,message:string,code:string):string{
  let value:string;
  try{value=decodeURIComponent(raw);}catch{throw new HttpError(message,400,code);}
  if(!uuidPattern.test(value))throw new HttpError(message,400,code);
  return value;
}

type PublicModelSourceInfo = Pick<ModelSourceInfo, 'id' | 'label' | 'upstreamSourceId' | 'status' | 'callable' | 'paymentDirection' | 'models' | 'note'>;
function publicModelCatalog(sources: ModelSourceInfo[]): PublicModelSourceInfo[] {
  return sources.map(({ id, label, upstreamSourceId, status, callable, paymentDirection, models, note }) => ({
    id, label, upstreamSourceId, status, callable, paymentDirection, models, note,
  }));
}

const dummyPasswordHash='scrypt$16384$8$1$MDEyMzQ1Njc4OWFiY2RlZg$vNLqtxxHxO9XlDJYZk-T6OzryI7HSubiscMSJDaWZtd0bu3h2vmmdlKsAZpCn3V20q-R_KOLJgJl9mHX32LDiA';

function validateAuthEmail(raw: unknown): string {
  if(typeof raw!=='string')throw new HttpError('请输入有效邮箱',400,'invalid_email');
  const email = (raw ?? '').trim().toLowerCase();
  if(email.length>254||!/^\S+@\S+\.\S+$/.test(email))throw new HttpError('请输入有效邮箱',400,'invalid_email');
  return email;
}

function verifyLegacyAccessCode(accessCode: unknown, config:ControlPlaneConfig):boolean{
  if(config.pilotAccessCodeHash&&typeof accessCode==='string'){
    const expected = Buffer.from(config.pilotAccessCodeHash, 'hex');
    const actual = createHash('sha256').update(accessCode).digest();
    return expected.length===actual.length&&timingSafeEqual(expected,actual);
  }
  return false;
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

export function assistantToolCallsFromResponse(body: unknown): Array<Record<string,unknown>> {
  if(!body||typeof body!=='object')return[];
  const choices=(body as {choices?:unknown}).choices;if(!Array.isArray(choices)||!choices[0]||typeof choices[0]!=='object')return[];
  const message=(choices[0] as {message?:unknown}).message;if(!message||typeof message!=='object')return[];
  const toolCalls=(message as {tool_calls?:unknown}).tool_calls;if(!Array.isArray(toolCalls))return[];
  return toolCalls.filter((call):call is Record<string,unknown>=>{
    if(!call||typeof call!=='object'||typeof (call as {id?:unknown}).id!=='string')return false;
    const fn=(call as {function?:unknown}).function;
    return Boolean(fn&&typeof fn==='object'&&typeof (fn as {name?:unknown}).name==='string'&&typeof (fn as {arguments?:unknown}).arguments==='string');
  });
}

export function assistantFinishReasonFromResponse(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const choices = (body as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || !choices[0] || typeof choices[0] !== 'object') return null;
  const finishReason = (choices[0] as { finish_reason?: unknown }).finish_reason;
  return typeof finishReason === 'string' && finishReason.trim() ? finishReason.trim().toLowerCase() : null;
}

function assistantResponseIsIncomplete(body: unknown): boolean {
  return ['length', 'max_tokens', 'max_output_tokens'].includes(assistantFinishReasonFromResponse(body) ?? '');
}

function assistantHasAction(body:unknown):boolean{return Boolean(assistantContentFromResponse(body)||assistantToolCallsFromResponse(body).length);}

export function isValidChatMessage(message:unknown):boolean{
  if(!message||typeof message!=='object')return false;
  const value=message as {role?:unknown;content?:unknown;tool_calls?:unknown;tool_call_id?:unknown};
  const validText=typeof value.content==='string'&&value.content.length>0&&value.content.length<=50_000;
  if(value.role==='user'||value.role==='system'||value.role==='developer')return validText;
  if(value.role==='tool')return validText&&typeof value.tool_call_id==='string'&&value.tool_call_id.length>0&&value.tool_call_id.length<=200;
  if(value.role!=='assistant')return false;
  if(validText)return true;
  if(!Array.isArray(value.tool_calls)||value.tool_calls.length===0||value.tool_calls.length>64)return false;
  return value.tool_calls.every((call)=>{
    if(!call||typeof call!=='object'||typeof (call as {id?:unknown}).id!=='string')return false;
    const fn=(call as {function?:unknown}).function;
    return Boolean(fn&&typeof fn==='object'&&typeof (fn as {name?:unknown}).name==='string'&&typeof (fn as {arguments?:unknown}).arguments==='string'&&String((fn as {arguments:unknown}).arguments).length<=100_000);
  });
}

function estimatedInputTokens(body: unknown): number {
  const messages = body && typeof body === 'object' && Array.isArray((body as { messages?: unknown }).messages) ? (body as { messages: unknown[] }).messages : body;
  return Math.max(1, Math.ceil(Buffer.byteLength(JSON.stringify(messages), 'utf8') / 4));
}

const estimatedTextTokens = (text: string): number => Math.max(1, Math.ceil(Buffer.byteLength(text, 'utf8') / 4));

function canonicalJson(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map((child) => child === undefined ? null : normalize(child));
    if (!item || typeof item !== 'object') return item;
    return Object.fromEntries(Object.keys(item as Record<string,unknown>).sort().flatMap((key) => {
      const child=(item as Record<string,unknown>)[key];
      return child === undefined ? [] : [[key,normalize(child)]];
    }));
  };
  return JSON.stringify(normalize(value));
}

function sendChatResult(response: ServerResponse, result: Record<string,unknown>, stream: boolean, requestId: string): void {
  if (!stream) {
    const output=Buffer.from(JSON.stringify(result));
    response.writeHead(200,{'content-type':'application/json; charset=utf-8','content-length':output.length});response.end(output);return;
  }
  const choices=Array.isArray(result.choices)?result.choices:[];
  const firstChoice=choices[0]&&typeof choices[0]==='object'?choices[0] as Record<string,unknown>:{};
  const model=typeof result.model==='string'?result.model:'unknown';
  const streamBase={id:typeof result.id==='string'?result.id:`chatcmpl-${requestId}`,object:'chat.completion.chunk',created:typeof result.created==='number'?result.created:Math.floor(Date.now()/1000),model};
  const streamMetadata=Object.fromEntries(Object.entries(result).filter(([key])=>key.startsWith('cod_')));
  const content=assistantContentFromResponse(result);const toolCalls=assistantToolCallsFromResponse(result);
  const delta={role:'assistant',...(content?{content}:{}),...(toolCalls.length?{tool_calls:toolCalls.map((call,index)=>({...call,index}))}:{})};
  const contentChunk={...streamBase,choices:[{index:0,delta,finish_reason:null}],...streamMetadata};
  const finishChunk={...streamBase,choices:[{index:0,delta:{},finish_reason:typeof firstChoice.finish_reason==='string'?firstChoice.finish_reason:'stop'}],usage:result.usage,...streamMetadata};
  response.writeHead(200,{'content-type':'text/event-stream; charset=utf-8','cache-control':'no-cache, no-transform','connection':'keep-alive','x-accel-buffering':'no'});
  response.write(`data: ${JSON.stringify(contentChunk)}\n\n`);response.write(`data: ${JSON.stringify(finishChunk)}\n\n`);response.end('data: [DONE]\n\n');
}

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
  const gateway = options.gateway ?? new AiGateway(config);
  const knowledge = new KnowledgeAdapter(config);
  const products = new ProductRegistry(config);
  const officialPayments = new OfficialPaymentService(config);
  const seenFeishuMessages = new Set<string>();
  interface ActiveChatRequest { controller: AbortController; reservationId: string; reservationReady: Promise<void>; state: 'active' | 'settling' | 'settled' }
  const activeChats = new Map<string, Set<ActiveChatRequest>>();
  const activeChatKey = (principal: Principal, taskId: string) => `${principal.tenantId}\0${principal.userId}\0${taskId}`;
  const registerActiveChat = (principal: Principal, taskId: string, active: ActiveChatRequest) => {
    const key = activeChatKey(principal, taskId);
    const entries = activeChats.get(key) ?? new Set<ActiveChatRequest>();
    entries.add(active); activeChats.set(key, entries);
    return () => { entries.delete(active); if (!entries.size) activeChats.delete(key); };
  };
  const cancelActiveChats = async (principal: Principal, taskId: string): Promise<number> => {
    const entries = [...(activeChats.get(activeChatKey(principal, taskId)) ?? [])].filter((entry)=>entry.state==='active');
    for (const entry of entries) entry.controller.abort(new HttpError('Task was cancelled', 409, 'task_cancelled'));
    await Promise.all(entries.map(async(entry)=>{await entry.reservationReady;await database.releaseUsage(principal,entry.reservationId);}));
    return entries.length;
  };

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
      response.setHeader('access-control-allow-headers', 'authorization,content-type,idempotency-key,x-request-id,x-cod-task-execution,x-cod-task-lease');
      response.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
      if (request.method === 'OPTIONS') return sendJson(response, 204, null);
      if (request.method === 'GET' && url.pathname === '/health') return sendJson(response, 200, { status: 'ok', service: 'cod-control-plane' });
      if (request.method === 'GET' && url.pathname === '/ready') { const ready=await database.health(); return sendJson(response, ready ? 200 : 503, { status: ready ? 'ready' : 'not_ready', database: config.databaseUrl ? 'postgres' : 'memory' }); }
      if (request.method === 'GET' && url.pathname === '/metrics') { const ready=await database.health(); response.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' }); response.end(renderMetrics(ready)); return; }
      if (request.method === 'GET' && url.pathname === '/version') return sendJson(response, 200, { revision: process.env.COD_REVISION ?? 'development', node: process.version });
      if (request.method === 'GET' && url.pathname === '/api/capabilities') return sendJson(response, 200, {
        authentication: { mode: 'password', registrationEnabled: config.registrationEnabled, inviteCodeOptional: !config.inviteCodeRequired, inviteCodeRequired: config.inviteCodeRequired, accessCodeRequired: false },
        ai: { mode: await gateway.mode(), streaming: true, streamingMode: 'buffered-sse' },
        knowledge: { mode: knowledge.mode() },
        payments: {
          topupEnabled: config.developmentTopupEnabled,
          orderApi: Boolean(config.paymentWebhookSecret) || officialPayments.availableChannels().length > 0,
          channels: officialPayments.availableChannels(),
          mode: officialPayments.availableChannels().length > 0 ? 'official-merchant' : config.paymentWebhookSecret ? 'verified-webhook' : config.developmentTopupEnabled ? 'pilot-credit' : 'unavailable',
        },
        synchronization: { transport: 'polling', taskStatusVersioning: true, taskCancellation: true },
        remote: {
          feishu: config.feishuVerificationToken && config.feishuAppId && config.feishuAppSecret && Object.keys(config.feishuBindings).length ? 'live' : 'unavailable',
          wecom: process.env.COD_BOT_WEBHOOK_SECRET ? 'adapter' : 'unavailable',
        },
      });
      if (request.method === 'GET' && url.pathname === '/api/model-catalog') return sendJson(response, 200, publicModelCatalog(await gateway.listSources()));
      if (request.method === 'GET' && url.pathname === '/api/compute/offers') return sendJson(response, 200, computeOfferCatalog);
      if (request.method === 'POST' && url.pathname === '/api/auth/login') {
        const body = await readJson<{ email?: string; password?: string }>(request);
        const email = validateAuthEmail(body.email);
        const identity=await database.findIdentityByEmail(email);
        const passwordMatches=await verifyPassword(body.password,identity?.passwordHash??dummyPasswordHash);
        if(!identity?.passwordHash||!passwordMatches)throw new HttpError('邮箱或密码错误',401,'invalid_credentials');
        const principal=identity.principal;
        await database.audit(principal, 'auth.login', 'session', null);
        const token = createSessionToken({ sub: principal.userId, tenantId: principal.tenantId, email, role: principal.role }, config.sessionSecret);
        return sendJson(response, 200, { token, user: { id: principal.userId, email } });
      }
      if(request.method==='POST'&&url.pathname==='/api/auth/register'){
        if(!config.registrationEnabled)throw new HttpError('账号注册暂未开放',503,'registration_unavailable');
        const body=await readJson<{email?:string;password?:string;inviteCode?:string;legacyAccessCode?:string}>(request);
        const email=validateAuthEmail(body.email);
        let password:string;try{password=validatePassword(body.password);}catch(error){throw new HttpError(error instanceof Error?error.message:'密码不符合要求',400,'invalid_password');}
        const inviteCode=typeof body.inviteCode==='string'&&body.inviteCode.trim()?body.inviteCode.trim().toUpperCase():null;
        if(inviteCode&&(!/^[A-Z0-9-]{4,32}$/.test(inviteCode)))throw new HttpError('邀请码格式无效',400,'invalid_invite_code');
        const existing=await database.findIdentityByEmail(email);
        const allowExisting=Boolean(existing&&!existing.passwordHash&&verifyLegacyAccessCode(body.legacyAccessCode,config));
        if(!allowExisting&&config.inviteCodeRequired&&!inviteCode)throw new HttpError('请输入有效邀请码',400,'invite_code_required');
        const principal:Principal={userId:userIdFor(email),tenantId:tenantIdFor(email),email,role:'member'};
        const result=await database.registerIdentity(principal,await hashPassword(password),inviteCode,allowExisting);
        await database.audit(result.identity.principal,result.created?'auth.register':'auth.legacy_migrated','user',result.identity.principal.userId,{inviteCodeUsed:result.identity.referralCodeUsed});
        const token=createSessionToken({sub:result.identity.principal.userId,tenantId:result.identity.principal.tenantId,email,role:result.identity.principal.role},config.sessionSecret);
        return sendJson(response,result.created?201:200,{token,user:{id:result.identity.principal.userId,email},inviteCode:result.identity.inviteCode,referred:Boolean(result.identity.referredByUserId)});
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
      if (request.method === 'POST' && url.pathname === '/api/webhooks/payments/wechat') {
        const event = officialPayments.verifyWechatNotification(await readText(request), request.headers);
        if (event) await database.completePaymentOrder(event);
        return sendJson(response, 200, { code: 'SUCCESS', message: '成功' });
      }
      if (request.method === 'POST' && url.pathname === '/api/webhooks/payments/alipay') {
        const event = officialPayments.verifyAlipayNotification(await readText(request));
        if (event) await database.completePaymentOrder(event);
        return sendText(response, 200, 'success');
      }
      const bearer=bearerToken(request)??'';
      const session=verifySessionToken(bearer,config.sessionSecret);
      const agentSession=session?null:verifyAgentSessionToken(bearer,config.sessionSecret);
      if(!session&&!agentSession)return sendJson(response,401,{error:'unauthorized'});
      if(agentSession){
        const scopedPath=`/v1/tasks/${agentSession.taskId}/sources/${agentSession.sourceId}/chat/completions`;
        if(request.method!=='POST'||url.pathname!==scopedPath)return sendJson(response,403,{error:'agent_scope_forbidden'});
      }
      const principal=principalFromSession(session??agentSession!);
      if(request.method==='POST'&&url.pathname==='/api/agent-sessions'){
        if(!session)throw new HttpError('A full account session is required',403,'agent_scope_forbidden');
        const body=await readJson<{taskId?:unknown;executionId?:unknown;leaseToken?:unknown;sourceId?:unknown;model?:unknown}>(request);
        const taskId=typeof body.taskId==='string'?body.taskId.trim():'';
        const executionId=typeof body.executionId==='string'?body.executionId.trim():'';
        const leaseToken=typeof body.leaseToken==='string'?body.leaseToken.trim():'';
        const sourceId=typeof body.sourceId==='string'?body.sourceId.trim():'';
        const model=typeof body.model==='string'?body.model.trim():'';
        if(!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(taskId))throw new HttpError('Task ID is invalid',400,'invalid_task_id');
        if(!/^[a-z0-9-]{2,40}$/.test(sourceId))throw new HttpError('Model source is invalid',400,'invalid_source');
        if(!model||model.length>200)throw new HttpError('Model is invalid',400,'invalid_model');
        await database.assertTaskLease(principal,taskId,{executionId,leaseToken});
        await gateway.getModel(sourceId,model);
        const issuedAt=Date.now();const scope={taskId,executionId,sourceId,model};const token=createAgentSessionToken(session,scope,config.sessionSecret,issuedAt);
        await database.audit(principal,'agent_session.issue','task',taskId,{executionId,sourceId,model,expiresAt:new Date(issuedAt+AGENT_SESSION_TTL_MS).toISOString()});
        return sendJson(response,201,{token,expiresAt:new Date(issuedAt+AGENT_SESSION_TTL_MS).toISOString(),scope});
      }
      if(request.method==='GET'&&url.pathname==='/api/referrals')return sendJson(response,200,await database.getReferralSummary(principal));
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
        const channel=body.channel as 'wechat'|'alipay';
        const officialChannel=officialPayments.availableChannels().includes(channel);
        if(!officialChannel&&!config.paymentWebhookSecret)throw new HttpError('所选支付渠道尚未接入',503,'payments_unavailable');
        const order=await database.createPaymentOrder(principal,{amountCents:Number(body.amountCents),channel,idempotencyKey:key});
        await database.audit(principal,'payment.order.created','payment_order',order.id,{amountCents:order.amountCents,channel:order.channel});
        if (!officialChannel) return sendJson(response,201,order);
        return sendJson(response,201,{order,checkout:await officialPayments.createCheckout(order)});
      }
      if (request.method === 'GET' && url.pathname.match(/^\/api\/payment-orders\/[^/]+$/)) return sendJson(response,200,await database.getPaymentOrder(principal,pathUuid(url.pathname.split('/')[3],'Payment order ID is invalid','invalid_payment_order_id')));
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
      if (request.method === 'POST' && url.pathname.match(/^\/api\/devices\/[^/]+\/heartbeat$/)) {const deviceId=pathUuid(url.pathname.split('/')[3],'Device ID is invalid','invalid_device_id');const body=await readJson<{taskId?:unknown;executionId?:unknown;leaseToken?:unknown}>(request);const hasLease=body.taskId!==undefined||body.executionId!==undefined||body.leaseToken!==undefined;const taskLease=hasLease?{taskId:typeof body.taskId==='string'?body.taskId:'',executionId:typeof body.executionId==='string'?body.executionId:'',leaseToken:typeof body.leaseToken==='string'?body.leaseToken:''}:undefined;return sendJson(response,200,await database.heartbeat(principal,deviceId,taskLease));}
      if (request.method === 'GET' && url.pathname === '/api/tasks') return sendJson(response, 200, await database.listTasks(principal));
      if (request.method === 'POST' && url.pathname === '/api/tasks') {const body=await readJson<{title:string;deviceId:string}>(request);if(typeof body.deviceId!=='string'||!uuidPattern.test(body.deviceId))throw new HttpError('Device ID is invalid',400,'invalid_device_id');const task=await database.createTask(principal,body);await database.audit(principal,'task.create','task',task.id);return sendJson(response,201,task);}
      if (request.method === 'POST' && url.pathname.match(/^\/api\/tasks\/[^/]+\/cancel$/)) {
        const taskId=pathUuid(url.pathname.split('/')[3],'Task ID is invalid','invalid_task_id');
        const body=await readJson<{expectedVersion?:number}>(request);
        if(!Number.isInteger(body.expectedVersion)||Number(body.expectedVersion)<1)throw new HttpError('Expected task version is required',400,'invalid_task_version');
        const task=await database.updateTask(principal,taskId,'cancelled',Number(body.expectedVersion),{result:null,error:null});
        const cancelledRequests=await cancelActiveChats(principal,taskId);
        await database.audit(principal,'task.cancel','task',task.id,{cancelledRequests});
        return sendJson(response,200,{task,cancelledRequests});
      }
      if (request.method === 'POST' && url.pathname.match(/^\/api\/tasks\/[^/]+\/status$/)) {
        const body=await readJson<{status:TaskStatus;expectedVersion:number;result?:string|null;error?:string|null;claimId?:string;executionId?:string;leaseToken?:string}>(request);if(!validStatuses.has(body.status))throw new HttpError('Invalid task status',400,'invalid_status');if(!Number.isInteger(body.expectedVersion)||body.expectedVersion<1)throw new HttpError('Expected task version is required',400,'invalid_task_version');const taskId=pathUuid(url.pathname.split('/')[3],'Task ID is invalid','invalid_task_id');
        if(body.status==='running'){const current=await database.getTask(principal,taskId);const isClaim=body.claimId!==undefined||(current.status!=='running'&&current.status!=='waiting');if(isClaim){const claim=await database.claimTask(principal,taskId,body.expectedVersion,{claimId:typeof body.claimId==='string'?body.claimId:'',leaseToken:typeof body.leaseToken==='string'?body.leaseToken:''});if(!claim.replayed)await database.audit(principal,'task.status','task',claim.task.id,{status:'running'});return sendJson(response,200,{...claim.task,execution:{executionId:claim.executionId,leaseToken:claim.leaseToken,leaseExpiresAt:claim.leaseExpiresAt}});}const execution=body.executionId||body.leaseToken?{executionId:body.executionId??'',leaseToken:body.leaseToken??''}:undefined;const task=await database.updateTask(principal,taskId,'running',body.expectedVersion,{result:body.result,error:body.error},execution);await database.audit(principal,'task.status','task',task.id,{status:'running'});return sendJson(response,200,task);}
        const execution=body.executionId||body.leaseToken?{executionId:body.executionId??'',leaseToken:body.leaseToken??''}:undefined;const task=await database.updateTask(principal,taskId,body.status,body.expectedVersion,{result:body.result,error:body.error},execution);await database.audit(principal,'task.status','task',task.id,{status:body.status,hasResult:Boolean(body.result),hasError:Boolean(body.error)});return sendJson(response,200,task);
      }
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
      const chatRoute = url.pathname.match(/^\/v1(?:\/tasks\/([^/]+))?(?:\/sources\/([a-z0-9-]{2,40}))?\/chat\/completions$/);
      if (request.method === 'POST' && chatRoute) {
        const body = await readJson<{ model?: string; source?: string; task_id?: string } & Record<string, unknown>>(request);
        const clientRequestedStream=body.stream===true;
        if(!Array.isArray(body.messages) || body.messages.length === 0 || body.messages.length > 40)throw new HttpError('Chat must contain between 1 and 40 messages',400,'invalid_messages');
        const validMessages = body.messages.every(isValidChatMessage);
        if (!validMessages) throw new HttpError('Chat messages are invalid',400,'invalid_messages');
        const routeTaskId=chatRoute[1]?pathUuid(chatRoute[1],'Task ID is invalid','invalid_task_id'):null;
        const bodyTaskId=body.task_id===undefined?null:typeof body.task_id==='string'?body.task_id.trim():'';
        if(body.task_id!==undefined&&!bodyTaskId)throw new HttpError('Task ID is invalid',400,'invalid_task_id');
        if(routeTaskId&&bodyTaskId&&routeTaskId!==bodyTaskId)throw new HttpError('Task conflicts with the gateway route',400,'task_conflict');
        const taskId=routeTaskId??bodyTaskId;
        if(taskId&&!uuidPattern.test(taskId))throw new HttpError('Task ID is invalid',400,'invalid_task_id');
        let taskExecutionId:string|undefined;
        if(taskId){if(agentSession){taskExecutionId=agentSession.executionId;await database.assertTaskExecution(principal,taskId,taskExecutionId);}else{const executionId=typeof request.headers['x-cod-task-execution']==='string'?request.headers['x-cod-task-execution']:'';const leaseToken=typeof request.headers['x-cod-task-lease']==='string'?request.headers['x-cod-task-lease']:'';await database.assertTaskLease(principal,taskId,{executionId,leaseToken});taskExecutionId=executionId;}}
        const routeSource = chatRoute[2];
        if (routeSource && body.source && routeSource !== body.source) throw new HttpError('Model source conflicts with the gateway route', 400, 'source_conflict');
        const sourceId=routeSource??body.source??(config.modelSources.some((source)=>source.apiKey)?config.modelSources.find((source)=>source.apiKey)!.id:'demo');
        const model=typeof body.model==='string'?body.model.trim():'';
        if(!model)throw new HttpError('Model is required',400,'model_required');
        if(agentSession&&(taskId!==agentSession.taskId||taskExecutionId!==agentSession.executionId||sourceId!==agentSession.sourceId||model!==agentSession.model))throw new HttpError('Agent session does not permit this chat request',403,'agent_scope_forbidden');
        const selection=await gateway.getModel(sourceId,model);const fallbackCandidate=sourceId==='demo'?null:await gateway.getFallbackModel(sourceId,model);
        const maxOutput=Number(body.max_completion_tokens??body.max_tokens??4096);if(!Number.isInteger(maxOutput)||maxOutput<1||maxOutput>20_000)throw new HttpError('Invalid max output tokens; COD allows at most 20000',400,'invalid_max_tokens');
        const {source: _source,task_id: _taskId, ...rawProviderBody}=body;const providerMaxOutput=Math.max(512,maxOutput);const providerBody={...rawProviderBody,stream:false,...(body.max_completion_tokens!==undefined?{max_completion_tokens:providerMaxOutput}:{max_tokens:providerMaxOutput})};
        const requestFingerprint=createHash('sha256').update(canonicalJson({taskId:taskId??null,taskExecutionId:taskExecutionId??null,sourceId,providerBody})).digest('hex');
        const requestKey=agentSession?`agent:${agentSession.jti}:${requestFingerprint}`:requestId;
        const upstreamRequestKey=`cod-${createHash('sha256').update(canonicalJson({tenantId:principal.tenantId,userId:principal.userId,requestKey,requestFingerprint})).digest('hex').slice(0,48)}`;
        const claim=await database.claimChatRequest(principal,requestKey,requestFingerprint,taskExecutionId);
        if(claim.state==='pending')throw new HttpError('An identical chat request is still in progress',409,'chat_request_in_progress');
        if(claim.state==='complete'){sendChatResult(response,claim.responsePayload,clientRequestedStream,requestId);return;}
        const reservationId=randomUUID();const estimatedInput=estimatedInputTokens(providerBody);const reservedCost=Math.max(gateway.costCents(selection.model,estimatedInput,providerMaxOutput),fallbackCandidate?gateway.costCents(fallbackCandidate,estimatedInput,providerMaxOutput):0);
        const controller=new AbortController();let markReservationReady:()=>void=()=>undefined;const reservationReady=new Promise<void>((resolve)=>{markReservationReady=resolve;});const activeChat:ActiveChatRequest={controller,reservationId,reservationReady,state:'active'};const unregisterActiveChat=taskId?registerActiveChat(principal,taskId,activeChat):()=>undefined;
        const leaseKeepalive=taskId&&taskExecutionId?setInterval(()=>{void database.renewTaskExecution(principal,taskId,taskExecutionId).catch((error)=>controller.abort(error));},30_000):null;leaseKeepalive?.unref();
        const cancelOnDisconnect=()=>{if(!response.writableEnded&&!controller.signal.aborted)controller.abort(new HttpError('Client disconnected',409,'client_disconnected'));};response.once('close',cancelOnDisconnect);
        let chatSettled=false;
        const failChatClaim=async()=>{try{await database.failChatRequest(principal,requestKey,requestFingerprint,taskExecutionId);}catch(failure){console.error(JSON.stringify({level:'error',event:'chat.claim.fail_failed',requestId,taskId:taskId??null,sourceId,error:failure instanceof Error?failure.message:String(failure)}));}};
        try {
          await database.reserveUsage(principal,reservationId,reservedCost,taskId&&taskExecutionId?{taskId,executionId:taskExecutionId}:undefined);markReservationReady();if(controller.signal.aborted)throw controller.signal.reason;
          let actualModel=model;let actualSelection=selection;let actualProviderBody=providerBody;let fallbackReason:'empty'|'length'|null=null;let upstream=await gateway.proxyChat(sourceId,actualProviderBody,upstreamRequestKey,controller.signal);let raw=await readResponseBuffer(upstream);if(controller.signal.aborted)throw controller.signal.reason;
          if(!upstream.ok){await database.releaseUsage(principal,reservationId);await failChatClaim();response.writeHead(upstream.status,{'content-type':upstream.headers.get('content-type')??'application/json'});response.end(raw);return;}
          let parsed:unknown;try{parsed=JSON.parse(raw.toString('utf8')) as unknown;}catch{throw new HttpError('Model returned an invalid response',502,'invalid_model_response');}let content=assistantContentFromResponse(parsed);let toolCalls=assistantToolCallsFromResponse(parsed);
          const primaryHasAction=assistantHasAction(parsed);const primaryIncomplete=assistantResponseIsIncomplete(parsed);
          if((!primaryHasAction||primaryIncomplete)&&fallbackCandidate){fallbackReason=primaryIncomplete?'length':'empty';actualModel=fallbackCandidate.id;actualSelection={source:selection.source,model:fallbackCandidate};actualProviderBody={...providerBody,model:actualModel};upstream=await gateway.proxyChat(sourceId,actualProviderBody,`${upstreamRequestKey}-fallback`,controller.signal);raw=await readResponseBuffer(upstream);if(controller.signal.aborted)throw controller.signal.reason;if(!upstream.ok){await database.releaseUsage(principal,reservationId);await failChatClaim();response.writeHead(upstream.status,{'content-type':upstream.headers.get('content-type')??'application/json'});response.end(raw);return;}try{parsed=JSON.parse(raw.toString('utf8')) as unknown;}catch{throw new HttpError('Fallback model returned an invalid response',502,'invalid_model_response');}content=assistantContentFromResponse(parsed);toolCalls=assistantToolCallsFromResponse(parsed);}
          if(!assistantHasAction(parsed))throw new HttpError('Model returned an empty response after retry and fallback',502,'empty_model_response');if(assistantResponseIsIncomplete(parsed))throw new HttpError('Model output reached its token limit after fallback',502,'incomplete_model_response');const usage=usageFromResponse(parsed,actualProviderBody,content??JSON.stringify(toolCalls));
          const calculatedCostCents=gateway.costCents(actualSelection.model,usage.inputTokens,usage.outputTokens);const billingExempt=principal.role==='admin';const costCents=billingExempt?0:calculatedCostCents;const commissionRateBps=billingExempt?0:actualSelection.source.commissionRateBps;const commissionCents=billingExempt?0:Math.round(costCents*commissionRateBps/10_000);const paymentDirection=billingExempt?'管理员测试免计费':actualSelection.source.paymentDirection;
          const result={...(parsed as Record<string,unknown>),model:actualModel,usage:{...((parsed as {usage?:Record<string,unknown>}).usage??{}),prompt_tokens:usage.inputTokens,completion_tokens:usage.outputTokens,total_tokens:usage.inputTokens+usage.outputTokens},cod_source:sourceId,cod_upstream_source:actualSelection.source.upstreamSourceId,cod_payment_direction:paymentDirection,cod_charge_cents:costCents,cod_commission_rate_bps:commissionRateBps,cod_usage_estimated:usage.estimated,cod_requested_model:model,cod_fallback_used:actualModel!==model,cod_fallback_reason:fallbackReason};
          if(Buffer.byteLength(JSON.stringify(result),'utf8')>CHAT_RESPONSE_CACHE_MAX_BYTES)throw new HttpError('Model response is too large to cache safely',502,'chat_response_cache_too_large');
          if(controller.signal.aborted)throw controller.signal.reason;
          activeChat.state='settling';
          await database.settleUsage(principal,reservationId,{idempotencyKey:`chat:${requestKey}:${requestFingerprint}`,taskId:taskId??'chat',sourceId,upstreamSourceId:actualSelection.source.upstreamSourceId,paymentDirection,model:actualModel,inputTokens:usage.inputTokens,outputTokens:usage.outputTokens,costCents,commissionRateBps,commissionCents},{requestKey,fingerprint:requestFingerprint,executionId:taskExecutionId,responsePayload:result,audit:{entityId:actualModel,data:{taskId:taskId??null,executionId:taskExecutionId??null,requestedModel:model,fallbackUsed:actualModel!==model,fallbackReason,sourceId,upstreamSourceId:actualSelection.source.upstreamSourceId,paymentDirection,...usage,costCents,commissionRateBps,commissionCents}}},taskExecutionId);activeChat.state='settled';chatSettled=true;
          sendChatResult(response,result,clientRequestedStream,requestId);return;
        } catch(error) { markReservationReady();if(!chatSettled)await failChatClaim();await database.releaseUsage(principal,reservationId);if(controller.signal.aborted)throw controller.signal.reason instanceof HttpError?controller.signal.reason:new HttpError('Task was cancelled',409,'task_cancelled');throw error; }
        finally { if(leaseKeepalive)clearInterval(leaseKeepalive);response.removeListener('close',cancelOnDisconnect);unregisterActiveChat(); }
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
