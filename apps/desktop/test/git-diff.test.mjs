import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import {
  collectUntrackedDiff,
  stagedGitDiffArguments,
  unstagedGitDiffArguments,
  untrackedGitDiffArguments,
} from '../dist/git-diff.js';

const execFileAsync = promisify(execFile);

test('disables external diff drivers and text conversion for every automatic diff', () => {
  const invocations = [
    unstagedGitDiffArguments(),
    stagedGitDiffArguments(),
    untrackedGitDiffArguments('/dev/null', 'example.txt'),
  ];
  for (const args of invocations) {
    assert.equal(args[0], 'diff');
    assert.ok(args.includes('--no-ext-diff'));
    assert.ok(args.includes('--no-textconv'));
  }
  assert.ok(invocations[1].includes('--cached'));
  assert.ok(invocations[2].includes('--no-index'));
});

test('renders untracked text, empty, large, and symbolic-link files safely', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cod-untracked-diff-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await execFileAsync('git', ['init', '--quiet'], { cwd: root });
  await fs.writeFile(path.join(root, 'hello.txt'), 'hello from COD\n');
  await fs.writeFile(path.join(root, 'empty.txt'), '');
  await fs.writeFile(path.join(root, 'large.txt'), Buffer.alloc(256 * 1024 + 1, 120));

  let expectedFiles = 3;
  if (process.platform !== 'win32') {
    const outside = path.join(os.tmpdir(), `cod-untracked-secret-${process.pid}.txt`);
    await fs.writeFile(outside, 'must-not-appear-in-preview');
    context.after(() => fs.rm(outside, { force: true }));
    await fs.symlink(outside, path.join(root, 'outside-link.txt'));
    expectedFiles += 1;
  }

  const diff = await collectUntrackedDiff(root);
  assert.equal(diff.match(/^diff --git /gm)?.length, expectedFiles);
  assert.match(diff, /hello from COD/);
  assert.match(diff, /a\/empty\.txt b\/empty\.txt[\s\S]*index 0000000\.\.e69de29/);
  assert.match(diff, /larger than 256 KiB/);
  if (process.platform !== 'win32') {
    assert.match(diff, /symbolic link content is not read/);
    assert.doesNotMatch(diff, /must-not-appear-in-preview/);
  }
});

test('bounds large untracked lists and total renderer output', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cod-untracked-many-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await execFileAsync('git', ['init', '--quiet'], { cwd: root });
  const fileNames = Array.from({ length: 1_005 }, (_, index) => `file-${String(index).padStart(4, '0')}.txt`);
  for (let offset = 0; offset < fileNames.length; offset += 100) {
    await Promise.all(fileNames.slice(offset, offset + 100).map((name) => fs.writeFile(path.join(root, name), '')));
  }

  const pathBounded = await collectUntrackedDiff(root, { contentPreviewLimit: 0 });
  assert.equal(pathBounded.match(/^diff --git /gm)?.length, 1_000);
  assert.match(pathBounded, /其余 5 个未跟踪路径已省略/);
  assert.ok(Buffer.byteLength(pathBounded, 'utf8') <= 2 * 1024 * 1024);

  const outputBounded = await collectUntrackedDiff(root, { contentPreviewLimit: 0, outputLimitBytes: 4_096 });
  assert.ok((outputBounded.match(/^diff --git /gm)?.length ?? 0) < 1_000);
  assert.match(outputBounded, /未跟踪路径已省略/);
  assert.ok(Buffer.byteLength(outputBounded, 'utf8') <= 4_096);
});
