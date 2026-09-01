import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('public landing page keeps the workspace behind /app/', async () => {
  const [landing, showcaseScript, showcaseStyles] = await Promise.all([
    read('../index.html'),
    read('../public/showcase/script.js'),
    read('../public/showcase/styles.css'),
  ]);
  assert.match(landing, /href="\.\/app\/"/);
  assert.match(landing, /id="registerButton"[\s\S]*href="\.\/app\/\?auth=register"[\s\S]*hidden/);
  assert.match(landing, /id="heroDownloadButton"/);
  assert.match(showcaseScript, /fetch\("\/api\/capabilities"/);
  assert.match(showcaseScript, /registrationEnabled === true/);
  assert.match(showcaseScript, /heroDownloadButton\.hidden = true/);
  const heroRule = showcaseStyles.match(/(?:^|\n)\.hero\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(heroRule, /grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  const heroCopyRule = showcaseStyles.match(/(?:^|\n)\.hero-copy\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(heroCopyRule, /min-width:\s*0/);
  const heroActionsRule = showcaseStyles.match(/(?:^|\n)\.hero-actions\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(heroActionsRule, /flex-wrap:\s*wrap/);
  const heroVisualRules = [...showcaseStyles.matchAll(/(?:^|\n)\.hero-visual\s*\{([^}]*)\}/g)];
  assert.equal(heroVisualRules.length, 1);
  assert.match(heroVisualRules[0][1], /min-width:\s*0/);
  assert.match(heroVisualRules[0][1], /width:\s*100%/);
  assert.doesNotMatch(heroVisualRules[0][1], /(?:min-|max-)?width:\s*[^;]*\d+px/);
  const heroImageRule = showcaseStyles.match(/\.hero-image-shell img\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(heroImageRule, /display:\s*block/);
  assert.match(heroImageRule, /width:\s*100%/);
  assert.match(heroImageRule, /height:\s*auto/);
  assert.doesNotMatch(heroImageRule, /aspect-ratio|object-fit|object-position/);
  assert.match(
    showcaseStyles,
    /@media \(max-width:\s*680px\)[\s\S]*?\.hero h1 \.hero-line\s*\{[^}]*white-space:\s*normal/,
  );
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
