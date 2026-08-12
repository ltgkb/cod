'use dom';

import { useEffect } from 'react';
import type { DOMImperativeFactory } from 'expo/dom';
import type { Ref } from 'react';

import { App } from '../../web/src/App';
import { configureCodRuntime, dispatchCodNativeBack } from '../../web/src/runtime';
import type { NativeHttpRequest, NativeHttpResponse } from '../../web/src/runtime';
import { ensureExpoDomGlobals } from './dom-bootstrap';
import { domNativeActions, installNativeBackHandle } from './dom-native-bridge';
import '../../web/src/styles.css';

const fallbackControlPlaneUrl = process.env.EXPO_PUBLIC_COD_CONTROL_PLANE_URL ?? 'https://cod.kai.com';
ensureExpoDomGlobals(fallbackControlPlaneUrl);

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
  controlPlaneUrl,
  hostPlatform,
}: CodWorkspaceProps) {
  useEffect(() => installNativeBackHandle(() => {
    dispatchCodNativeBack();
  }), []);

  configureCodRuntime({
    controlPlaneUrl,
    hostPlatform,
    ...domNativeActions,
  });
  return <App />;
}
