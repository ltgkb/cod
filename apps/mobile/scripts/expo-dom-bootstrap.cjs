'use strict';

const EXPO_BOOTSTRAP_START = `        <script>
          var injectedObject = {};
          try {
            injectedObject = JSON.parse(window.ReactNativeWebView.injectedObjectJson());
          } catch (e) {
            throw new Error('Failed to parse injectedObjectJson: ' + e.message);
          }
          window.$$EXPO_DOM_HOST_OS = injectedObject.EXPO_DOM_HOST_OS;
          window.$$EXPO_INITIAL_PROPS = injectedObject.initialProps;
        </script>`;

const COD_BOOTSTRAP_MARKER = 'cod:expo-dom-bootstrap-v1';
const NATIVE_ACTION_NAMES = Object.freeze([
  'nativeRequest',
  'cancelNativeRequest',
  'openExternalUrl',
  'copyText',
  'setNativeColorMode',
  'setNativeTopmostUiVisible',
]);

function assertControlPlaneUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('EXPO_PUBLIC_COD_CONTROL_PLANE_URL must use HTTP or HTTPS');
  }
  if (url.username || url.password) {
    throw new Error('EXPO_PUBLIC_COD_CONTROL_PLANE_URL must not contain credentials');
  }
  return value;
}

function getMetroServerPort(config) {
  const port = config?.server?.port;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('Metro server does not have a valid TCP listening port');
  }
  return port;
}

function serializeForInlineScript(value) {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
}

function createFallbackPayload(controlPlaneUrl, hostPlatform) {
  return {
    EXPO_DOM_HOST_OS: hostPlatform,
    initialProps: {
      names: [...NATIVE_ACTION_NAMES],
      props: {
        controlPlaneUrl: assertControlPlaneUrl(controlPlaneUrl),
        hostPlatform,
      },
    },
  };
}

function createBootstrapScript(controlPlaneUrl) {
  const androidPayload = serializeForInlineScript(createFallbackPayload(controlPlaneUrl, 'android'));
  const iosPayload = serializeForInlineScript(createFallbackPayload(controlPlaneUrl, 'ios'));

  return `        <script>
          /* ${COD_BOOTSTRAP_MARKER} */
          (function () {
            var injectedObject;
            var bridge = window.ReactNativeWebView;
            if (bridge && typeof bridge.injectedObjectJson === 'function') {
              try {
                injectedObject = JSON.parse(bridge.injectedObjectJson());
              } catch (_error) {
                injectedObject = undefined;
              }
            }
            var initialProps = injectedObject && injectedObject.initialProps;
            var hasNativeBootstrap =
              (injectedObject && (injectedObject.EXPO_DOM_HOST_OS === 'android' || injectedObject.EXPO_DOM_HOST_OS === 'ios')) &&
              initialProps && Array.isArray(initialProps.names) && initialProps.props;
            if (!hasNativeBootstrap) {
              injectedObject = /Android/i.test(navigator.userAgent) ? ${androidPayload} : ${iosPayload};
            }
            window.$$EXPO_DOM_HOST_OS = injectedObject.EXPO_DOM_HOST_OS;
            window.$$EXPO_INITIAL_PROPS = injectedObject.initialProps;
          })();
        </script>`;
}

function transformExpoDomHtml(html, controlPlaneUrl) {
  if (html.includes(COD_BOOTSTRAP_MARKER)) return html;
  const occurrences = html.split(EXPO_BOOTSTRAP_START).length - 1;
  if (occurrences !== 1) {
    throw new Error(`Expected one Expo DOM bootstrap block, found ${occurrences}`);
  }
  return html.replace(EXPO_BOOTSTRAP_START, () => createBootstrapScript(controlPlaneUrl));
}

function assertExpoDevelopmentDomHtml(html) {
  const match = html.match(/<script crossorigin src="([^"]+)"><\/script>/);
  if (!match) throw new Error('Expo DOM development bundle script is missing');
  const bundleUrl = new URL(match[1], 'http://localhost');
  const requiredParameters = {
    platform: 'web',
    dev: 'true',
    lazy: 'true',
    'transform.engine': 'hermes',
  };
  for (const [name, expected] of Object.entries(requiredParameters)) {
    const actual = bundleUrl.searchParams.get(name);
    if (actual !== expected) {
      throw new Error(`Expo DOM bundle parameter ${name} must be ${expected}; received ${actual}`);
    }
  }
  const domRoot = bundleUrl.searchParams.get('transform.dom');
  if (!domRoot?.endsWith('/apps/mobile/src/CodWorkspace.dom.tsx')) {
    throw new Error(`Expo DOM bundle points at an unexpected component: ${domRoot}`);
  }
}

module.exports = {
  COD_BOOTSTRAP_MARKER,
  NATIVE_ACTION_NAMES,
  createBootstrapScript,
  createFallbackPayload,
  getMetroServerPort,
  assertExpoDevelopmentDomHtml,
  transformExpoDomHtml,
};
