import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, BackHandler, KeyboardAvoidingView, Linking, Platform, StyleSheet, Text, useColorScheme, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as Clipboard from 'expo-clipboard';
import Constants, { AppOwnership } from 'expo-constants';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import CodWorkspace, { type CodWorkspaceRef } from './src/CodWorkspace.dom';
import { createDomBootstrap } from './src/dom-bootstrap';
import { forwardNativeBack } from './src/native-back';
import { shouldObscureWorkspace } from './src/privacy-state';
import type { NativeHttpRequest, NativeHttpResponse } from '../web/src/runtime';

const controlPlaneUrl = process.env.EXPO_PUBLIC_COD_CONTROL_PLANE_URL ?? 'https://cod.kai.com';
const hostPlatform = Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : undefined;
const domBootstrap = hostPlatform ? createDomBootstrap(hostPlatform, controlPlaneUrl) : undefined;
const isExpoGo = Constants.appOwnership === AppOwnership.Expo;

function parseHttpUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Only HTTP and HTTPS URLs are allowed');
  if (url.username || url.password) throw new Error('URLs containing credentials are not allowed');
  return url;
}

export default function App() {
  const requestControllers = useRef(new Map<string, AbortController>());
  const workspaceRef = useRef<CodWorkspaceRef>(null);
  const nativeBackAvailableRef = useRef(false);
  const systemColorScheme = useColorScheme();
  const [workspaceColorMode, setWorkspaceColorMode] = useState<'light' | 'dark'>(systemColorScheme === 'dark' ? 'dark' : 'light');
  const [workspaceObscured, setWorkspaceObscured] = useState(() => shouldObscureWorkspace(AppState.currentState));

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

  const setNativeBackAvailable = useCallback(async (available: boolean): Promise<void> => {
    nativeBackAvailableRef.current = available;
  }, []);

  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => (
      forwardNativeBack(nativeBackAvailableRef.current, workspaceRef.current)
    ));
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      setWorkspaceObscured(shouldObscureWorkspace(state));
    });
    return () => subscription.remove();
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
          accessibilityElementsHidden={workspaceObscured}
          importantForAccessibility={workspaceObscured ? 'no-hide-descendants' : 'auto'}
        >
          <CodWorkspace
            ref={workspaceRef}
            controlPlaneUrl={controlPlaneUrl}
            hostPlatform={hostPlatform}
            nativeRequest={nativeRequest}
            cancelNativeRequest={cancelNativeRequest}
            openExternalUrl={openExternalUrl}
            copyText={copyText}
            setNativeColorMode={setNativeColorMode}
            setNativeBackAvailable={setNativeBackAvailable}
            dom={{
              useExpoDOMWebView: !isExpoGo,
              scrollEnabled: false,
              contentInsetAdjustmentBehavior: 'never',
              injectedJavaScriptBeforeContentLoaded: domBootstrap,
              style: styles.workspace,
            }}
          />
        </KeyboardAvoidingView>
        {workspaceObscured && (
          <View
            accessibilityLabel="COD 已隐藏工作区"
            accessibilityRole="text"
            style={[styles.privacyCover, workspaceColorMode === 'dark' && styles.privacyCoverDark]}
          >
            <View style={styles.privacyMark}><Text style={styles.privacyMarkText}>C</Text></View>
            <Text style={[styles.privacyTitle, workspaceColorMode === 'dark' && styles.privacyTextDark]}>COD 工作区已隐藏</Text>
            <Text style={[styles.privacyCaption, workspaceColorMode === 'dark' && styles.privacyTextDark]}>回到应用后继续</Text>
          </View>
        )}
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
  privacyCover: {
    alignItems: 'center',
    backgroundColor: '#fbfdfd',
    bottom: 0,
    justifyContent: 'center',
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
    zIndex: 100,
  },
  privacyCoverDark: {
    backgroundColor: '#0b1416',
  },
  privacyMark: {
    alignItems: 'center',
    backgroundColor: '#0d7f82',
    borderRadius: 18,
    height: 56,
    justifyContent: 'center',
    marginBottom: 18,
    width: 56,
  },
  privacyMarkText: {
    color: '#ffffff',
    fontSize: 26,
    fontWeight: '800',
  },
  privacyTitle: {
    color: '#102a2d',
    fontSize: 17,
    fontWeight: '700',
  },
  privacyCaption: {
    color: '#627477',
    fontSize: 13,
    marginTop: 7,
  },
  privacyTextDark: {
    color: '#e9f3f3',
  },
});
