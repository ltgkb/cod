import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { WebSocket, WebSocketServer } from 'ws';
import { startAcpProxy } from '../dist/acp-proxy.js';

function once(target, event) {
  return new Promise((resolve, reject) => {
    const handleError = (error) => {
      target.off(event, handleEvent);
      reject(error);
    };
    const handleEvent = (...args) => {
      target.off('error', handleError);
      resolve(args);
    };
    target.once('error', handleError);
    target.once(event, handleEvent);
  });
}

async function fakeUpstream(context) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, path: '/acp' });
  await once(server, 'listening');
  context.after(() => new Promise((resolve) => {
    for (const client of server.clients) client.terminate();
    server.close(resolve);
  }));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { server, url: `ws://127.0.0.1:${address.port}/acp?token=upstream-secret` };
}

test('keeps the upstream secret private and canonicalizes session/new before forwarding', async (context) => {
  const root = path.resolve('test-fixtures', 'approved-project');
  const upstream = await fakeUpstream(context);
  const received = [];
  upstream.server.on('connection', (socket) => socket.on('message', (data, isBinary) => {
    assert.equal(isBinary, false);
    const frame = JSON.parse(data.toString());
    received.push(frame);
    if (frame.method === 'session/new') socket.send(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: { sessionId: 'bound-session' } }));
  }));
  const proxy = await startAcpProxy(upstream.url, root, { allowedOrigins: ['https://renderer.example'] });
  context.after(() => proxy.close());

  assert.doesNotMatch(proxy.url, /upstream-secret/);
  const client = new WebSocket(proxy.url, { origin: 'https://renderer.example' });
  context.after(() => client.terminate());
  await once(client, 'open');
  client.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: `${root}${path.sep}.`, mcpServers: [] } }));

  const [response, isBinary] = await once(client, 'message');
  assert.equal(isBinary, false);
  assert.equal(JSON.parse(response.toString()).result.sessionId, 'bound-session');
  client.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId: 'bound-session', prompt: [] } }));

  for (let attempt = 0; received.length < 2 && attempt < 50; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(received.length, 2);
  assert.equal(received[0].params.cwd, root);
});

test('rejects the wrong proxy token and closes cwd-escape frames before forwarding', async (context) => {
  const root = path.resolve('test-fixtures', 'approved-project');
  const upstream = await fakeUpstream(context);
  let forwarded = 0;
  upstream.server.on('connection', (socket) => socket.on('message', () => { forwarded += 1; }));
  const proxy = await startAcpProxy(upstream.url, root, { allowedOrigins: ['https://renderer.example'] });
  context.after(() => proxy.close());

  const invalidUrl = new URL(proxy.url);
  invalidUrl.searchParams.set('token', 'wrong-token');
  const unauthorized = new WebSocket(invalidUrl, { origin: 'https://renderer.example' });
  await assert.rejects(once(unauthorized, 'open'));

  const wrongOrigin = new WebSocket(proxy.url, { origin: 'https://attacker.example' });
  await assert.rejects(once(wrongOrigin, 'open'));

  const client = new WebSocket(proxy.url, { origin: 'https://renderer.example' });
  context.after(() => client.terminate());
  await once(client, 'open');
  client.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: path.join(root, '..', 'escape'), mcpServers: [] } }));
  const [code] = await once(client, 'close');
  assert.equal(code, 1008);
  assert.equal(forwarded, 0);
});

test('binds prompt and cancel messages to the session created on the same connection', async (context) => {
  const root = path.resolve('test-fixtures', 'approved-project');
  const upstream = await fakeUpstream(context);
  upstream.server.on('connection', (socket) => socket.on('message', (data) => {
    const frame = JSON.parse(data.toString());
    if (frame.method === 'session/new') socket.send(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: { sessionId: 'only-session' } }));
  }));
  const proxy = await startAcpProxy(upstream.url, root, { allowedOrigins: ['https://renderer.example'] });
  context.after(() => proxy.close());
  const client = new WebSocket(proxy.url, { origin: 'https://renderer.example' });
  context.after(() => client.terminate());
  await once(client, 'open');
  client.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: root, mcpServers: [] } }));
  await once(client, 'message');
  client.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId: 'old-or-guessed-session', prompt: [] } }));
  const [code] = await once(client, 'close');
  assert.equal(code, 1008);
});
