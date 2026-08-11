import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadApprovedProjectRoots, saveApprovedProjectRoots } from '../dist/project-roots.js';

test('persists a bounded root list with private permissions and restores only directories', async (context) => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'cod-project-roots-'));
  context.after(() => fs.rm(fixture, { recursive: true, force: true }));
  const settingsFile = path.join(fixture, 'settings', 'approved-project-roots.json');
  const first = path.join(fixture, 'first');
  const second = path.join(fixture, 'second');
  const plainFile = path.join(fixture, 'not-a-directory');
  await fs.mkdir(first);
  await fs.mkdir(second);
  await fs.writeFile(plainFile, 'file');

  await saveApprovedProjectRoots(settingsFile, ['/missing', first, plainFile, second], 3);
  const stored = JSON.parse(await fs.readFile(settingsFile, 'utf8'));
  assert.deepEqual(stored, { version: 1, roots: [first, plainFile, second] });
  if (process.platform !== 'win32') assert.equal((await fs.stat(settingsFile)).mode & 0o777, 0o600);
  assert.deepEqual(await loadApprovedProjectRoots(settingsFile, 3), [await fs.realpath(first), await fs.realpath(second)]);

  await saveApprovedProjectRoots(settingsFile, [second], 3);
  assert.deepEqual(await loadApprovedProjectRoots(settingsFile, 3), [await fs.realpath(second)]);
});

test('rejects malformed or oversized approval files', async (context) => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'cod-project-roots-invalid-'));
  context.after(() => fs.rm(fixture, { recursive: true, force: true }));
  const settingsFile = path.join(fixture, 'roots.json');
  await fs.writeFile(settingsFile, '{not-json');
  assert.deepEqual(await loadApprovedProjectRoots(settingsFile), []);
  await fs.writeFile(settingsFile, 'x'.repeat(128 * 1024 + 1));
  assert.deepEqual(await loadApprovedProjectRoots(settingsFile), []);
});
