'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

function loadSecurityModule() {
  const filename = path.resolve(__dirname, '../src/native-bridge-security.ts');
  const source = fs.readFileSync(filename, 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: filename,
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(compiled, { module, exports: module.exports, URL }, { filename });
  return module.exports;
}

const {
  assertNativeBridgeCapability,
  createNativeBridgeDocumentStartScript,
  nativeBridgeCapabilityGlobal,
  runAuthorizedNativeBridgeAction,
} = loadSecurityModule();

const capability = '12345678-1234-4234-9234-123456789abc';
const androidDocument = 'file:///android_asset/www.bundle/0123456789abcdef0123456789abcdef.html';
const iosDocument = 'file:///private/Bundle/Application/COD/www.bundle/abcdef0123456789abcdef0123456789.html';
const developmentOrigin = 'http://10.0.2.2:8081';

function executeBootstrap(script, href, includeDom = true) {
  const window = { location: { href }, dispatchEvent() {} };
  const context = { window, URL, Event: class Event { constructor(type) { this.type = type; } } };
  if (includeDom) {
    let policyMeta = null;
    const listeners = new Map();
    const head = {
      querySelector: () => policyMeta,
      prepend: (node) => { policyMeta = node; },
    };
    context.document = {
      head,
      documentElement: {},
      createElement: () => ({ setAttribute(name, value) { this[name] = value; } }),
      addEventListener: (name, listener, capture) => { listeners.set(name, { listener, capture }); },
    };
    context.MutationObserver = class MutationObserver {
      observe() {}
      disconnect() {}
    };
    window.__listeners = listeners;
  }
  vm.runInNewContext(script, context);
  return window;
}

test('requires the exact per-launch capability before a native action can run', () => {
  assert.doesNotThrow(() => assertNativeBridgeCapability(capability, capability));
  assert.throws(() => assertNativeBridgeCapability('12345678-1234-4234-9234-123456789abd', capability), /Untrusted DOM bridge action/);
  assert.throws(() => assertNativeBridgeCapability(undefined, capability), /Untrusted DOM bridge action/);
});

test('rejects a wrong capability before every exposed native action can have a side effect', () => {
  const actions = ['nativeRequest','cancelNativeRequest','openExternalUrl','copyText','setNativeColorMode','setNativeTopmostUiVisible','loadSessionCleanupPending','loadSessionToken','saveSessionToken','clearSessionToken'];
  for (const actionName of actions) {
    let sideEffects=0;
    assert.throws(
      () => runAuthorizedNativeBridgeAction('12345678-1234-4234-9234-123456789abd',capability,()=>{sideEffects+=1;}),
      /Untrusted DOM bridge action/,
      actionName,
    );
    assert.equal(sideEffects,0,actionName);
  }
});

test('injects the capability and containment guards into exact production bundle URLs only', () => {
  const androidScript = createNativeBridgeDocumentStartScript(capability, false, 'android');
  const iosScript = createNativeBridgeDocumentStartScript(capability, false, 'ios');
  assert.equal(executeBootstrap(androidScript, androidDocument)[nativeBridgeCapabilityGlobal], capability);
  assert.equal(executeBootstrap(iosScript, iosDocument)[nativeBridgeCapabilityGlobal], capability);
  assert.match(androidScript, /Object\.defineProperty\(window,'open'/);
  assert.match(androidScript, /frame-src 'none'/);
  assert.match(androidScript, /child-src 'none'/);
  assert.match(androidScript, /connect-src 'none'/);
  assert.match(androidScript, /iframe,frame,object,embed/);
  for (const name of ['click','auxclick','dragstart']) assert.equal(executeBootstrap(androidScript, androidDocument).__listeners.get(name).capture,true);
});

test('returns before touching the DOM or exposing the capability on every untrusted top-level document', () => {
  const androidScript = createNativeBridgeDocumentStartScript(capability, false, 'android');
  for (const href of [
    'https://attacker.example/',
    'about:blank',
    'file:///android_asset/www.bundle/index.html',
    'file:///private/tmp/www.bundle/0123456789abcdef0123456789abcdef.html',
  ]) {
    const window = executeBootstrap(androidScript, href, false);
    assert.equal(Object.hasOwn(window, nativeBridgeCapabilityGlobal), false, href);
  }
  const iosScript = createNativeBridgeDocumentStartScript(capability, false, 'ios');
  assert.equal(Object.hasOwn(executeBootstrap(iosScript, 'file:///private/tmp/not-www.bundle/0123456789abcdef0123456789abcdef.html', false), nativeBridgeCapabilityGlobal), false);
});

test('allows only the two exact Expo development DOM paths on the configured Metro origin', () => {
  const script = createNativeBridgeDocumentStartScript(capability, true, 'android', developmentOrigin);
  assert.equal(executeBootstrap(script, `${developmentOrigin}/_cod/expo-dom-bootstrap?platform=android`)[nativeBridgeCapabilityGlobal], capability);
  assert.equal(executeBootstrap(script, `${developmentOrigin}/_expo/@dom/workspace?platform=web`)[nativeBridgeCapabilityGlobal], capability);
  for (const href of [`${developmentOrigin}/`, `${developmentOrigin}/unrelated`, 'http://127.0.0.1:8081/_cod/expo-dom-bootstrap']) {
    assert.equal(Object.hasOwn(executeBootstrap(script, href, false), nativeBridgeCapabilityGlobal), false, href);
  }
});

test('is idempotent when Android retries the trusted bootstrap after page load', () => {
  const script = createNativeBridgeDocumentStartScript(capability, false, 'android');
  const window = executeBootstrap(script, androidDocument);
  const descriptor = Object.getOwnPropertyDescriptor(window, nativeBridgeCapabilityGlobal);
  assert.doesNotThrow(() => {
    const context = { window, URL };
    vm.runInNewContext(script, context);
  });
  assert.deepEqual(Object.getOwnPropertyDescriptor(window, nativeBridgeCapabilityGlobal), descriptor);
});

test('rejects invalid capabilities, platforms, and development origins', () => {
  assert.throws(() => createNativeBridgeDocumentStartScript('predictable', false, 'android'), /invalid/);
  assert.throws(() => createNativeBridgeDocumentStartScript(capability, false), /platform is invalid/);
  assert.throws(() => createNativeBridgeDocumentStartScript(capability, true, 'android', 'https://user@example.com'), /origin is invalid/);
  assert.throws(() => createNativeBridgeDocumentStartScript(capability, true, 'android', 'file:///tmp'), /origin is invalid/);
});
