import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  cleanupAbandonedGooseSidecar,
  clearGooseOwnershipRecord,
  saveGooseOwnershipRecord,
} from '../dist/goose-ownership.js';

function ownershipRecord(root, overrides = {}) {
  return {
    version: 1,
    ownerPid: 41_001,
    sidecarPid: 41_002,
    executablePath: path.join(root, 'goose'),
    port: 32_840,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

test('writes a private ownership record and only clears the expected sidecar', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cod-goose-owner-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'state', 'goose-sidecar-owner.json');
  const record = ownershipRecord(root);
  await saveGooseOwnershipRecord(filePath, record);
  assert.deepEqual(JSON.parse(await fs.readFile(filePath, 'utf8')), record);
  if (process.platform !== 'win32') assert.equal((await fs.stat(filePath)).mode & 0o777, 0o600);

  await clearGooseOwnershipRecord(filePath, record.sidecarPid + 1);
  await fs.access(filePath);
  await clearGooseOwnershipRecord(filePath, record.sidecarPid);
  await assert.rejects(fs.access(filePath));
});

test('preserves a record owned by a live app instance', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cod-goose-live-owner-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'goose-sidecar-owner.json');
  const record = ownershipRecord(root);
  await saveGooseOwnershipRecord(filePath, record);
  let inspected = false;
  const result = await cleanupAbandonedGooseSidecar(filePath, {
    processExists: async (pid) => pid === record.ownerPid,
    inspectProcess: async () => { inspected = true; return null; },
    terminateProcess: async () => assert.fail('must not terminate a live owner sidecar'),
  });
  assert.equal(result, 'active-owner');
  assert.equal(inspected, false);
  await fs.access(filePath);
});

test('terminates an exactly identified abandoned sidecar and removes its record', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cod-goose-abandoned-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'goose-sidecar-owner.json');
  const record = ownershipRecord(root);
  await saveGooseOwnershipRecord(filePath, record);
  let inspections = 0;
  const terminated = [];
  const result = await cleanupAbandonedGooseSidecar(filePath, {
    processExists: async (pid) => pid === record.sidecarPid,
    inspectProcess: async () => {
      inspections += 1;
      return {
        executablePath: record.executablePath,
        commandLine: `${record.executablePath} serve --host 127.0.0.1 --port ${record.port} --with-builtin developer`,
      };
    },
    terminateProcess: async (pid) => { terminated.push(pid); },
  });
  assert.equal(result, 'terminated');
  assert.equal(inspections, 2);
  assert.deepEqual(terminated, [record.sidecarPid]);
  await assert.rejects(fs.access(filePath));
});

test('never kills a PID whose executable or command no longer matches', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cod-goose-reused-pid-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'goose-sidecar-owner.json');
  const record = ownershipRecord(root);
  await saveGooseOwnershipRecord(filePath, record);
  let terminated = false;
  const result = await cleanupAbandonedGooseSidecar(filePath, {
    processExists: async (pid) => pid === record.sidecarPid,
    inspectProcess: async () => ({ executablePath: '/bin/sleep', commandLine: '/bin/sleep 60' }),
    terminateProcess: async () => { terminated = true; },
  });
  assert.equal(result, 'discarded');
  assert.equal(terminated, false);
  await assert.rejects(fs.access(filePath));
});

test('discards malformed and oversized ownership records without inspecting a process', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cod-goose-invalid-owner-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'goose-sidecar-owner.json');
  let inspected = false;
  const adapters = {
    processExists: async () => { inspected = true; return true; },
    inspectProcess: async () => { inspected = true; return null; },
    terminateProcess: async () => { inspected = true; },
  };
  await fs.writeFile(filePath, '{not-json');
  assert.equal(await cleanupAbandonedGooseSidecar(filePath, adapters), 'discarded');
  await fs.writeFile(filePath, 'x'.repeat(16 * 1024 + 1));
  assert.equal(await cleanupAbandonedGooseSidecar(filePath, adapters), 'discarded');
  if (process.platform !== 'win32') {
    const outside = path.join(root, 'outside-record');
    await fs.writeFile(outside, 'must remain unchanged', { mode: 0o644 });
    await fs.symlink(outside, filePath);
    assert.equal(await cleanupAbandonedGooseSidecar(filePath, adapters), 'discarded');
    assert.equal(await fs.readFile(outside, 'utf8'), 'must remain unchanged');
    assert.equal((await fs.stat(outside)).mode & 0o777, 0o644);
  }
  assert.equal(inspected, false);
});
