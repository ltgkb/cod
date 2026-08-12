import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveCommandInvocation } from '../dist/platform-command.js';

test('launches native commands directly on every desktop platform', () => {
  assert.deepEqual(resolveCommandInvocation('git', ['status'], 'win32'), { executable: 'git', args: ['status'] });
  assert.deepEqual(resolveCommandInvocation('node', ['scripts/check.mjs'], 'linux'), { executable: 'node', args: ['scripts/check.mjs'] });
});

test('uses the Windows command processor only for fixed package-manager shims', () => {
  const invocation = resolveCommandInvocation('npm', ['run', 'test suite', '--', '--watch=false'], 'win32', {
    SystemRoot: 'D:\\Windows',
  });
  assert.equal(invocation.executable, 'D:\\Windows\\System32\\cmd.exe');
  assert.deepEqual(invocation.args, ['/d', '/s', '/v:off', '/c', 'npm "run" "test suite" "--" "--watch=false"']);
  assert.throws(() => resolveCommandInvocation('pnpm', ['test&whoami'], 'win32'), /shell metacharacters/);
  assert.throws(() => resolveCommandInvocation('npm', ['%PATH%'], 'win32'), /shell metacharacters/);
});
