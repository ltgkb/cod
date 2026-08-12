import { describe, expect, it, vi } from 'vitest';

import {
  installNativeBackHandle,
  invokeNativeAction,
  type DomNativeBridgeHost,
} from './dom-native-bridge';

function createHost() {
  const listeners = new Map<string, Set<EventListener>>();
  const host: DomNativeBridgeHost = {
    ReactNativeWebView: { postMessage: vi.fn() },
    addEventListener(type, listener) {
      const entries = listeners.get(type) ?? new Set<EventListener>();
      entries.add(listener);
      listeners.set(type, entries);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
  };
  return {
    host,
    emit(type: string, detail: unknown) {
      for (const listener of listeners.get(type) ?? []) {
        listener({ detail } as unknown as Event);
      }
    },
  };
}

describe('DOM native bridge', () => {
  it('resolves the matching native action result and removes its listener', async () => {
    const { host, emit } = createHost();
    const pending = invokeNativeAction<string>('copyText', ['value'], host);
    const sent = JSON.parse(vi.mocked(host.ReactNativeWebView!.postMessage!).mock.calls[0][0]);

    emit('$$dom_event', {
      type: '$$native_action_result',
      data: { uid: sent.data.uid, actionId: 'copyText', result: 'done' },
    });

    await expect(pending).resolves.toBe('done');
  });

  it('registers and cleans up the native back handle', () => {
    const { host } = createHost();
    const handleNativeBack = vi.fn();

    const cleanup = installNativeBackHandle(handleNativeBack, host);
    host._domRefProxy!.handleNativeBack();
    expect(handleNativeBack).toHaveBeenCalledOnce();
    expect(JSON.parse(vi.mocked(host.ReactNativeWebView!.postMessage!).mock.calls[0][0])).toEqual({
      type: '$$register_dom_imperative_handle_props',
      data: ['handleNativeBack'],
    });

    cleanup();
    expect(host._domRefProxy).toBeUndefined();
  });
});
