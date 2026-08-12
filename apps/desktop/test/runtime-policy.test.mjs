import assert from 'node:assert/strict';
import test from 'node:test';

import {
  defaultDesktopControlPlaneUrl,
  resolveDesktopRuntimeUrls,
  isTrustedRendererUrl,
} from '../dist/runtime-policy.js';

test('packaged desktop exposes only an origin-only HTTPS control plane', () => {
  assert.deepEqual(resolveDesktopRuntimeUrls({}, true), {
    controlPlaneUrl: defaultDesktopControlPlaneUrl,
    developmentUrl: 'http://127.0.0.1:5173',
  });
  for (const value of [
    'http://cod.kai.com',
    'https://staging.cod.kai.com',
    'https://user:password@cod.kai.com',
    'https://cod.kai.com/api',
    'https://cod.kai.com?target=other',
    'file:///tmp/control-plane',
  ]) {
    assert.throws(() => resolveDesktopRuntimeUrls({ COD_CONTROL_PLANE_URL: value }, true));
  }
});

test('source desktop permits isolated loopback development but not a remote clear-text endpoint', () => {
  const resolved = resolveDesktopRuntimeUrls({
    COD_CONTROL_PLANE_URL: 'http://localhost:8787',
    COD_DEV_SERVER_URL: 'http://[::1]:5173',
  }, false);
  assert.equal(resolved.controlPlaneUrl, 'http://localhost:8787');
  assert.equal(resolved.developmentUrl, 'http://[::1]:5173');
  assert.throws(() => resolveDesktopRuntimeUrls({ COD_CONTROL_PLANE_URL: 'http://192.0.2.10:8787' }, false));
  assert.throws(() => resolveDesktopRuntimeUrls({ COD_DEV_SERVER_URL: 'https://127.0.0.1:5173' }, false));
});

test('IPC accepts only the exact renderer entry point or development origin', () => {
  const entry = 'file:///Applications/COD.app/Contents/Resources/web/app/index.html';
  assert.equal(isTrustedRendererUrl(`${entry}#task`, true, 'http://127.0.0.1:5173', entry), true);
  assert.equal(isTrustedRendererUrl('file:///Applications/COD.app/Contents/Resources/web/other.html', true, 'http://127.0.0.1:5173', entry), false);
  assert.equal(isTrustedRendererUrl('https://cod.kai.com/', true, 'http://127.0.0.1:5173', entry), false);
  assert.equal(isTrustedRendererUrl('http://127.0.0.1:5173/tasks/1', false, 'http://127.0.0.1:5173', entry), true);
  assert.equal(isTrustedRendererUrl('http://attacker@127.0.0.1:5173/tasks/1', false, 'http://127.0.0.1:5173', entry), false);
  assert.equal(isTrustedRendererUrl('http://127.0.0.1:5174/', false, 'http://127.0.0.1:5173', entry), false);
});
