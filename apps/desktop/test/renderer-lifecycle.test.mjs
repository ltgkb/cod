import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const desktopMain = await readFile(new URL('../dist/main.js', import.meta.url), 'utf8');

test('keeps active task heartbeats scheduled while the window is minimized', () => {
  assert.match(desktopMain, /backgroundThrottling:\s*false/);
});

test('stops Goose when the renderer reloads, crashes, or is destroyed', () => {
  for (const eventName of ['did-start-navigation', 'render-process-gone', 'destroyed']) {
    assert.match(desktopMain, new RegExp(`webContents\\.on\\('${eventName}'[\\s\\S]{0,240}?invalidateAndStopGooseSidecar`));
  }
});
