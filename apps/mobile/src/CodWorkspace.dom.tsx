'use dom';

import { forwardRef } from 'react';
import { useDOMImperativeHandle } from 'expo/dom';
import type { DOMImperativeFactory } from 'expo/dom';

import { App } from '../../web/src/App';
import { configureCodRuntime, requestCodTopmostUiClose } from '../../web/src/runtime';
import type { NativeHttpRequest, NativeHttpResponse } from '../../web/src/runtime';
import '../../web/src/styles.css';

export interface CodWorkspaceHandle extends DOMImperativeFactory {
  closeTopmostUi: () => void;
}

interface CodWorkspaceProps {
  controlPlaneUrl: string;
  hostPlatform?: 'android' | 'ios';
  nativeRequest: (request: NativeHttpRequest) => Promise<NativeHttpResponse>;
  cancelNativeRequest: (id: string) => Promise<void>;
  openExternalUrl: (url: string) => Promise<void>;
  copyText: (value: string) => Promise<void>;
  setNativeColorMode: (mode: 'light' | 'dark') => Promise<void>;
  setNativeTopmostUiVisible: (visible: boolean) => Promise<void>;
  dom?: import('expo/dom').DOMProps;
}

const CodWorkspace = forwardRef<CodWorkspaceHandle, CodWorkspaceProps>(function CodWorkspace({
  controlPlaneUrl,
  hostPlatform,
  nativeRequest,
  cancelNativeRequest,
  openExternalUrl,
  copyText,
  setNativeColorMode,
  setNativeTopmostUiVisible,
}, ref) {
  useDOMImperativeHandle(ref, () => ({ closeTopmostUi: requestCodTopmostUiClose }), []);
  configureCodRuntime({
    controlPlaneUrl,
    hostPlatform,
    nativeRequest,
    cancelNativeRequest,
    openExternalUrl,
    copyText,
    setNativeColorMode,
    setNativeTopmostUiVisible,
  });
  return <App />;
});

export default CodWorkspace;
