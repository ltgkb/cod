import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { startPetChatProxy } from '../dist/pet-chat-proxy.js';

async function fakeControlPlane() {
  let received = null;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received = {
      authorization: request.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
    };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    received: () => received,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('keeps the COD token in the proxy and pins the selected source and model', async () => {
  const upstream = await fakeControlPlane();
  const proxy = await startPetChatProxy({
    controlPlaneUrl: upstream.url,
    token: 'cod-user-token',
    sourceId: 'ai-kai',
    modelId: 'model-approved',
  });
  try {
    const unauthorized = await fetch(proxy.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(unauthorized.status, 401);
    const response = await fetch(proxy.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${proxy.secret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'attacker', model: 'attacker', messages: [{ role: 'user', content: 'hello' }], stream: false }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).choices[0].message.content, 'ok');
    assert.equal(upstream.received().authorization, 'Bearer cod-user-token');
    assert.equal(upstream.received().body.source, 'ai-kai');
    assert.equal(upstream.received().body.model, 'model-approved');
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('rejects unsafe control-plane and launch credentials', async () => {
  await assert.rejects(startPetChatProxy({ controlPlaneUrl: 'http://cod.example', token: 'token', sourceId: 'ai-kai', modelId: 'model' }), /HTTPS or a loopback/);
  await assert.rejects(startPetChatProxy({ controlPlaneUrl: 'https://cod.example', token: 'bad\ntoken', sourceId: 'ai-kai', modelId: 'model' }), /valid COD session/);
});
