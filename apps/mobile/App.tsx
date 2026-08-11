import { useCallback, useRef, useState } from 'react';
import { KeyboardAvoidingView, Linking, Platform, StyleSheet, useColorScheme } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as Clipboard from 'expo-clipboard';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import CodWorkspace from './src/CodWorkspace.dom';
import type { NativeHttpRequest, NativeHttpResponse } from '../web/src/runtime';

const controlPlaneUrl = process.env.EXPO_PUBLIC_COD_CONTROL_PLANE_URL ?? 'https://cod.kai.com';
const hostPlatform = Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : undefined;
const domBootstrap = hostPlatform ? createDomBootstrap(hostPlatform, controlPlaneUrl) : undefined;

function parseHttpUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Only HTTP and HTTPS URLs are allowed');
  if (url.username || url.password) throw new Error('URLs containing credentials are not allowed');
  return url;
}

function createDomBootstrap(platform: 'android' | 'ios', apiUrl: string): string {
  // Expo Go 57.0.3 ships React Native WebView without ExpoDomWebView's native ViewManager.
  // Its fallback WebView also omits injectedObjectJson on some Android WebView builds, so
  // polyfill the exact JSON hook that Expo's generated DOM HTML reads at document start.
  const initialProps = {
    names: ['nativeRequest', 'cancelNativeRequest', 'openExternalUrl', 'copyText', 'setNativeColorMode'],
    props: { controlPlaneUrl: apiUrl, hostPlatform: platform },
  };
  const injectedObjectJson = JSON.stringify({
    EXPO_DOM_HOST_OS: platform,
    initialProps,
  });
  return [
    "if (!window.ReactNativeWebView) { throw new Error('React Native WebView bridge is unavailable'); }",
    `if (typeof window.ReactNativeWebView.injectedObjectJson !== 'function') { Object.defineProperty(window.ReactNativeWebView, 'injectedObjectJson', { configurable: true, value: function () { return ${JSON.stringify(injectedObjectJson)}; } }); }`,
    'true;',
  ].join('\n');
}

export default function App() {
  const requestControllers = useRef(new Map<string, AbortController>());
  const systemColorScheme = useColorScheme();
  const [workspaceColorMode, setWorkspaceColorMode] = useState<'light' | 'dark'>(systemColorScheme === 'dark' ? 'dark' : 'light');

  const nativeRequest = useCallback(async (request: NativeHttpRequest): Promise<NativeHttpResponse> => {
    const requestUrl = parseHttpUrl(request.url);
    const configuredControlPlane = parseHttpUrl(controlPlaneUrl);
    if (requestUrl.origin !== configuredControlPlane.origin) throw new Error('Native API requests must use the configured control plane');
    const controller = new AbortController();
    requestControllers.current.set(request.id, controller);
    try {
      const response = await fetch(requestUrl.href, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        signal: controller.signal,
      });
      return { status: response.status, body: await response.text() };
    } finally {
      requestControllers.current.delete(request.id);
    }
  }, []);

  const cancelNativeRequest = useCallback(async (id: string): Promise<void> => {
    requestControllers.current.get(id)?.abort();
  }, []);

  const openExternalUrl = useCallback(async (url: string): Promise<void> => {
    await Linking.openURL(parseHttpUrl(url).href);
  }, []);

  const copyText = useCallback(async (value: string): Promise<void> => {
    await Clipboard.setStringAsync(value);
  }, []);

  const setNativeColorMode = useCallback(async (mode: 'light' | 'dark'): Promise<void> => {
    setWorkspaceColorMode(mode);
  }, []);

  return (
    <SafeAreaProvider>
      <SafeAreaView
        edges={['top', 'right', 'bottom', 'left']}
        style={[styles.safeArea, workspaceColorMode === 'dark' && styles.safeAreaDark]}
      >
        <StatusBar style={workspaceColorMode === 'dark' ? 'light' : 'dark'} />
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={styles.keyboardAvoiding}
        >
          <CodWorkspace
            controlPlaneUrl={controlPlaneUrl}
            hostPlatform={hostPlatform}
            nativeRequest={nativeRequest}
            cancelNativeRequest={cancelNativeRequest}
            openExternalUrl={openExternalUrl}
            copyText={copyText}
            setNativeColorMode={setNativeColorMode}
            dom={{
              useExpoDOMWebView: false,
              scrollEnabled: false,
              contentInsetAdjustmentBehavior: 'never',
              injectedJavaScriptBeforeContentLoaded: domBootstrap,
              style: styles.workspace,
            }}
          />
        </KeyboardAvoidingView>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#fbfdfd',
  },
  safeAreaDark: {
    backgroundColor: '#0b1416',
  },
  keyboardAvoiding: {
    flex: 1,
  },
  workspace: {
    flex: 1,
    alignSelf: 'stretch',
  },
});
