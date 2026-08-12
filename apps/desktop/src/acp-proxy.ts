import { randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { enforceAcpCwdPolicy } from './acp-cwd-policy.js';

const maximumFrameBytes = 4 * 1024 * 1024;
const maximumQueuedFrames = 16;

export interface AcpProxy {
  url: string;
  close(): Promise<void>;
}

export interface AcpProxyOptions {
  allowedOrigins: readonly string[];
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === '::1' || hostname === 'localhost';
}

function validateUpstreamUrl(rawUrl: string): URL {
  const upstream = new URL(rawUrl);
  if ((upstream.protocol !== 'ws:' && upstream.protocol !== 'wss:')
    || upstream.username
    || upstream.password
    || upstream.hash
    || (upstream.protocol === 'ws:' && !isLoopbackHostname(upstream.hostname))) {
    throw new Error('ACP upstream must be loopback WebSocket or secure WebSocket');
  }
  return upstream;
}

function hasExpectedToken(candidate: string | null, expected: string): boolean {
  if (!candidate) return false;
  const candidateBytes = Buffer.from(candidate);
  const expectedBytes = Buffer.from(expected);
  return candidateBytes.length === expectedBytes.length && timingSafeEqual(candidateBytes, expectedBytes);
}

function rejectConnection(socket: WebSocket, code = 1008): void {
  if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
    socket.close(code, 'ACP proxy rejected connection');
  }
}

function closePeer(socket: WebSocket): void {
  if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close();
}

function rawText(data: RawData): string {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return data.toString('utf8');
}

/**
 * Put a capability-token loopback proxy between the sandboxed renderer and
 * Goose. The renderer never learns Goose's own secret, and every session/new
 * frame is bound to the main process's approved real project root.
 */
