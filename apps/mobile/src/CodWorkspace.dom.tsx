'use dom';

import { App } from '../../web/src/App';
import { configureCodRuntime } from '../../web/src/runtime';
import type { NativeHttpRequest, NativeHttpResponse } from '../../web/src/runtime';
import '../../web/src/styles.css';

interface CodWorkspaceProps {
  controlPlaneUrl: string;
  hostPlatform?: 'android' | 'ios';
  nativeRequest: (request: NativeHttpRequest) => Promise<NativeHttpResponse>;
  cancelNativeRequest: (id: string) => Promise<void>;
  openExternalUrl: (url: string) => Promise<void>;
  copyText: (value: string) => Promise<void>;
  setNativeColorMode: (mode: 'light' | 'dark') => Promise<void>;
  dom?: import('expo/dom').DOMProps;
}

export default function CodWorkspace({
  controlPlaneUrl,
  hostPlatform,
  nativeRequest,
  cancelNativeRequest,
  openExternalUrl,
  copyText,
  setNativeColorMode,
}: CodWorkspaceProps) {
  configureCodRuntime({
    controlPlaneUrl,
    hostPlatform,
    nativeRequest,
    cancelNativeRequest,
    openExternalUrl,
    copyText,
    setNativeColorMode,
  });
  return <App />;
}
