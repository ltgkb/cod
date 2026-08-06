import { createServer } from 'node:http';
import type { UsageEvent } from '@cod/contracts';
import { createSessionToken, verifySessionToken } from './auth.js';
import { loadConfig } from './config.js';
import { AiGateway } from './gateway.js';
import { bearerToken, readJson, readText, sendJson } from './http.js';
import { KnowledgeAdapter } from './knowledge.js';
import { AccountStore, type TopupRequest } from './store.js';
import { SyncStore } from './sync.js';
import { BotService, parseBotCommand, verifyWebhookSignature, type BotPlatform } from './bots.js';
import { ProductRegistry } from './products.js';

export function createControlPlane() {
  const config = loadConfig();
  const accounts = new AccountStore();
  const gateway = new AiGateway(config);
  const knowledge = new KnowledgeAdapter(config);
  const sync = new SyncStore();
  const bots = new BotService(sync);
  const products = new ProductRegistry(config);

  return createServer(async (request, response) => {
    if (request.method === 'OPTIONS') return sendJson(response, 204, null);
    const url = new URL(request.url ?? '/', 'http://localhost');
    try {
      if (request.method === 'GET' && url.pathname === '/health') return sendJson(response, 200, { status: 'ok', service: 'cod-control-plane' });
      if (request.method === 'POST' && url.pathname.match(/^\/api\/webhooks\/(feishu|wecom)$/)) {
        const rawBody = await readText(request);
        const raw = JSON.parse(rawBody || '{}') as { text?: string };
        const platform = url.pathname.split('/')[3] as BotPlatform;
        const timestamp = String(request.headers['x-cod-timestamp'] ?? '');
        const signature = String(request.headers['x-cod-signature'] ?? '');
        const secret = process.env.COD_BOT_WEBHOOK_SECRET ?? 'cod-bot-development-secret';
        if (!verifyWebhookSignature(rawBody, timestamp, signature, secret)) return sendJson(response, 401, { error: 'invalid_signature' });
        return sendJson(response, 200, bots.execute(platform, parseBotCommand(raw.text ?? '')));
      }
      if (request.method === 'POST' && url.pathname === '/api/auth/login') {
        const body = await readJson<{ email?: string }>(request);
        const token = createSessionToken('user_demo', config.sessionSecret);
        return sendJson(response, 200, { token, user: { id: 'user_demo', email: body.email ?? 'developer@kai.com' } });
      }
      const session = verifySessionToken(bearerToken(request) ?? '', config.sessionSecret);
      if (!session) return sendJson(response, 401, { error: 'unauthorized' });
      if (request.method === 'GET' && url.pathname === '/api/account') return sendJson(response, 200, accounts.getAccount());
      if (request.method === 'GET' && url.pathname === '/api/ledger') return sendJson(response, 200, accounts.getLedger());
      if (request.method === 'GET' && url.pathname === '/api/models') return sendJson(response, 200, gateway.listModels());
      if (request.method === 'GET' && url.pathname === '/api/products') return sendJson(response, 200, products.list());
      if (request.method === 'GET' && url.pathname === '/api/knowledge/search') return sendJson(response, 200, await knowledge.search(url.searchParams.get('q') ?? ''));
      if (request.method === 'GET' && url.pathname === '/api/devices') return sendJson(response, 200, sync.listDevices());
      if (request.method === 'POST' && url.pathname === '/api/devices') return sendJson(response, 201, sync.registerDevice(await readJson(request)));
      if (request.method === 'POST' && url.pathname.match(/^\/api\/devices\/[^/]+\/heartbeat$/)) return sendJson(response, 200, sync.heartbeat(url.pathname.split('/')[3]));
      if (request.method === 'GET' && url.pathname === '/api/tasks') return sendJson(response, 200, sync.listTasks());
      if (request.method === 'POST' && url.pathname === '/api/tasks') return sendJson(response, 201, sync.createTask(await readJson(request)));
      if (request.method === 'POST' && url.pathname.match(/^\/api\/tasks\/[^/]+\/status$/)) {
        const body = await readJson<{ status: Parameters<SyncStore['updateTask']>[1]; expectedVersion: number }>(request);
        return sendJson(response, 200, sync.updateTask(url.pathname.split('/')[3], body.status, body.expectedVersion));
      }
      if (request.method === 'GET' && url.pathname === '/api/events') return sendJson(response, 200, sync.eventsAfter(Number(url.searchParams.get('cursor') ?? 0)));
      if (request.method === 'POST' && url.pathname === '/api/topups') {
        const body = await readJson<Omit<TopupRequest, 'idempotencyKey'>>(request);
        const key = String(request.headers['idempotency-key'] ?? '');
        if (!key) return sendJson(response, 400, { error: 'idempotency-key is required' });
        const entry = accounts.topup({ ...body, idempotencyKey: key });
        return sendJson(response, 201, { entry, account: accounts.getAccount() });
      }
      if (request.method === 'POST' && url.pathname === '/api/usage') {
        const event = await readJson<UsageEvent>(request);
        const entry = accounts.recordUsage(event);
        return sendJson(response, 201, { entry, account: accounts.getAccount() });
      }
      if (request.method === 'POST' && url.pathname === '/v1/chat/completions') {
        const upstream = await gateway.proxyChat(await readJson(request));
        response.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
        response.end(Buffer.from(await upstream.arrayBuffer()));
        return;
      }
      return sendJson(response, 404, { error: 'not_found' });
    } catch (error) {
      return sendJson(response, 400, { error: error instanceof Error ? error.message : 'request_failed' });
    }
  });
}

if (process.env.NODE_ENV !== 'test') {
  const config = loadConfig();
  createControlPlane().listen(config.port, '127.0.0.1', () => {
    console.log(`COD control plane listening on http://127.0.0.1:${config.port}`);
  });
}