export async function startAcpProxy(
  rawUpstreamUrl: string,
  boundRealRoot: string,
  options: AcpProxyOptions,
): Promise<AcpProxy> {
  const upstreamUrl = validateUpstreamUrl(rawUpstreamUrl);
  if (!path.isAbsolute(boundRealRoot)) throw new Error('ACP project root must be absolute');
  if (!Array.isArray(options.allowedOrigins) || options.allowedOrigins.length === 0
    || options.allowedOrigins.some((origin) => typeof origin !== 'string' || !origin)) {
    throw new Error('ACP proxy requires a trusted renderer origin');
  }
  const allowedOrigins = new Set(options.allowedOrigins);
  const proxyToken = randomBytes(32).toString('base64url');
  const proxyPath = `/acp/${randomBytes(18).toString('base64url')}`;
  let activeClient: WebSocket | null = null;
  let closed = false;
  const upstreamSockets = new Set<WebSocket>();

  let server!: WebSocketServer;
  server = new WebSocketServer({
    host: '127.0.0.1',
    port: 0,
    path: proxyPath,
    clientTracking: true,
    perMessageDeflate: false,
    maxPayload: maximumFrameBytes,
    verifyClient: ({ req }, done) => {
      try {
        const address = server.address();
        const expectedHost = address && typeof address !== 'string' ? `127.0.0.1:${address.port}` : '';
        const requestUrl = new URL(req.url ?? '', 'ws://127.0.0.1');
        const tokens = requestUrl.searchParams.getAll('token');
        const remoteAddress = req.socket.remoteAddress;
        const valid = req.method === 'GET'
          && req.headers.host === expectedHost
          && (remoteAddress === '127.0.0.1' || remoteAddress === '::ffff:127.0.0.1')
          && typeof req.headers.origin === 'string'
          && allowedOrigins.has(req.headers.origin)
          && req.headers['sec-websocket-protocol'] === undefined
          && requestUrl.pathname === proxyPath
          && [...requestUrl.searchParams.keys()].every((key) => key === 'token')
          && tokens.length === 1
          && hasExpectedToken(tokens[0] ?? null, proxyToken);
        done(valid, valid ? undefined : 401, valid ? undefined : 'Unauthorized');
      } catch {
        done(false, 400, 'Bad Request');
      }
    },
  });

  await new Promise<void>((resolve, reject) => {
    const handleError = (error: Error) => {
      server.off('listening', handleListening);
      reject(error);
    };
    const handleListening = () => {
      server.off('error', handleError);
      resolve();
    };
    server.once('error', handleError);
    server.once('listening', handleListening);
  });
  // A late listener prevents a transient server error from becoming an
  // uncaught EventEmitter exception after the initial listen has succeeded.
  server.on('error', () => undefined);

  server.on('connection', (client) => {
    if (closed || activeClient) {
      rejectConnection(client);
      return;
    }
    activeClient = client;
    const upstream = new WebSocket(upstreamUrl, {
      perMessageDeflate: false,
      maxPayload: maximumFrameBytes,
      handshakeTimeout: 5_000,
      followRedirects: false,
    });
    upstreamSockets.add(upstream);
    const queuedFrames: string[] = [];
    let queuedBytes = 0;
    let sessionCreationStarted = false;
    let pendingSessionRequestId: string | number | null = null;
    let boundSessionId: string | null = null;

    const rejectFrame = (code = 1008) => {
      rejectConnection(client, code);
      closePeer(upstream);
    };

    const validateRendererSession = (frame: string) => {
      const message = JSON.parse(frame) as Record<string, unknown>;
      if (message.method === 'session/new') {
        if (sessionCreationStarted || (typeof message.id !== 'string' && typeof message.id !== 'number')) {
          throw new Error('ACP session creation is invalid');
        }
        sessionCreationStarted = true;
        pendingSessionRequestId = message.id;
        return;
      }
      if (message.method === 'session/prompt' || message.method === 'session/cancel') {
        const params = message.params;
        if (!params || typeof params !== 'object' || Array.isArray(params)
          || typeof (params as Record<string, unknown>).sessionId !== 'string'
          || (params as Record<string, unknown>).sessionId !== boundSessionId) {
          throw new Error('ACP session identifier is not permitted');
        }
      }
    };

    const captureBoundSession = (frame: string) => {
      const message = JSON.parse(frame) as Record<string, unknown>;
      if (pendingSessionRequestId === null || message.id !== pendingSessionRequestId) return;
      pendingSessionRequestId = null;
      const result = message.result;
      if (result && typeof result === 'object' && !Array.isArray(result)) {
        const sessionId = (result as Record<string, unknown>).sessionId;
        if (typeof sessionId === 'string' && sessionId) boundSessionId = sessionId;
      }
    };

    client.on('message', (data, isBinary) => {
      if (isBinary) {
        rejectFrame(1003);
        return;
      }
      try {
        const rendererText = rawText(data);
        try { JSON.parse(rendererText); } catch { rejectFrame(1007); return; }
        const frame = enforceAcpCwdPolicy(rendererText, boundRealRoot);
        validateRendererSession(frame);
        const frameBytes = Buffer.byteLength(frame);
        if (frameBytes > maximumFrameBytes) throw new Error('ACP frame is too large');
        if (upstream.readyState === WebSocket.OPEN) {
          upstream.send(frame, { binary: false });
          return;
        }
        if (upstream.readyState !== WebSocket.CONNECTING
          || queuedFrames.length >= maximumQueuedFrames
          || queuedBytes + frameBytes > maximumFrameBytes) {
          throw new Error('ACP upstream is unavailable');
        }
        queuedFrames.push(frame);
        queuedBytes += frameBytes;
      } catch {
        rejectFrame();
      }
    });

    upstream.on('open', () => {
      for (const frame of queuedFrames) upstream.send(frame, { binary: false });
      queuedFrames.length = 0;
      queuedBytes = 0;
    });
    upstream.on('message', (data, isBinary) => {
      if (isBinary) {
        rejectFrame(1003);
        return;
      }
      try {
        const frame = rawText(data);
        captureBoundSession(frame);
        if (client.readyState === WebSocket.OPEN) client.send(frame, { binary: false });
      } catch {
        rejectFrame(1011);
      }
    });
    upstream.on('error', () => rejectConnection(client));
    upstream.on('close', () => {
      upstreamSockets.delete(upstream);
      closePeer(client);
    });
    client.on('error', () => closePeer(upstream));
    client.on('close', () => {
      if (activeClient === client) activeClient = null;
      closePeer(upstream);
    });
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error('ACP proxy did not bind a loopback port');
  }

  return {
    url: `ws://127.0.0.1:${address.port}${proxyPath}?token=${encodeURIComponent(proxyToken)}`,
    async close() {
      if (closed) return;
      closed = true;
      activeClient = null;
      for (const socket of server.clients) socket.terminate();
      for (const socket of upstreamSockets) socket.terminate();
      upstreamSockets.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
