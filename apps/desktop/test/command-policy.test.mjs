import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  commandPathCandidates,
  commandPolicyViolation,
  isWithinRoot,
  parseCommand,
  validateCommandPath,
} from '../dist/command-policy.js';

test('parses quoted arguments without invoking a shell', () => {
  assert.deepEqual(parseCommand('npm run test -- --name "hello world"'), ['npm', 'run', 'test', '--', '--name', 'hello world']);
  assert.deepEqual(parseCommand('node C:\\workspace\\check.mjs'), ['node', 'C:\\workspace\\check.mjs']);
  assert.throws(() => parseCommand('npm run "unfinished'), /unfinished quote/);
  assert.throws(() => parseCommand('npm test\nnode bad.js'), /control characters/);
  for (const command of [
    'git status --short && echo unsafe',
    'git status; echo unsafe',
    'git status | tee status.txt',
    'node $(pwd)/script.mjs',
    'node `pwd`/script.mjs',
  ]) assert.throws(() => parseCommand(command), /Shell operators/, command);
});

test('blocks inline Node evaluation but permits project scripts', () => {
  for (const args of [['-e', 'code'], ['-p', 'code'], ['--eval=code'], ['--print=code'], ['-eprocess.exit()']]) {
    assert.match(commandPolicyViolation('node', args) ?? '', /evaluation/);
  }
  assert.notEqual(commandPolicyViolation('node', ['--run=test']), null);
  assert.notEqual(commandPolicyViolation('node', ['--import=data:text/javascript,console.log(1)', 'script.mjs']), null);
  assert.equal(commandPolicyViolation('node', ['scripts/check.mjs']), null);
});

test('blocks package-manager command execution shortcuts but keeps normal build and test commands', () => {
  for (const args of [
    ['exec', '--', 'sh'],
    ['exec', '-c', 'sh'],
    ['--call=sh'],
    ['explore', 'dependency', '--', 'sh'],
  ]) assert.notEqual(commandPolicyViolation('npm', args), null, args.join(' '));
  for (const args of [['exec', 'sh'], ['dlx', 'package'], ['create', 'project']]) {
    assert.notEqual(commandPolicyViolation('pnpm', args), null, args.join(' '));
  }
  assert.equal(commandPolicyViolation('npm', ['test']), null);
  assert.equal(commandPolicyViolation('npm', ['run', 'build']), null);
  assert.equal(commandPolicyViolation('pnpm', ['test']), null);
});

test('blocks Git redirection and destructive working-tree operations', () => {
  for (const args of [
    ['-C', '/tmp', 'status'],
    ['-C/tmp', 'status'],
    ['-c', 'alias.escape=!sh', 'escape'],
    ['--git-dir=/tmp/repo', 'status'],
    ['--work-tree', '/tmp', 'diff'],
    ['checkout', '.'],
    ['restore', '.'],
    ['reset', '--hard'],
    ['clean', '-fdx'],
    ['rm', 'file.txt'],
    ['branch', '-D', 'feature'],
    ['branch', '-f', 'feature', 'HEAD~1'],
    ['tag', '--delete', 'v1.0.0'],
    ['push', '--force-with-lease'],
    ['push', '--prune'],
    ['difftool', '--extcmd', 'sh'],
    ['diff', '--ext-diff'],
    ['grep', '--open-files-in-pager=sh'],
  ]) assert.notEqual(commandPolicyViolation('git', args), null, args.join(' '));
  assert.equal(commandPolicyViolation('git', ['status', '--short']), null);
  assert.equal(commandPolicyViolation('git', ['diff', '--', 'src']), null);
  assert.equal(commandPolicyViolation('git', ['--no-pager', 'log', '-1']), null);
});

test('extracts explicit and positional command paths', () => {
  assert.deepEqual(commandPathCandidates('node', ['scripts/check.mjs']), ['scripts/check.mjs']);
  assert.ok(commandPathCandidates('npm', ['test', '--prefix=../outside']).includes('../outside'));
  assert.ok(commandPathCandidates('pnpm', ['--dir', '/tmp/project', 'test']).includes('/tmp/project'));
  assert.ok(commandPathCandidates('git', ['diff', '--', '../../secret']).includes('../../secret'));
  assert.ok(commandPathCandidates('just', ['-f../outside/justfile']).includes('../outside/justfile'));
});

test('enforces the approved root lexically', () => {
  assert.equal(isWithinRoot('/workspace/project', '/workspace/project/src/index.ts'), true);
  assert.equal(isWithinRoot('/workspace/project', '/workspace/project-other/index.ts'), false);
  assert.equal(isWithinRoot('/workspace/project', '/workspace/secret.txt'), false);
});

test('rejects traversal and symlink escapes through existing path ancestors', async (context) => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'cod-command-policy-'));
  context.after(() => fs.rm(fixture, { recursive: true, force: true }));
  const root = path.join(fixture, 'project');
  const outside = path.join(fixture, 'outside');
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.mkdir(outside);
  await fs.symlink(outside, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');

  await validateCommandPath(root, 'src/new-file.ts');
  await assert.rejects(validateCommandPath(root, '../outside/secret.txt'), /outside/);
  await assert.rejects(validateCommandPath(root, 'escape/new-file.txt'), /escapes/);
  await assert.rejects(validateCommandPath(root, 'file:///tmp/secret.txt'), /File URLs/);
});
