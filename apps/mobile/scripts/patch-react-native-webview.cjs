'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PATCH_MARKER = 'cod:fail-closed-navigation-v1';
const androidWebViewClientPath = path.resolve(
  __dirname,
  '../../../node_modules/react-native-webview/android/src/main/java/com/reactnativecommunity/webview/RNCWebViewClient.java'
);

const timeoutOriginal = `                            FLog.w(TAG, "Did not receive response to shouldOverrideUrlLoading in time, defaulting to allow loading.");
                            RNCWebViewModuleImpl.shouldOverrideUrlLoadingLock.removeLock(lockIdentifier);
                            return false;`;
const timeoutPatched = `                            // ${PATCH_MARKER}
                            FLog.w(TAG, "Did not receive response to shouldOverrideUrlLoading in time, defaulting to block loading.");
                            RNCWebViewModuleImpl.shouldOverrideUrlLoadingLock.removeLock(lockIdentifier);
                            return true;`;
const interruptionOriginal = `                FLog.e(TAG, "shouldOverrideUrlLoading was interrupted while waiting for result.", e);
                RNCWebViewModuleImpl.shouldOverrideUrlLoadingLock.removeLock(lockIdentifier);
                return false;`;
const interruptionPatched = `                FLog.e(TAG, "shouldOverrideUrlLoading was interrupted while waiting for result; blocking navigation.", e);
                RNCWebViewModuleImpl.shouldOverrideUrlLoadingLock.removeLock(lockIdentifier);
                return true;`;

function patchReactNativeWebView(filename = androidWebViewClientPath) {
  const source = fs.readFileSync(filename, 'utf8');
  if (source.includes(PATCH_MARKER)) return false;
  if (!source.includes(timeoutOriginal) || !source.includes(interruptionOriginal)) {
    throw new Error('Unsupported react-native-webview Android navigation client; refusing to build without fail-closed navigation');
  }
  fs.writeFileSync(filename, source.replace(timeoutOriginal, timeoutPatched).replace(interruptionOriginal, interruptionPatched));
  return true;
}

if (require.main === module) patchReactNativeWebView();

module.exports = { PATCH_MARKER, androidWebViewClientPath, patchReactNativeWebView };
