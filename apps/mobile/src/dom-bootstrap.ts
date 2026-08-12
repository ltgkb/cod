export type DomHostPlatform = 'android' | 'ios';

export const DOM_NATIVE_ACTION_NAMES = [
  'nativeRequest',
  'cancelNativeRequest',
  'openExternalUrl',
  'copyText',
  'setNativeColorMode',
  'setNativeBackAvailable',
] as const;

export interface ExpoDomWindow extends Window {
  $$EXPO_DOM_HOST_OS?: string;
  $$EXPO_INITIAL_PROPS?: {
    names: string[];
    props: {
      controlPlaneUrl: string;
      hostPlatform: DomHostPlatform;
    };
  };
}

export function detectDomHostPlatform(userAgent: string): DomHostPlatform {
  return /Android/i.test(userAgent) ? 'android' : 'ios';
}

/**
 * Recovers Expo's globals from inside the DOM bundle when Android runs the
 * document before React Native WebView's document-start injection. Expo Go's
 * fallback WebView is known to have that race on reload and cold restore.
 */
export function ensureExpoDomGlobals(
  apiUrl: string,
  userAgent: string = navigator.userAgent,
  target: ExpoDomWindow = window,
): DomHostPlatform {
  const platform = detectDomHostPlatform(userAgent);
  target.$$EXPO_DOM_HOST_OS ??= platform;
  target.$$EXPO_INITIAL_PROPS ??= {
    names: [...DOM_NATIVE_ACTION_NAMES],
    props: { controlPlaneUrl: apiUrl, hostPlatform: platform },
  };
  return platform;
}

/**
 * Keeps Expo's DOM bootstrap data available when Expo Go swaps the underlying
 * ReactNativeWebView bridge during a reload. The Android fallback WebView can
 * replace the whole bridge object after `injectedJavaScriptBeforeContentLoaded`
 * has run, so protecting only `injectedObjectJson` is not sufficient.
 */
export function createDomBootstrap(platform: DomHostPlatform, apiUrl: string): string {
  const initialProps = {
    names: [...DOM_NATIVE_ACTION_NAMES],
    props: { controlPlaneUrl: apiUrl, hostPlatform: platform },
  };
  const injectedObjectJson = JSON.stringify({
    EXPO_DOM_HOST_OS: platform,
    initialProps,
  });

  return [
    '(function () {',
    `  var injectedObjectJson = ${JSON.stringify(injectedObjectJson)};`,
    '  var bridge = window.ReactNativeWebView;',
    "  if (!bridge || (typeof bridge !== 'object' && typeof bridge !== 'function')) bridge = {};",
    '  var readInjectedObjectJson = function () { return injectedObjectJson; };',
    '  var repairBridge = function (nextBridge) {',
    "    if (nextBridge && nextBridge !== bridge && (typeof nextBridge === 'object' || typeof nextBridge === 'function')) {",
    '      try { Object.assign(bridge, nextBridge); } catch (_) {}',
    '    }',
    "    Object.defineProperty(bridge, 'injectedObjectJson', {",
    '      configurable: true,',
    '      enumerable: false,',
    '      writable: false,',
    '      value: readInjectedObjectJson,',
    '    });',
    '  };',
    '  repairBridge(bridge);',
    "  var descriptor = Object.getOwnPropertyDescriptor(window, 'ReactNativeWebView');",
    '  if (!descriptor || descriptor.configurable) {',
    "    Object.defineProperty(window, 'ReactNativeWebView', {",
    '      configurable: false,',
    '      enumerable: true,',
    '      get: function () { return bridge; },',
    '      set: function (nextBridge) { repairBridge(nextBridge); },',
    '    });',
    '  } else {',
    '    repairBridge(window.ReactNativeWebView);',
    '  }',
    '})();',
    'true;',
  ].join('\n');
}
