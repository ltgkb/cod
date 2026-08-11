'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');

const {
  COD_BOOTSTRAP_MARKER,
  COD_CSP_MARKER,
  NATIVE_ACTION_NAMES,
  assertExpoDevelopmentDomHtml,
  createBootstrapScript,
  getMetroServerPort,
  transformExpoDomHtml,
} = require('./expo-dom-bootstrap.cjs');

const expoTemplate = `<!doctype html><body>
<meta charset="utf-8" />
        <script>
          var injectedObject = {};
          try {
            injectedObject = JSON.parse(window.ReactNativeWebView.injectedObjectJson());
          } catch (e) {
            throw new Error('Failed to parse injectedObjectJson: ' + e.message);
          }
          window.$$EXPO_DOM_HOST_OS = injectedObject.EXPO_DOM_HOST_OS;
          window.$$EXPO_INITIAL_PROPS = injectedObject.initialProps;
        </script>
</body>`;

function runBootstrap({ bridge, userAgent = 'Android' }) {
  const html = createBootstrapScript('https://cod.kai.com');
  const script = html.slice(html.indexOf('>') + 1, html.lastIndexOf('</script>'));
  const window = { ReactNativeWebView: bridge };
  vm.runInNewContext(script, { window, navigator: { userAgent } });
  return window;
}

test('uses a complete native bootstrap when it is synchronously available', () => {
  const nativeInitialProps = { names: ['nativeAction'], props: { controlPlaneUrl: 'https://native.example', hostPlatform: 'ios' } };
  const window = runBootstrap({
    bridge: {
      injectedObjectJson: () => JSON.stringify({ EXPO_DOM_HOST_OS: 'ios', initialProps: nativeInitialProps }),
    },
  });
  assert.equal(window.$$EXPO_DOM_HOST_OS, 'ios');
  assert.deepEqual(JSON.parse(JSON.stringify(window.$$EXPO_INITIAL_PROPS)), nativeInitialProps);
});

test('recovers synchronously when Android WebView has not installed injectedObjectJson', () => {
  const window = runBootstrap({ bridge: { postMessage() {} }, userAgent: 'Mozilla/5.0 (Linux; Android 16)' });
  assert.equal(window.$$EXPO_DOM_HOST_OS, 'android');
  assert.deepEqual(Array.from(window.$$EXPO_INITIAL_PROPS.names), [...NATIVE_ACTION_NAMES]);
  assert.equal(window.$$EXPO_INITIAL_PROPS.props.controlPlaneUrl, 'https://cod.kai.com');
  assert.equal(window.$$EXPO_INITIAL_PROPS.props.hostPlatform, 'android');
});

test('keeps every secure-session action available in the Expo Go fallback bridge', () => {
  assert.deepEqual(
    NATIVE_ACTION_NAMES.filter((name) => name.includes('Session')),
    ['loadSessionCleanupPending', 'loadSessionToken', 'saveSessionToken', 'clearSessionToken']
  );
});

test('recovers from malformed native JSON and selects iOS outside Android', () => {
  const window = runBootstrap({
    bridge: { injectedObjectJson: () => '{broken' },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',
  });
  assert.equal(window.$$EXPO_DOM_HOST_OS, 'ios');
  assert.equal(window.$$EXPO_INITIAL_PROPS.props.hostPlatform, 'ios');
});

test('transforms the Expo template exactly once and is idempotent', () => {
  const transformed = transformExpoDomHtml(expoTemplate, 'https://cod.kai.com');
  assert.match(transformed, new RegExp(COD_BOOTSTRAP_MARKER));
  assert.match(transformed, /window\.\$\$EXPO_DOM_HOST_OS/);
  assert.match(transformed, /window\.\$\$EXPO_INITIAL_PROPS/);
  assert.match(transformed, new RegExp(COD_CSP_MARKER));
  assert.match(transformed, /frame-src 'none'/);
  assert.match(transformed, /connect-src http: https: ws: wss:/);
  assert.doesNotMatch(transformed, /script-src[^;]*'unsafe-inline'/);
  assert.doesNotMatch(transformed, /throw new Error\('Failed to parse injectedObjectJson/);
  assert.equal(transformExpoDomHtml(transformed, 'https://cod.kai.com'), transformed);
});

test('fails loudly when Expo changes its generated bootstrap contract', () => {
  assert.throws(
    () => transformExpoDomHtml('<html><body>changed upstream</body></html>', 'https://cod.kai.com'),
    /Expected one Expo DOM bootstrap block, found 0/
  );
});

test('accepts only an Expo DOM development bundle with the required transform parameters', () => {
  const valid = '<script crossorigin src="//10.0.2.2:8083/node_modules/expo/dom/entry.bundle?platform=web&dev=true&hot=false&lazy=true&transform.engine=hermes&transform.dom=.%2F..%2Fapps%2Fmobile%2Fsrc%2FCodWorkspace.dom.tsx"></script>';
  assert.doesNotThrow(() => assertExpoDevelopmentDomHtml(valid));
  assert.throws(
    () => assertExpoDevelopmentDomHtml(valid.replace('platform=web', 'platform=android')),
    /parameter platform must be web/
  );
  assert.throws(
    () => assertExpoDevelopmentDomHtml(valid.replace('lazy=true', 'lazy=false')),
    /parameter lazy must be true/
  );
});

test('rejects unsafe control-plane URLs and escapes inline script terminators', () => {
  assert.throws(() => createBootstrapScript('javascript:alert(1)'), /must use HTTP or HTTPS/);
  const script = createBootstrapScript('https://cod.kai.com/?value=</script>');
  assert.doesNotMatch(script, /value=<\/script>/);
  assert.match(script, /value=\\u003c\/script>/);
});

test('uses the configured Metro listener port instead of a request Host port', () => {
  assert.equal(getMetroServerPort({ server: { port: 8083 } }), 8083);
  assert.throws(
    () => getMetroServerPort({ server: { port: '/private/tmp/metro.sock' } }),
    /valid TCP listening port/
  );
  assert.throws(
    () => getMetroServerPort({ server: { port: 0 } }),
    /valid TCP listening port/
  );
  assert.throws(
    () => getMetroServerPort({ server: { port: 65_536 } }),
    /valid TCP listening port/
  );
});
