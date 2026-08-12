import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { enforceAcpCwdPolicy } from '../dist/acp-cwd-policy.js';

const root = path.resolve('test-fixtures', 'approved-project');

function sessionNew(cwd = root) {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'session/new',
    params: { cwd, mcpServers: [] },
  };
}

test('accepts session/new for the bound root and rewrites cwd canonically', () => {
  const input = JSON.stringify(sessionNew(`${root}${path.sep}`));
  const output = JSON.parse(enforceAcpCwdPolicy(input, root));

  assert.equal(output.params.cwd, root);
  assert.deepEqual(output.params.mcpServers, []);
});

test('rejects parent traversal and a different absolute cwd', () => {
  const escaped = path.join(root, '..', 'outside-project');
  const otherAbsolute = path.resolve('test-fixtures', 'another-project');

  assert.throws(
    () => enforceAcpCwdPolicy(JSON.stringify(sessionNew(escaped)), root),
    /not permitted/,
  );
  assert.throws(
    () => enforceAcpCwdPolicy(JSON.stringify(sessionNew(otherAbsolute)), root),
    /not permitted/,
  );
});

test('rejects JSON-RPC batches instead of changing ACP frame semantics', () => {
  const batch = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } },
    sessionNew(`${root}${path.sep}.`),
    { jsonrpc: '2.0', id: 2, result: { ok: true } },
  ];
  assert.throws(() => enforceAcpCwdPolicy(JSON.stringify(batch), root), /Invalid ACP JSON-RPC frame/);
});

test('rejects malformed JSON, non-object frames, and empty batches', () => {
  for (const input of ['{', 'null', '42', '"request"', '[]', '[null]']) {
    assert.throws(() => enforceAcpCwdPolicy(input, root), /Invalid ACP JSON-RPC frame/);
  }
});

test('rejects session/new without an object params and non-empty string cwd', () => {
  const missingParams = { jsonrpc: '2.0', id: 1, method: 'session/new' };
  const missingCwd = { ...missingParams, params: {} };
  const wrongCwdType = { ...missingParams, params: { cwd: 123 } };
  const emptyCwd = { ...missingParams, params: { cwd: '' } };
  const arrayParams = { ...missingParams, params: [{ cwd: root }] };
  const missingMcpServers = { ...missingParams, params: { cwd: root } };

  for (const frame of [missingParams, missingCwd, wrongCwdType, emptyCwd, arrayParams, missingMcpServers]) {
    assert.throws(
      () => enforceAcpCwdPolicy(JSON.stringify(frame), root),
      /Invalid ACP JSON-RPC frame/,
    );
  }
});

test('rejects MCP servers, extra workspace roots, and unsupported Agent operations', () => {
  for (const frame of [
    { ...sessionNew(), params: { cwd: root, mcpServers: [{ name: 'escape', command: 'sh' }] } },
    { ...sessionNew(), params: { cwd: root, mcpServers: [], additionalDirectories: [path.dirname(root)] } },
    { ...sessionNew(), params: { cwd: root, mcpServers: [], additionalDirectories: 'wrong' } },
  ]) assert.throws(() => enforceAcpCwdPolicy(JSON.stringify(frame), root), /not permitted|Invalid ACP/);

  for (const method of ['session/load', 'session/fork', 'session/resume', 'session/list', 'session/set_model', 'authenticate', 'nes/start']) {
    assert.throws(
      () => enforceAcpCwdPolicy(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { cwd: root } }), root),
      /not permitted/,
    );
  }
});

test('passes through other structurally valid JSON-RPC objects', () => {
  const frame = {
    jsonrpc: '2.0',
    id: 8,
    method: 'session/prompt',
    params: { sessionId: 's1', cwd: path.join(root, '..', 'ignored') },
  };

  assert.deepEqual(JSON.parse(enforceAcpCwdPolicy(JSON.stringify(frame), root)), frame);
});
