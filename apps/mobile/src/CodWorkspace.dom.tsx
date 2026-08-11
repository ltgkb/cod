'use dom';

import { forwardRef, useEffect, useState } from 'react';
import { useDOMImperativeHandle } from 'expo/dom';
import type { DOMImperativeFactory } from 'expo/dom';

import { App } from '../../web/src/App';
import { configureCodRuntime, requestCodTopmostUiClose } from '../../web/src/runtime';
import type { NativeHttpRequest, NativeHttpResponse } from '../../web/src/runtime';
import { nativeBridgeCapabilityReadyEvent, tryReadNativeBridgeCapability } from './native-bridge-security';
import '../../web/src/styles.css';

export interface CodWorkspaceHandle extends DOMImperativeFactory {
  closeTopmostUi: () => void;
}

interface CodWorkspaceProps {
  controlPlaneUrl: string;
  hostPlatform?: 'android' | 'ios';
  nativeRequest: (capability: string, request: NativeHttpRequest) => Promise<NativeHttpResponse>;
  cancelNativeRequest: (capability: string, id: string) => Promise<void>;
  openExternalUrl: (capability: string, url: string) => Promise<void>;
  copyText: (capability: string, value: string) => Promise<void>;
  setNativeColorMode: (capability: string, mode: 'light' | 'dark') => Promise<void>;
  setNativeTopmostUiVisible: (capability: string, visible: boolean) => Promise<void>;
  loadSessionCleanupPending: (capability: string) => Promise<boolean>;
  loadSessionToken: (capability: string) => Promise<string | null>;
  saveSessionToken: (capability: string, token: string) => Promise<void>;
  clearSessionToken: (capability: string, expectedToken?: string) => Promise<boolean>;
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
  loadSessionCleanupPending,
  loadSessionToken,
  saveSessionToken,
  clearSessionToken,
}, ref) {
  const [nativeBridgeCapability,setNativeBridgeCapability]=useState(tryReadNativeBridgeCapability);
  useEffect(()=>{
    const root=document.documentElement;
    const previousHostPlatform=root.dataset.codHostPlatform;
    if(hostPlatform)root.dataset.codHostPlatform=hostPlatform;
    else delete root.dataset.codHostPlatform;
    return()=>{
      if(previousHostPlatform)root.dataset.codHostPlatform=previousHostPlatform;
      else delete root.dataset.codHostPlatform;
    };
  },[hostPlatform]);
  useEffect(()=>{
    if(nativeBridgeCapability)return undefined;
    const readCapability=()=>{
      const nextCapability=tryReadNativeBridgeCapability();
      if(nextCapability)setNativeBridgeCapability(nextCapability);
    };
    window.addEventListener(nativeBridgeCapabilityReadyEvent,readCapability);
    const retry=window.setInterval(readCapability,25);
    readCapability();
    return()=>{window.removeEventListener(nativeBridgeCapabilityReadyEvent,readCapability);window.clearInterval(retry);};
  },[nativeBridgeCapability]);
  useDOMImperativeHandle(ref, () => ({ closeTopmostUi: requestCodTopmostUiClose }), []);
  if(!nativeBridgeCapability){
    return <main role="status" aria-live="polite">正在安全启动 COD…</main>;
  }
  configureCodRuntime({
    controlPlaneUrl,
    hostPlatform,
    nativeRequest:(request)=>nativeRequest(nativeBridgeCapability,request),
    cancelNativeRequest:(id)=>cancelNativeRequest(nativeBridgeCapability,id),
    openExternalUrl:(url)=>openExternalUrl(nativeBridgeCapability,url),
    copyText:(value)=>copyText(nativeBridgeCapability,value),
    setNativeColorMode:(mode)=>setNativeColorMode(nativeBridgeCapability,mode),
    setNativeTopmostUiVisible:(visible)=>setNativeTopmostUiVisible(nativeBridgeCapability,visible),
    loadSessionCleanupPending:()=>loadSessionCleanupPending(nativeBridgeCapability),
    loadSessionToken:()=>loadSessionToken(nativeBridgeCapability),
    saveSessionToken:(token)=>saveSessionToken(nativeBridgeCapability,token),
    clearSessionToken:(expectedToken)=>clearSessionToken(nativeBridgeCapability,expectedToken),
  });
  return <App />;
});

export default CodWorkspace;
