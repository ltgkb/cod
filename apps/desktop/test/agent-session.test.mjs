import assert from 'node:assert/strict';
import test from 'node:test';
import { mintAgentSession } from '../dist/agent-session.js';

const config = {
  token: 'full-session-secret-for-test',
  taskId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  executionId: '11111111-2222-4333-8444-555555555555',
  leaseToken: 'L'.repeat(43),
  sourceId: 'ai-kai',
  modelId: 'glm-5.2',
  root: '/approved/project',
};

function successfulResponse(overrides = {}) {
  return new Response(JSON.stringify({
    token: 'short-scoped-agent-token',
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    scope: { taskId: config.taskId, executionId:config.executionId, sourceId: config.sourceId, model: config.modelId },
    ...overrides,
  }), { status: 201, headers: { 'content-type': 'application/json' } });
}

test('mints a scoped token without putting the full session in the request body', async () => {
  let capturedUrl = '';
  let capturedInit;
  const mockFetch = async (input, init) => {
    capturedUrl = String(input);
    capturedInit = init;
    return successfulResponse();
  };

  const result = await mintAgentSession(new URL('https://cod.example/internal/'), config, mockFetch);
  assert.equal(result.token, 'short-scoped-agent-token');
  assert.ok(result.expiresAt > Date.now() + 59 * 60_000);
  assert.equal(capturedUrl, 'https://cod.example/internal/api/agent-sessions');
  assert.equal(capturedInit.method, 'POST');
  assert.equal(capturedInit.redirect, 'error');
  assert.equal(capturedInit.headers.authorization, `Bearer ${config.token}`);
  assert.deepEqual(JSON.parse(capturedInit.body), { taskId: config.taskId, executionId:config.executionId, leaseToken:config.leaseToken, sourceId: config.sourceId, model: config.modelId });
  assert.doesNotMatch(capturedInit.body, new RegExp(config.token));
  assert.doesNotMatch(capturedInit.body, new RegExp(config.root));
});

test('rejects a response whose scope or expiration does not match the request', async () => {
  await assert.rejects(
    mintAgentSession(new URL('https://cod.example'), config, async () => successfulResponse({ scope: { taskId: config.taskId, executionId:config.executionId, sourceId: 'other', model: config.modelId } })),
    /权限范围/,
  );
  await assert.rejects(
    mintAgentSession(new URL('https://cod.example'), config, async () => successfulResponse({ expiresAt: new Date(Date.now() + 5_000).toISOString() })),
    /有效期/,
  );
});

test('returns explicit safe errors for authorization and endpoint failures', async () => {
  await assert.rejects(
    mintAgentSession(new URL('https://cod.example'), config, async () => new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })),
    /重新登录/,
  );
  await assert.rejects(
    mintAgentSession(new URL('https://cod.example'), config, async () => new Response('proxy html', { status: 404, headers: { 'content-type': 'text/html' } })),
    /尚未部署/,
  );
});
