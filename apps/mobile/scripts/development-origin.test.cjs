'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

function loadOriginModule() {
  const filename = path.resolve(__dirname, '../src/development-origin.ts');
  const source = fs.readFileSync(filename, 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: filename,
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(compiled, { module, exports: module.exports, URL }, { filename });
  return module.exports;
}

const { resolveDevelopmentServerOrigin } = loadOriginModule();

test('uses the effective React Native script origin before Expo manifest hosts', () => {
  assert.equal(
    resolveDevelopmentServerOrigin(
      'http://10.0.2.2:8081/apps/mobile/index.bundle?platform=android',
      '192.168.1.8:8081',
      'localhost:8081',
    ),
    'http://10.0.2.2:8081',
  );
});

test('falls back to valid Expo debugger hosts', () => {
  assert.equal(resolveDevelopmentServerOrigin(undefined, '192.168.1.8:8081', undefined), 'http://192.168.1.8:8081');
  assert.equal(resolveDevelopmentServerOrigin('file:///app/index.bundle', undefined, 'https://metro.example:8443'), 'https://metro.example:8443');
});

test('rejects non-http origins and URLs containing credentials', () => {
  assert.equal(resolveDevelopmentServerOrigin('file:///app/index.bundle', 'javascript:alert(1)', 'https://user@example.com'), undefined);
});
