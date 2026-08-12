import type { NativeHttpRequest, NativeHttpResponse } from '../../web/src/runtime';

const DOM_EVENT = '$$dom_event';
const NATIVE_ACTION = '$$native_action';
const NATIVE_ACTION_RESULT = '$$native_action_result';
const REGISTER_DOM_IMPERATIVE_HANDLE_PROPS = '$$register_dom_imperative_handle_props';

interface NativeBridgeMessage {
  type: string;
  data: {
    uid: string;
    actionId: string;
    result?: unknown;
    error?: { message?: string; stack?: string } | unknown;
  };
}

export interface DomNativeBridgeHost {
  ReactNativeWebView?: { postMessage?: (message: string) => void };
  _domRefProxy?: { handleNativeBack: () => void };
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
}

function getBridge(host: DomNativeBridgeHost): (message: string) => void {
  const bridge = host.ReactNativeWebView;
  const postMessage = bridge?.postMessage;
  if (typeof postMessage !== 'function') {
    throw new Error('React Native WebView bridge is unavailable');
  }
  return postMessage.bind(bridge);
}

function errorFromNative(value: NativeBridgeMessage['data']['error']): Error {
  if (!value || typeof value !== 'object') return new Error(String(value));
  const shaped = value as { message?: string; stack?: string };
  const error = new Error(shaped.message ?? 'Native action failed');
  if (shaped.stack) error.stack = shaped.stack;
  return error;
}

export function invokeNativeAction<TResult>(
  actionId: string,
  args: unknown[],
  host: DomNativeBridgeHost = window,
): Promise<TResult> {
  const postMessage = getBridge(host);
  const uid = Math.random().toString(36).slice(2);

  return new Promise<TResult>((resolve, reject) => {
    const listener: EventListener = (event) => {
      const message = (event as CustomEvent<NativeBridgeMessage>).detail;
      if (
        message?.type !== NATIVE_ACTION_RESULT
        || message.data.uid !== uid
        || message.data.actionId !== actionId
      ) return;

      host.removeEventListener(DOM_EVENT, listener);
      if ('error' in message.data && message.data.error !== undefined) {
        reject(errorFromNative(message.data.error));
        return;
      }
      resolve(message.data.result as TResult);
    };

    host.addEventListener(DOM_EVENT, listener);
    try {
      postMessage(JSON.stringify({ type: NATIVE_ACTION, data: { uid, actionId, args } }));
    } catch (error) {
      host.removeEventListener(DOM_EVENT, listener);
      reject(error);
    }
  });
}

export const domNativeActions = {
  nativeRequest: (request: NativeHttpRequest) => invokeNativeAction<NativeHttpResponse>('nativeRequest', [request]),
  cancelNativeRequest: (id: string) => invokeNativeAction<void>('cancelNativeRequest', [id]),
  openExternalUrl: (url: string) => invokeNativeAction<void>('openExternalUrl', [url]),
  copyText: (value: string) => invokeNativeAction<void>('copyText', [value]),
  setNativeColorMode: (mode: 'light' | 'dark') => invokeNativeAction<void>('setNativeColorMode', [mode]),
  setNativeBackAvailable: (available: boolean) => invokeNativeAction<void>('setNativeBackAvailable', [available]),
};

export function installNativeBackHandle(
  handleNativeBack: () => void,
  host: DomNativeBridgeHost = window,
): () => void {
  const proxy = { handleNativeBack };
  host._domRefProxy = proxy;
  getBridge(host)(JSON.stringify({
    type: REGISTER_DOM_IMPERATIVE_HANDLE_PROPS,
    data: ['handleNativeBack'],
  }));
  return () => {
    if (host._domRefProxy === proxy) host._domRefProxy = undefined;
  };
}
