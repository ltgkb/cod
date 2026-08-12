'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

function loadSessionStore(secureStore) {
  const filename = path.resolve(__dirname, '../src/session-store.ts');
  const source = fs.readFileSync(filename, 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { esModuleInterop: true, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: filename,
  }).outputText;
  const module = { exports: {} };
  const localRequire = (specifier) => {
    if (specifier === 'expo-secure-store') return secureStore;
    throw new Error(`Unexpected import: ${specifier}`);
  };
  vm.runInNewContext(compiled, { module, exports: module.exports, require: localRequire }, { filename });
  return module.exports;
}

function secureStoreMock(initial = null) {
  let value = initial;
  const calls = [];
  const store = {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1234,
    isAvailableAsync: async () => true,
    getItemAsync: async (key, options) => { calls.push(['get', key, options]); return value; },
    setItemAsync: async (key, next, options) => { calls.push(['set', key, options]); value = next; },
    deleteItemAsync: async (key, options) => { calls.push(['delete', key, options]); value = null; },
  };
  return { store, calls, value: () => value };
}

function parseStoredRecord(mock) {
  return JSON.parse(mock.value());
}

test('stores a versioned token record with the fixed service and strongest silent iOS accessibility', async () => {
  const mock = secureStoreMock();
  const sessionStore = loadSessionStore(mock.store);
  await sessionStore.saveSessionToken('valid-session');
  assert.equal(await sessionStore.loadSessionToken(), 'valid-session');
  assert.deepEqual(parseStoredRecord(mock), { version: 1, state: 'token', token: 'valid-session' });
  const options = mock.calls.find(([kind]) => kind === 'set')[2];
  assert.equal(options.keychainService, 'com.kai.cod.session.v1');
  assert.equal(options.keychainAccessible, mock.store.WHEN_UNLOCKED_THIS_DEVICE_ONLY);
  assert.equal(options.requireAuthentication, false);
  assert.ok(mock.calls.every(([, key]) => key === 'cod.session.v1'));
  assert.equal(mock.calls.some(([kind]) => kind === 'delete'), false);
});

test('serializes secure-store writes and preserves the most recent token record', async () => {
  const mock = secureStoreMock();
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  let writes = 0;
  let value = null;
  mock.store.setItemAsync = async (_key, next) => {
    writes += 1;
    if (writes === 1) await firstGate;
    value = next;
  };
  mock.store.getItemAsync = async () => value;
  const sessionStore = loadSessionStore(mock.store);
  const first = sessionStore.saveSessionToken('first-session');
  const second = sessionStore.saveSessionToken('second-session');
  for (let attempt = 0; attempt < 10 && writes === 0; attempt += 1) await Promise.resolve();
  assert.equal(writes, 1);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(JSON.parse(value), { version: 1, state: 'token', token: 'second-session' });
});

test('uses compare-and-set so a stale clear cannot replace a newer session with a logout tombstone', async () => {
  const mock = secureStoreMock('new.session');
  const sessionStore = loadSessionStore(mock.store);
  assert.equal(await sessionStore.clearSessionToken('old.session'), false);
  assert.equal(await sessionStore.loadSessionToken(), 'new.session');
  assert.deepEqual(parseStoredRecord(mock), { version: 1, state: 'token', token: 'new.session' });
  assert.equal(await sessionStore.clearSessionToken('new.session'), true);
  assert.deepEqual(parseStoredRecord(mock), { version: 1, state: 'logout' });
  assert.equal(await sessionStore.loadSessionCleanupPending(), true);
  assert.equal(await sessionStore.loadSessionToken(), null);
});

test('keeps a logout tombstone across module restarts instead of treating a missing key as logout', async () => {
  const mock = secureStoreMock(JSON.stringify({ version: 1, state: 'token', token: 'old-session' }));
  await loadSessionStore(mock.store).clearSessionToken('old-session');
  const restartedSessionStore = loadSessionStore(mock.store);
  assert.equal(await restartedSessionStore.loadSessionCleanupPending(), true);
  assert.equal(await restartedSessionStore.loadSessionToken(), null);
  assert.deepEqual(parseStoredRecord(mock), { version: 1, state: 'logout' });
});

test('migrates a valid legacy raw token into the versioned record', async () => {
  const mock = secureStoreMock('legacy.session');
  const sessionStore = loadSessionStore(mock.store);
  assert.equal(await sessionStore.loadSessionCleanupPending(), false);
  assert.equal(await sessionStore.loadSessionToken(), 'legacy.session');
  assert.deepEqual(parseStoredRecord(mock), { version: 1, state: 'token', token: 'legacy.session' });
});

test('fails closed by replacing a malformed versioned record with a logout tombstone', async () => {
  const mock = secureStoreMock(JSON.stringify({ version: 1, state: 'token', token: 'line\nbreak' }));
  const sessionStore = loadSessionStore(mock.store);
  assert.equal(await sessionStore.loadSessionCleanupPending(), true);
  assert.deepEqual(parseStoredRecord(mock), { version: 1, state: 'logout' });
});

test('never downgrades parseable JSON from an unknown record version into a legacy bearer token', async () => {
  for (const value of [JSON.stringify({ version: 2, state: 'logout' }), '{}', '[]']) {
    const mock = secureStoreMock(value);
    const sessionStore = loadSessionStore(mock.store);
    assert.equal(await sessionStore.loadSessionCleanupPending(), true);
    assert.deepEqual(parseStoredRecord(mock), { version: 1, state: 'logout' });
  }
});

test('rejects invalid tokens without writing their value', async () => {
  const mock = secureStoreMock();
  const sessionStore = loadSessionStore(mock.store);
  await assert.rejects(sessionStore.saveSessionToken('line\nbreak'), /invalid/);
  assert.equal(mock.calls.some(([kind]) => kind === 'set'), false);
});
