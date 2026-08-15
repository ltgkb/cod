'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

function read(relativePath) {
  return fs.readFileSync(path.resolve(__dirname, relativePath), 'utf8');
}

test('release uses the policy-capable WebView and preserves Expo DOM bootstrap injection', () => {
  const app = read('../App.tsx');
  const webApp = read('../../web/src/App.tsx');
  const presentation = read('../../web/src/presentation.tsx');
  assert.match(app, /useExpoDOMWebView:\s*false/);
  assert.match(app, /injectedJavaScriptBeforeContentLoaded:\s*documentStartScript/);
  assert.match(app, /injectedJavaScriptBeforeContentLoadedForMainFrameOnly:\s*true/);
  assert.match(app, /injectedJavaScript:\s*documentStartScript/);
  assert.match(app, /injectedJavaScriptForMainFrameOnly:\s*true/);
  assert.match(app, /allowFileAccessFromFileURLs:\s*false/);
  assert.match(app, /allowUniversalAccessFromFileURLs:\s*false/);
  assert.match(app, /scrollEnabled:\s*true/);
  assert.match(app, /runAuthorizedNativeBridgeAction/);
  assert.doesNotMatch(webApp, /<a\b|href=/);
  assert.doesNotMatch(presentation, /<a\b|href=/);

  const expoWrapper = read('../../../node_modules/expo/src/dom/webview-wrapper.tsx');
  assert.match(expoWrapper, /const source = \{ uri: overrideUri \?\? `\$\{getBaseURL\(\)\}\/\$\{filePath\}` \}/);
  assert.match(expoWrapper, /injectedJavaScriptObject:\s*\{[\s\S]*initialProps:\s*initialPropsRef\.current/);
  assert.match(expoWrapper, /const useExpoDOMWebView = dom\?\.useExpoDOMWebView \?\? true/);

  const expoBase = read('../../../node_modules/expo/src/dom/base.ts');
  assert.match(expoBase, /process\.env\.NODE_ENV === 'production'[\s\S]*file:\/\/\/android_asset\/www\.bundle[\s\S]*cachedBaseUrl = 'www\.bundle'/);

  const androidClient = read('../../../node_modules/react-native-webview/android/src/main/java/com/reactnativecommunity/webview/RNCWebViewClient.java');
  const androidWebView = read('../../../node_modules/react-native-webview/android/src/main/java/com/reactnativecommunity/webview/RNCWebView.java');
  const androidTopNavigationEvent = read('../../../node_modules/react-native-webview/android/src/main/java/com/reactnativecommunity/webview/events/TopShouldStartLoadWithRequestEvent.kt');
  assert.match(androidClient, /onPageStarted[\s\S]*callInjectedJavaScriptBeforeContentLoaded\(\)/);
  assert.match(androidClient, /SHOULD_OVERRIDE_URL_LOADING_TIMEOUT/);
  assert.match(androidClient, /cod:fail-closed-navigation-v1/);
  assert.match(androidClient, /defaulting to block loading[\s\S]*return true;/);
  assert.doesNotMatch(androidClient, /defaulting to allow loading/);
  assert.match(androidWebView, /callInjectedJavaScriptBeforeContentLoaded\(\)[\s\S]*injectedJSBeforeContentLoaded[\s\S]*injectJavascriptObject\(\)/);
  assert.match(androidWebView, /injectedObjectJson = function \(\)/);
  assert.match(androidTopNavigationEvent, /isTopFrame["']?,\s*true/);

  const iosWebView = read('../../../node_modules/react-native-webview/apple/RNCWebViewImpl.m');
  assert.match(iosWebView, /injectedObjectJson = function \(\)[\s\S]*WKUserScriptInjectionTimeAtDocumentStart/);
});

test('pins Expo DOM generation to a strict CSP and gates every native action with the main-document capability', () => {
  const template = read('../../../node_modules/@expo/cli/build/src/start/server/middleware/DomComponentsMiddleware.js');
  assert.match(template, /cod:strict-dom-csp-v1/);
  assert.match(template, /frame-src 'none'/);
  assert.match(template, /connect-src 'none'/);
  assert.match(template, /script-src 'self'/);

  const app = read('../App.tsx');
  const dom = read('../src/CodWorkspace.dom.tsx');
  const bootstrap = read('./expo-dom-bootstrap.cjs');
  const verifier = read('./verify-dom-release.cjs');
  assert.doesNotMatch(app, /initialProps[\s\S]{0,200}nativeBridgeCapability/);
  assert.match(dom, /tryReadNativeBridgeCapability/);
  assert.match(dom, /setInterval\(readCapability,25\)/);
  for (const action of ['nativeRequest','cancelNativeRequest','openExternalUrl','copyText','setNativeColorMode','setNativeBackAvailable','loadSessionCleanupPending','loadSessionToken','saveSessionToken','clearSessionToken']) {
    assert.match(app,new RegExp(`${action}=\\{\\(capability`));
    assert.match(dom,new RegExp(`${action}:.*nativeBridgeCapability`));
  }
  assert.match(bootstrap,/frame-src 'none'/);
  assert.match(bootstrap,/child-src 'none'/);
  assert.match(bootstrap,/connect-src 'none'/);
  assert.match(bootstrap,/object-src 'none'/);
  assert.match(bootstrap,/base-uri 'none'/);
  assert.match(bootstrap,/form-action 'none'/);
  assert.match(verifier,/must not use unsafe-eval/);
  assert.match(verifier,/production script-src must contain only self and exact inline-script hashes/);
});
