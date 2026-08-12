import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

const maximumRequestBytes = 256 * 1024;
const maximumResponseBytes = 4 * 1024 * 1024;

export interface PetChatProxy {
  url: string;
  secret: string;
  close(): Promise<void>;
}

interface PetChatProxyOptions {
  controlPlaneUrl: string;
  token: string;
  sourceId: string;
  modelId: string;
  fetchImpl?: typeof fetch;
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maximumRequestBytes) throw new Error('REQUEST_TOO_LARGE');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function send(response: ServerResponse, status: number, body: string): void {
  if (response.writableEnded) return;
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(body);
}

function validCredential(value: string, maximumLength: number): boolean {
  return Boolean(value && value.length <= maximumLength && value.trim() === value && !/[\0\r\n]/.test(value));
}

export async function startPetChatProxy(options: PetChatProxyOptions): Promise<PetChatProxy> {
  const { controlPlaneUrl, token, sourceId, modelId, fetchImpl = fetch } = options;
  if (!validCredential(token, 8_192)) throw new Error('A valid COD session is required for desktop-pet chat');
  if (!/^[a-z0-9-]{2,40}$/.test(sourceId)) throw new Error('Desktop-pet model source is invalid');
  if (!validCredential(modelId, 200)) throw new Error('Desktop-pet model is invalid');
  const upstream = new URL('/v1/chat/completions', controlPlaneUrl);
  if (upstream.username || upstream.password || upstream.hash || (upstream.protocol !== 'https:'
    && !(upstream.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(upstream.hostname)))) {
    throw new Error('Desktop-pet chat requires HTTPS or a loopback development control plane');
  }
  const secret = randomBytes(32).toString('base64url');
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
        send(response, 404, '{"error":{"message":"Not found"}}');
        return;
      }
      if (request.headers.authorization !== `Bearer ${secret}`) {
        send(response, 401, '{"error":{"message":"Unauthorized"}}');
        return;
      }
      const contentType = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
      if (contentType !== 'application/json') {
        send(response, 415, '{"error":{"message":"JSON required"}}');
        return;
      }
      const body = JSON.parse((await readBody(request)).toString('utf8')) as Record<string, unknown>;
      if (!body || typeof body !== 'object' || Array.isArray(body) || !Array.isArray(body.messages)) {
        send(response, 400, '{"error":{"message":"Invalid chat request"}}');
        return;
      }
      const controller = new AbortController();
      const cancel = () => controller.abort();
      request.once('aborted', cancel);
      response.once('close', cancel);
      try {
        const upstreamResponse = await fetchImpl(upstream, {
          method: 'POST',
          headers: {
            accept: 'text/event-stream, application/json',
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            'x-request-id': randomBytes(16).toString('hex'),
          },
          body: JSON.stringify({
            ...body,
            source: sourceId,
            model: modelId,
            stream: body.stream === true,
            max_tokens: Math.min(4_096, Number.isInteger(body.max_tokens) ? Number(body.max_tokens) : 4_096),
          }),
          cache: 'no-store',
          credentials: 'omit',
          redirect: 'error',
          signal: controller.signal,
        });
        const payload = Buffer.from(await upstreamResponse.arrayBuffer());
        if (payload.length > maximumResponseBytes) {
          send(response, 502, '{"error":{"message":"Model response is too large"}}');
          return;
        }
        response.writeHead(upstreamResponse.status, {
          'content-type': upstreamResponse.headers.get('content-type') || 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        });
        response.end(payload);
      } finally {
        request.removeListener('aborted', cancel);
        response.removeListener('close', cancel);
      }
    } catch (error) {
      if (response.writableEnded || response.destroyed) return;
      const tooLarge = error instanceof Error && error.message === 'REQUEST_TOO_LARGE';
      send(response, tooLarge ? 413 : 502, `{"error":{"message":"${tooLarge ? 'Request is too large' : 'Desktop-pet chat unavailable'}"}}`);
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Desktop-pet chat proxy did not bind a loopback port');
  }
  return Object.freeze({
    url: `http://127.0.0.1:${address.port}/v1/chat/completions`,
    secret,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  });
}
