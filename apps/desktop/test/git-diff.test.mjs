import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { collectGitDiff, collectUntrackedDiff } from '../dist/git-diff.js';

const execFileAsync = promisify(execFile);

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

test('renders staged, unstaged, and untracked changes without inherited Git redirection or textconv execution', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cod-complete-diff-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await execFileAsync('git', ['init', '--quiet'], { cwd: root });
  await execFileAsync('git', ['config', 'user.email', 'cod-test@example.invalid'], { cwd: root });
  await execFileAsync('git', ['config', 'user.name', 'COD Test'], { cwd: root });

  await fs.writeFile(path.join(root, '.gitattributes'), '*.probe diff=codprobe\n');
  await fs.writeFile(path.join(root, 'tracked.probe'), 'baseline\n');
  await fs.writeFile(path.join(root, 'unstaged.txt'), 'baseline\n');
  await execFileAsync('git', ['add', '--', '.gitattributes', 'tracked.probe', 'unstaged.txt'], { cwd: root });
  await execFileAsync('git', ['-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'baseline'], { cwd: root });

  const marker = path.join(root, 'textconv-executed');
  const textconv = path.join(root, 'textconv.sh');
  await fs.writeFile(textconv, '#!/bin/sh\n: > "$COD_TEXTCONV_MARKER"\ncat "$1"\n', { mode: 0o700 });
  await execFileAsync('git', ['config', 'diff.codprobe.textconv', textconv], { cwd: root });
  await fs.writeFile(path.join(root, 'tracked.probe'), 'unstaged probe change\n');
  await fs.writeFile(path.join(root, 'unstaged.txt'), 'unstaged text change\n');
  await fs.writeFile(path.join(root, 'staged.txt'), 'staged change\n');
  await execFileAsync('git', ['add', '--', 'staged.txt'], { cwd: root });
  await fs.writeFile(path.join(root, 'untracked.txt'), 'untracked change\n');

  const previousGitDirectory = process.env.GIT_DIR;
  const previousMarker = process.env.COD_TEXTCONV_MARKER;
  process.env.GIT_DIR = path.join(root, 'missing-git-directory');
  process.env.COD_TEXTCONV_MARKER = marker;
  try {
    const diff = await collectGitDiff(root);
    assert.match(diff, /# Unstaged changes[\s\S]*unstaged text change/);
    assert.match(diff, /# Staged changes[\s\S]*staged change/);
    assert.match(diff, /# Untracked files[\s\S]*untracked change/);
    await assert.rejects(fs.access(marker));
  } finally {
    if (previousGitDirectory === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = previousGitDirectory;
    if (previousMarker === undefined) delete process.env.COD_TEXTCONV_MARKER;
    else process.env.COD_TEXTCONV_MARKER = previousMarker;
  }
});

test('returns a concise empty state for a non-repository instead of Git no-index option help', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cod-non-repository-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const diff = await collectGitDiff(root);
  assert.match(diff, /不是 Git 仓库/);
  assert.doesNotMatch(diff, /unknown option|usage: git diff|--no-index/i);
});
