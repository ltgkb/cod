import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { collectWorkspaceFiles, readWorkspaceTextFile } from '../dist/workspace-files.js';

test('uses one global node budget across a wide directory tree and reports truncation', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cod-wide-tree-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  for (let directoryIndex = 0; directoryIndex < 12; directoryIndex += 1) {
    const directory = path.join(root, `directory-${String(directoryIndex).padStart(2, '0')}`);
    await fs.mkdir(directory);
    await Promise.all(Array.from({ length: 20 }, (_, fileIndex) => fs.writeFile(
      path.join(directory, `file-${String(fileIndex).padStart(2, '0')}.txt`),
      '',
    )));
  }

  const files = await collectWorkspaceFiles(root, { maximumNodes: 100 });
  assert.equal(files.length, 100);
  assert.equal(files.at(-1)?.kind, 'directory');
  assert.equal(files.at(-1)?.path, '');
  assert.match(files.at(-1)?.name ?? '', /其余文件已省略/);
  assert.equal(new Set(files.slice(0, -1).map((file) => file.path)).size, 99);
});

test('ignores generated and hidden directories without consuming the display budget', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cod-visible-tree-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'node_modules'));
  await fs.mkdir(path.join(root, '.git'));
  await fs.mkdir(path.join(root, 'coverage'));
  await fs.mkdir(path.join(root, 'release'));
  await fs.writeFile(path.join(root, 'visible.txt'), 'visible');
  const files = await collectWorkspaceFiles(root, { maximumNodes: 10 });
  assert.deepEqual(files.map((file) => file.path), ['visible.txt']);
});

test('sorts directories first and names naturally on every filesystem', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cod-sorted-tree-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'file-10.txt'), '');
  await fs.mkdir(path.join(root, 'z-directory'));
  await fs.writeFile(path.join(root, 'file-2.txt'), '');
  await fs.mkdir(path.join(root, 'a-directory'));
  const files = await collectWorkspaceFiles(root, { maximumNodes: 10 });
  assert.deepEqual(files.map((file) => file.name), ['a-directory', 'z-directory', 'file-2.txt', 'file-10.txt']);
});

test('reads only bounded regular files inside the approved project root', async (context) => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'cod-read-file-'));
  context.after(() => fs.rm(fixture, { recursive: true, force: true }));
  const root = path.join(fixture, 'project');
  const outside = path.join(fixture, 'outside.txt');
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'hello.txt'), 'hello from project');
  await fs.writeFile(path.join(root, 'large.txt'), Buffer.alloc(1024 * 1024 + 1));
  await fs.writeFile(outside, 'outside secret');

  assert.equal(await readWorkspaceTextFile(root, 'src/hello.txt'), 'hello from project');
  await assert.rejects(readWorkspaceTextFile(root, '../outside.txt'), /outside/);
  await assert.rejects(readWorkspaceTextFile(root, 'src'), /regular file/);
  await assert.rejects(readWorkspaceTextFile(root, 'large.txt'), /larger than 1 MB/);
  await assert.rejects(readWorkspaceTextFile(root, ''), /invalid/);

  if (process.platform !== 'win32') {
    await fs.symlink(outside, path.join(root, 'outside-link.txt'));
    await assert.rejects(readWorkspaceTextFile(root, 'outside-link.txt'), /outside/);
  }
});
