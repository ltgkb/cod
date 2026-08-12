import { describe, expect, it, vi } from 'vitest';

import { createDomBootstrap, ensureExpoDomGlobals, type ExpoDomWindow } from './dom-bootstrap';

type TestBridge = {
  injectedObjectJson?: () => string;
  postMessage?: (value: string) => void;
};

function runBootstrap(window: { ReactNativeWebView?: TestBridge }, script: string): void {
  new Function('window', script)(window);
}

describe('createDomBootstrap', () => {
  it('recovers Expo globals from the DOM bundle when document-start injection loses the race', () => {
    const window = {} as ExpoDomWindow;

    expect(ensureExpoDomGlobals('https://cod.kai.com', 'Android WebView', window)).toBe('android');
    expect(window.$$EXPO_DOM_HOST_OS).toBe('android');
    expect(window.$$EXPO_INITIAL_PROPS).toMatchObject({
      props: { controlPlaneUrl: 'https://cod.kai.com', hostPlatform: 'android' },
    });
  });

  it('provides Expo DOM host metadata before the native bridge exists', () => {
    const window: { ReactNativeWebView?: TestBridge } = {};

    runBootstrap(window, createDomBootstrap('android', 'https://cod.kai.com'));

    expect(JSON.parse(window.ReactNativeWebView!.injectedObjectJson!())).toEqual({
      EXPO_DOM_HOST_OS: 'android',
      initialProps: {
        names: ['nativeRequest', 'cancelNativeRequest', 'openExternalUrl', 'copyText', 'setNativeColorMode', 'setNativeBackAvailable'],
        props: { controlPlaneUrl: 'https://cod.kai.com', hostPlatform: 'android' },
      },
    });
  });

  it('keeps the bootstrap hook when Expo Go replaces the whole bridge on reload', () => {
    const originalPostMessage = vi.fn();
    const replacementPostMessage = vi.fn();
    const window: { ReactNativeWebView: TestBridge } = {
      ReactNativeWebView: { postMessage: originalPostMessage },
    };
    runBootstrap(window, createDomBootstrap('android', 'https://cod.kai.com'));

    const stableBridge = window.ReactNativeWebView;
    window.ReactNativeWebView = {
      postMessage: replacementPostMessage,
      injectedObjectJson: () => 'native replacement',
    };

    expect(window.ReactNativeWebView).toBe(stableBridge);
    expect(window.ReactNativeWebView.postMessage).toBe(replacementPostMessage);
    expect(JSON.parse(window.ReactNativeWebView.injectedObjectJson!())).toMatchObject({
      EXPO_DOM_HOST_OS: 'android',
    });
  });

  it('prevents a late native property assignment from erasing the bootstrap hook', () => {
    const window: { ReactNativeWebView?: TestBridge } = { ReactNativeWebView: {} };
    runBootstrap(window, createDomBootstrap('ios', 'https://example.test'));

    new Function('bridge', "bridge.injectedObjectJson = function () { return 'late replacement'; }")(
      window.ReactNativeWebView,
    );

    expect(JSON.parse(window.ReactNativeWebView!.injectedObjectJson!())).toMatchObject({
      EXPO_DOM_HOST_OS: 'ios',
      initialProps: { props: { controlPlaneUrl: 'https://example.test' } },
    });
  });
});
