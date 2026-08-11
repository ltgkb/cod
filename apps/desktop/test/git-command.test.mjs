import assert from 'node:assert/strict';
import os from 'node:os';
import test from 'node:test';

import { commandTimedOut, executeGitCommand } from '../dist/git-command.js';

test('kills a Git subprocess that stops responding', async () => {
  const startedAt = Date.now();
  const error = await executeGitCommand(os.tmpdir(), ['-e', 'setInterval(() => undefined, 1000)'], {
    executable: process.execPath,
    maxBuffer: 64 * 1024,
    timeoutMilliseconds: 50,
  }).then(() => null, (reason) => reason);

  assert.equal(commandTimedOut(error), true);
  assert.ok(Date.now() - startedAt < 2_000);
});
