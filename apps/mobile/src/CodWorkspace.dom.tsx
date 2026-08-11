'use dom';

import { useDOMImperativeHandle, type DOMImperativeFactory } from 'expo/dom';
import type { Ref } from 'react';

import { App } from '../../web/src/App';
import { configureCodRuntime, dispatchCodNativeBack } from '../../web/src/runtime';
import type { NativeHttpRequest, NativeHttpResponse } from '../../web/src/runtime';
import '../../web/src/styles.css';

export interface CodWorkspaceRef extends DOMImperativeFactory {
  handleNativeBack: () => void;
}

interface CodWorkspaceProps {
  ref: Ref<CodWorkspaceRef>;
  controlPlaneUrl: string;
  hostPlatform?: 'android' | 'ios';
  nativeRequest: (request: NativeHttpRequest) => Promise<NativeHttpResponse>;
  cancelNativeRequest: (id: string) => Promise<void>;
  openExternalUrl: (url: string) => Promise<void>;
  copyText: (value: string) => Promise<void>;
  setNativeColorMode: (mode: 'light' | 'dark') => Promise<void>;
  setNativeBackAvailable: (available: boolean) => Promise<void>;
  dom?: import('expo/dom').DOMProps;
}

export default function CodWorkspace({
  ref,
  controlPlaneUrl,
  hostPlatform,
  nativeRequest,
  cancelNativeRequest,
  openExternalUrl,
  copyText,
  setNativeColorMode,
  setNativeBackAvailable,
}: CodWorkspaceProps) {
  useDOMImperativeHandle(ref, () => ({
    handleNativeBack: () => {
      dispatchCodNativeBack();
    },
  }), []);

  configureCodRuntime({
    controlPlaneUrl,
    hostPlatform,
    nativeRequest,
    cancelNativeRequest,
    openExternalUrl,
    copyText,
    setNativeColorMode,
    setNativeBackAvailable,
  });
  return <App />;
}
