import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('public landing page keeps the workspace behind /app/', async () => {
  const [landing, showcaseScript] = await Promise.all([
    read('../index.html'),
    read('../public/showcase/script.js'),
  ]);
  assert.match(landing, /href="\.\/app\/"/);
  assert.match(landing, /id="registerButton"[\s\S]*href="\.\/app\/\?auth=register"[\s\S]*hidden/);
  assert.match(landing, /id="heroDownloadButton"/);
  assert.match(showcaseScript, /fetch\("\/api\/capabilities"/);
  assert.match(showcaseScript, /registrationEnabled === true/);
  assert.match(showcaseScript, /heroDownloadButton\.hidden = true/);
  assert.doesNotMatch(landing, /src="\/src\/main\.tsx"/);
  assert.doesNotMatch(landing, /cdn-cgi|challenge-platform/);
});

test('workspace entry, manifest, and service worker share the /app/ scope', async () => {
  const [workspace, manifestText, serviceWorker] = await Promise.all([
    read('../app/index.html'),
    read('../public/manifest.webmanifest'),
    read('../public/sw.js'),
  ]);
  const manifest = JSON.parse(manifestText);
  assert.match(workspace, /src="\/src\/main\.tsx"/);
  assert.equal(manifest.start_url, './app/');
  assert.equal(manifest.scope, './app/');
  assert.match(serviceWorker, /const SHELL = \['\/app\/'\]/);
  assert.match(serviceWorker, /if \(!url\.pathname\.startsWith\('\/app\/'\)\) return/);
  assert.match(serviceWorker, /caches\.match\('\/app\/'\)/);
});

test('compute entry keeps deep-link assets rooted at the public origin', async () => {
  const [compute, showcase, nginx] = await Promise.all([
    read('../compute/index.html'),
    read('../compute/showcase/index.html'),
    read('../../../deploy/cod.nginx.conf'),
  ]);
  assert.match(compute, /<base href="\/" \/>/);
  assert.match(compute, /src="\/src\/main\.tsx"/);
  assert.match(compute, /<title>COD · 算力市场<\/title>/);
  assert.match(showcase, /<base href="\/" \/>/);
  assert.match(showcase, /<title>COD · 算力产品展示<\/title>/);
  assert.match(nginx, /location = \/compute\/showcase\s*\{\s*return 308 https:\/\/\$host\/compute\/showcase\/;/);
  assert.match(nginx, /location = \/compute\/showcase\/\s*\{[\s\S]*?try_files \/compute\/showcase\/index\.html =404;/);
});
