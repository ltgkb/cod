import { useCallback, useEffect, useRef, useState } from 'react';
import { BackHandler, KeyboardAvoidingView, Linking, Platform, StyleSheet, useColorScheme } from 'react-native';
import { isRunningInExpoGo } from 'expo';
import Constants from 'expo-constants';
import * as Crypto from 'expo-crypto';
import { StatusBar } from 'expo-status-bar';
import * as Clipboard from 'expo-clipboard';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import CodWorkspace from './src/CodWorkspace.dom';
import type { CodWorkspaceHandle } from './src/CodWorkspace.dom';
import { decideDomNavigation, domOriginWhitelist } from './src/navigation-policy';
import { createNativeBridgeDocumentStartScript, runAuthorizedNativeBridgeAction } from './src/native-bridge-security';
import { clearSessionToken, loadSessionCleanupPending, loadSessionToken, saveSessionToken } from './src/session-store';
import type { NativeHttpRequest, NativeHttpResponse } from '../web/src/runtime';

const controlPlaneUrl = process.env.EXPO_PUBLIC_COD_CONTROL_PLANE_URL ?? 'https://cod.kai.com';
const hostPlatform = Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : undefined;
const runningInExpoGo = isRunningInExpoGo();

function getDevelopmentServerOrigin(): string | undefined {
  if (!__DEV__) return undefined;
  const debuggerHost = Constants.expoGoConfig?.debuggerHost ?? Constants.expoConfig?.hostUri;
  return debuggerHost ? new URL(`http://${debuggerHost}`).origin : undefined;
}

const developmentServerOrigin = getDevelopmentServerOrigin();

function getExpoGoDomUri(): string {
  if (!developmentServerOrigin) throw new Error('Expo Go did not provide its Metro host');
  return new URL('/_cod/expo-dom-bootstrap', developmentServerOrigin).href;
}

function parseHttpUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Only HTTP and HTTPS URLs are allowed');
  if (url.username || url.password) throw new Error('URLs containing credentials are not allowed');
  return url;
}

export default function App() {
  const requestControllers = useRef(new Map<string, AbortController>());
  const workspaceRef = useRef<CodWorkspaceHandle>(null);
  const hasTopmostUiRef = useRef(false);
  const systemColorScheme = useColorScheme();
  const [workspaceColorMode, setWorkspaceColorMode] = useState<'light' | 'dark'>(systemColorScheme === 'dark' ? 'dark' : 'light');
  const [nativeBridgeCapability] = useState(() => Crypto.randomUUID());
  const [documentStartScript] = useState(() => createNativeBridgeDocumentStartScript(nativeBridgeCapability, __DEV__, hostPlatform, developmentServerOrigin));
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

  const setNativeTopmostUiVisible = useCallback(async (visible: boolean): Promise<void> => {
    hasTopmostUiRef.current = visible;
  }, []);

  useEffect(() => {
    if (Platform.OS !== 'android') return undefined;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!hasTopmostUiRef.current || !workspaceRef.current) return false;
      workspaceRef.current.closeTopmostUi();
      return true;
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
        >
          <CodWorkspace
            ref={workspaceRef}
            controlPlaneUrl={controlPlaneUrl}
            hostPlatform={hostPlatform}
            nativeRequest={(capability,request)=>runAuthorizedNativeBridgeAction(capability,nativeBridgeCapability,()=>nativeRequest(request))}
            cancelNativeRequest={(capability,id)=>runAuthorizedNativeBridgeAction(capability,nativeBridgeCapability,()=>cancelNativeRequest(id))}
            openExternalUrl={(capability,url)=>runAuthorizedNativeBridgeAction(capability,nativeBridgeCapability,()=>openExternalUrl(url))}
            copyText={(capability,value)=>runAuthorizedNativeBridgeAction(capability,nativeBridgeCapability,()=>copyText(value))}
            setNativeColorMode={(capability,mode)=>runAuthorizedNativeBridgeAction(capability,nativeBridgeCapability,()=>setNativeColorMode(mode))}
            setNativeTopmostUiVisible={(capability,visible)=>runAuthorizedNativeBridgeAction(capability,nativeBridgeCapability,()=>setNativeTopmostUiVisible(visible))}
            loadSessionCleanupPending={(capability)=>runAuthorizedNativeBridgeAction(capability,nativeBridgeCapability,()=>loadSessionCleanupPending())}
            loadSessionToken={(capability)=>runAuthorizedNativeBridgeAction(capability,nativeBridgeCapability,()=>loadSessionToken())}
            saveSessionToken={(capability,token)=>runAuthorizedNativeBridgeAction(capability,nativeBridgeCapability,()=>saveSessionToken(token))}
            clearSessionToken={(capability,expectedToken)=>runAuthorizedNativeBridgeAction(capability,nativeBridgeCapability,()=>clearSessionToken(expectedToken))}
            dom={{
              // The Expo DOM WebView does not implement the navigation-policy props below.
              // React Native WebView supports them while retaining Expo's function-prop bridge.
              useExpoDOMWebView: false,
              overrideUri: runningInExpoGo ? getExpoGoDomUri() : undefined,
              originWhitelist: domOriginWhitelist(developmentServerOrigin),
              // RN WebView for Android only re-installs injectedObjectJson at
              // page start when this document-start hook is non-empty.
              injectedJavaScriptBeforeContentLoaded: documentStartScript,
              injectedJavaScriptBeforeContentLoadedForMainFrameOnly: true,
              // Android documents the document-start hook as best-effort. The
              // same URL-gated bootstrap runs again after load while the DOM
              // bundle waits for the capability instead of crashing.
              injectedJavaScript: documentStartScript,
              injectedJavaScriptForMainFrameOnly: true,
              onShouldStartLoadWithRequest: (request) => {
                const decision = decideDomNavigation(request.url, request.isTopFrame, developmentServerOrigin,hostPlatform);
                if (decision === 'allow') return true;
                if (decision === 'external') void openExternalUrl(request.url).catch(() => undefined);
                return false;
              },
              setSupportMultipleWindows: false,
              javaScriptCanOpenWindowsAutomatically: false,
              allowFileAccess: true,
              allowFileAccessFromFileURLs: false,
              allowUniversalAccessFromFileURLs: false,
              mixedContentMode: 'never',
              scrollEnabled: false,
              contentInsetAdjustmentBehavior: 'never',
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
