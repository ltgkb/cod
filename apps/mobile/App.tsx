import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, BackHandler, KeyboardAvoidingView, Linking, NativeModules, Platform, StyleSheet, Text, useColorScheme, View } from 'react-native';
import { isRunningInExpoGo } from 'expo';
import Constants from 'expo-constants';
import * as Crypto from 'expo-crypto';
import { StatusBar } from 'expo-status-bar';
import * as Clipboard from 'expo-clipboard';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import CodWorkspace from './src/CodWorkspace.dom';
import type { CodWorkspaceHandle } from './src/CodWorkspace.dom';
import { resolveDevelopmentServerOrigin } from './src/development-origin';
import { forwardNativeBack } from './src/native-back';
import { decideDomNavigation, domOriginWhitelist } from './src/navigation-policy';
import { createNativeBridgeDocumentStartScript, runAuthorizedNativeBridgeAction } from './src/native-bridge-security';
import { shouldObscureWorkspace } from './src/privacy-state';
import { clearSessionToken, loadSessionCleanupPending, loadSessionToken, saveSessionToken } from './src/session-store';
import type { NativeHttpRequest, NativeHttpResponse } from '../web/src/runtime';

const controlPlaneUrl = process.env.EXPO_PUBLIC_COD_CONTROL_PLANE_URL ?? 'https://cod.kai.com';
const hostPlatform = Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : undefined;
const runningInExpoGo = isRunningInExpoGo();

function getDevelopmentServerOrigin(): string | undefined {
  if (!__DEV__) return undefined;
  const sourceCode = NativeModules.SourceCode as {
    getConstants?: () => { scriptURL?: unknown };
    scriptURL?: unknown;
  } | undefined;
  let sourceCodeScriptUrl: unknown;
  try {
    sourceCodeScriptUrl = sourceCode?.getConstants?.().scriptURL ?? sourceCode?.scriptURL;
  } catch {
    sourceCodeScriptUrl = undefined;
  }
  return resolveDevelopmentServerOrigin(
    sourceCodeScriptUrl,
    Constants.expoGoConfig?.debuggerHost,
    Constants.expoConfig?.hostUri,
  );
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
  const nativeBackAvailableRef = useRef(false);
  const systemColorScheme = useColorScheme();
  const [workspaceColorMode, setWorkspaceColorMode] = useState<'light' | 'dark'>(systemColorScheme === 'dark' ? 'dark' : 'light');
  const [workspaceObscured, setWorkspaceObscured] = useState(() => shouldObscureWorkspace(AppState.currentState));
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
            nativeRequest={(capability,request)=>runAuthorizedNativeBridgeAction(capability,nativeBridgeCapability,()=>nativeRequest(request))}
            cancelNativeRequest={(capability,id)=>runAuthorizedNativeBridgeAction(capability,nativeBridgeCapability,()=>cancelNativeRequest(id))}
            openExternalUrl={(capability,url)=>runAuthorizedNativeBridgeAction(capability,nativeBridgeCapability,()=>openExternalUrl(url))}
            copyText={(capability,value)=>runAuthorizedNativeBridgeAction(capability,nativeBridgeCapability,()=>copyText(value))}
            setNativeColorMode={(capability,mode)=>runAuthorizedNativeBridgeAction(capability,nativeBridgeCapability,()=>setNativeColorMode(mode))}
            setNativeBackAvailable={(capability,available)=>runAuthorizedNativeBridgeAction(capability,nativeBridgeCapability,()=>setNativeBackAvailable(available))}
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
