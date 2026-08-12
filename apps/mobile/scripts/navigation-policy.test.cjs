'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

function loadPolicy() {
  const filename = path.resolve(__dirname, '../src/navigation-policy.ts');
  const source = fs.readFileSync(filename, 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: filename,
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(compiled, { module, exports: module.exports, URL }, { filename });
  return module.exports;
}

const { decideDomNavigation, domOriginWhitelist, isTrustedDomNavigation } = loadPolicy();

test('allows only local documents and the configured Metro origin', () => {
  const origin = 'http://10.0.2.2:8081';
  assert.equal(isTrustedDomNavigation('about:blank', origin, 'android'), false);
  assert.equal(isTrustedDomNavigation('file:///android_asset/www.bundle/0123456789abcdef0123456789abcdef.html', origin, 'android'), true);
  assert.equal(isTrustedDomNavigation('file:///android_asset/www.bundle/index.html', origin, 'android'), false);
  assert.equal(isTrustedDomNavigation('file:///private/tmp/www.bundle/0123456789abcdef0123456789abcdef.html', origin, 'android'), false);
  assert.equal(isTrustedDomNavigation('file:///private/Bundle/Application/COD/www.bundle/0123456789abcdef0123456789abcdef.html', origin, 'ios'), true);
  assert.equal(isTrustedDomNavigation(`${origin}/_cod/expo-dom-bootstrap`, origin, 'android'), true);
  assert.equal(isTrustedDomNavigation(`${origin}/_expo/@dom/component`, origin, 'android'), true);
  assert.equal(isTrustedDomNavigation(`${origin}/unrelated`, origin, 'android'), false);
  assert.equal(isTrustedDomNavigation('https://cod.kai.com/', origin, 'android'), false);
  assert.equal(isTrustedDomNavigation('https://attacker.example/', origin, 'android'), false);
  assert.equal(isTrustedDomNavigation('javascript:alert(1)', origin, 'android'), false);
  assert.equal(isTrustedDomNavigation('not a url', origin, 'android'), false);
});

test('blocks reported untrusted subframes and opens only reported top-frame HTTP links externally', () => {
  const origin = 'http://10.0.2.2:8081';
  assert.equal(decideDomNavigation(`${origin}/_expo/@dom/component`, false, origin, 'ios'), 'allow');
  assert.equal(decideDomNavigation('https://attacker.example/frame', false, origin, 'ios'), 'block');
  assert.equal(decideDomNavigation('https://cod.kai.com/docs', true, origin, 'android'), 'external');
  assert.equal(decideDomNavigation('https://cod.kai.com/docs', undefined, origin, 'android'), 'external');
  assert.equal(decideDomNavigation('javascript:alert(1)', true, origin, 'android'), 'block');
  assert.equal(decideDomNavigation('not a url', true, origin, 'android'), 'block');
});

test('routes reported navigation through the decision callback instead of RN WebView auto-open', () => {
  assert.deepEqual(Array.from(domOriginWhitelist('http://10.0.2.2:8081')), ['http://10.0.2.2:8081']);
  assert.deepEqual(Array.from(domOriginWhitelist()), ['file://']);
});
