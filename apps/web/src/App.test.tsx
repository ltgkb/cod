import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { createClientId, getControlPlaneUrl, getTaskExecutionLease, heartbeatDevice, loginCod, logoutCod, observeCodSessionInvalidated, persistCodSession, refreshAccount, resumeCodSession, sendChat, updateRemoteTask } from './api';
import { configureCodRuntime as configureCodRuntimeBase, requestCodTopmostUiClose } from './runtime';
import type { CodRuntimeConfig } from './runtime';

function configureCodRuntime(next: CodRuntimeConfig): void {
  configureCodRuntimeBase({ loadSessionCleanupPending: async () => false, ...next });
}

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, String(value)); },
  };
}

beforeEach(() => {
  Object.defineProperty(window, 'localStorage', { configurable: true, value: createMemoryStorage() });
});

afterEach(async () => {
  cleanup();
  configureCodRuntime({});
  Object.defineProperty(window, 'localStorage', { configurable: true, value: createMemoryStorage() });
  await logoutCod();
  vi.useRealTimers();
  try { window.localStorage?.clear(); } catch { /* Node can expose localStorage without a backing file. */ }
  vi.unstubAllGlobals();
});

const capabilities = {
  authentication: { mode: 'password', registrationEnabled: true, legacyMigrationEnabled: false, inviteCodeOptional: true, inviteCodeRequired: false, accessCodeRequired: false },
  ai: { mode: 'demo', streaming: false, streamingMode: 'buffered-sse' as const },
  knowledge: { mode: 'demo' },
  payments: { topupEnabled: false, orderApi: false, mode: 'unavailable' as const },
  synchronization: { transport: 'polling', taskStatusVersioning: true },
  remote: { feishu: 'unavailable' as const, wecom: 'unavailable' as const },
};
const creditPacks = { packs: [{ id: 'starter', name: '入门额度包', priceCents: 2000, creditCents: 2000, bonusPercent: 0, validityDays: 180 }], summary: { availableCents: 1000, grants: [{ id: 'trial', packId: 'trial', name: '新用户试用金', originalCents: 1000, remainingCents: 1000, purchasedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 30 * 86400000).toISOString(), status: 'active' }] } };

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

describe('COD workspace', () => {
  it('creates client IDs when randomUUID is unavailable on HTTP origins', () => {
    vi.stubGlobal('crypto', { getRandomValues: (bytes: Uint8Array) => { bytes.fill(7); return bytes; } });
    expect(createClientId()).toBe('07'.repeat(16));
  });

  it('uses the native transport and injected control plane inside Expo DOM', async () => {
    let nativeRequest: import('./runtime').NativeHttpRequest | undefined;
    configureCodRuntime({
      controlPlaneUrl: 'https://mobile.cod.example/',
      hostPlatform: 'android',
      nativeRequest: async (request) => {
        nativeRequest = request;
        return { status: 200, body: JSON.stringify({ choices: [{ message: { content: '原生响应' } }], usage: { prompt_tokens: 2, completion_tokens: 3 } }) };
      },
    });
    expect(getControlPlaneUrl()).toBe('https://mobile.cod.example');
    expect(await sendChat('token', 'demo', 'demo-model', [{ role: 'user', content: '测试' }])).toMatchObject({ content: '原生响应', inputTokens: 2, outputTokens: 3 });
    expect(nativeRequest).toMatchObject({ url: 'https://mobile.cod.example/v1/chat/completions', method: 'POST' });
    expect(nativeRequest?.headers.authorization).toBe('Bearer token');
    expect(nativeRequest?.url).not.toContain('token');
  });

  it('keeps the Expo secure session when a model provider authentication fails', async () => {
    let secureToken: string | null = 'mobile-session';
    const clearSessionToken = vi.fn(async () => { secureToken = null; return true; });
    const nativeRequest = vi.fn(async () => ({
      status: 502,
      body: JSON.stringify({ error: 'ai_upstream_auth_failed', message: 'KAI model provider authentication failed' }),
    }));
    configureCodRuntime({
      controlPlaneUrl: 'https://mobile.cod.example/',
      hostPlatform: 'android',
      nativeRequest,
      loadSessionToken: async () => secureToken,
      saveSessionToken: async (token) => { secureToken = token; },
      clearSessionToken,
    });

    await expect(sendChat('mobile-session', 'ai-kai', 'broken-model', [{ role: 'user', content: '测试' }]))
      .rejects.toMatchObject({ status: 502, code: 'ai_upstream_auth_failed' });
    expect(nativeRequest).toHaveBeenCalledTimes(1);
    expect(clearSessionToken).not.toHaveBeenCalled();
    expect(secureToken).toBe('mobile-session');
  });

  it('keeps the Web and Desktop session fallback in localStorage', async () => {
    await persistCodSession('web-session');
    expect(window.localStorage.getItem('cod.session.token')).toBe('web-session');
    expect(await logoutCod('different-session')).toBe(false);
    expect(window.localStorage.getItem('cod.session.token')).toBe('web-session');
    expect(await logoutCod('web-session')).toBe(true);
    expect(window.localStorage.getItem('cod.session.token')).toBeNull();
  });

  it('migrates a legacy Expo WebView session into secure storage and removes the plaintext copy', async () => {
    let secureToken: string | null = null;
    const saveSessionToken = vi.fn(async (token: string) => { secureToken = token; });
    const clearSessionToken = vi.fn(async (expected?: string) => {
      if (expected !== undefined && secureToken !== null && secureToken !== expected) return false;
      secureToken = null; return true;
    });
    configureCodRuntime({
      hostPlatform: 'android',
      loadSessionToken: async () => secureToken,
      saveSessionToken,
      clearSessionToken,
    });
    window.localStorage.setItem('cod.session.token', 'legacy-session');
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input).endsWith('/api/account')
      ? json({ userId: 'user', displayName: 'developer', balanceCents: 0, currency: 'CNY', plan: 'developer' })
      : json([])));
    await expect(resumeCodSession()).resolves.toMatchObject({ token: 'legacy-session' });
    expect(saveSessionToken).toHaveBeenCalledWith('legacy-session');
    expect(secureToken).toBe('legacy-session');
    expect(window.localStorage.getItem('cod.session.token')).toBeNull();
  });

  it('fails closed when the Expo secure-session bridge is missing or cannot migrate', async () => {
    window.localStorage.setItem('cod.session.token', 'legacy-session');
    configureCodRuntime({ hostPlatform: 'android' });
    await expect(resumeCodSession()).rejects.toMatchObject({ code: 'secure_session_storage_unavailable' });
    expect(window.localStorage.getItem('cod.session.token')).toBeNull();
    window.localStorage.removeItem('cod.session.logout-pending');

    window.localStorage.setItem('cod.session.token', 'another-session');
    const clearSessionToken = vi.fn(async () => true);
    configureCodRuntime({
      hostPlatform: 'android',
      loadSessionToken: async () => null,
      saveSessionToken: async () => { throw new Error('native storage unavailable'); },
      clearSessionToken,
    });
    await expect(resumeCodSession()).rejects.toMatchObject({ code: 'secure_session_storage_unavailable' });
    expect(clearSessionToken).toHaveBeenCalledWith(undefined);
    expect(window.localStorage.getItem('cod.session.token')).toBeNull();
  });

  it('does not enter a mobile session when secure persistence fails', async () => {
    configureCodRuntime({
      hostPlatform: 'ios',
      loadSessionToken: async () => null,
      saveSessionToken: async () => { throw new Error('keychain unavailable'); },
      clearSessionToken: async () => true,
    });
    await expect(persistCodSession('new-session')).rejects.toMatchObject({ code: 'secure_session_storage_unavailable' });
    expect(window.localStorage.getItem('cod.session.token')).toBeNull();
  });

  it('uses expected-token CAS so a stale authenticated 401 cannot clear a newer session', async () => {
    const backing=window.localStorage;
    let markerMutations=0;
    const storage:Storage={
      get length(){return backing.length;},
      clear:()=>backing.clear(),
      getItem:(key)=>backing.getItem(key),
      key:(index)=>backing.key(index),
      removeItem:(key)=>{
        if(key==='cod.session.logout-pending'){markerMutations+=1;throw new Error('marker removal failed');}
        backing.removeItem(key);
      },
      setItem:(key,value)=>{
        if(key==='cod.session.logout-pending')markerMutations+=1;
        backing.setItem(key,value);
      },
    };
    Object.defineProperty(window,'localStorage',{configurable:true,value:storage});
    let secureToken: string | null = 'new-session';
    let releaseClear: () => void = () => undefined;
    const clearGate = new Promise<void>((resolve) => { releaseClear = resolve; });
    let markClearStarted: () => void = () => undefined;
    const clearStarted = new Promise<void>((resolve) => { markClearStarted = resolve; });
    const clearSessionToken = vi.fn(async (expected?: string) => {
      markClearStarted();
      await clearGate;
      if (expected !== undefined && secureToken !== null && secureToken !== expected) return false;
      secureToken = null; return true;
    });
    configureCodRuntime({
      hostPlatform: 'android',
      loadSessionToken: async () => secureToken,
      saveSessionToken: async (token) => { secureToken = token; },
      clearSessionToken,
    });
    window.localStorage.setItem('cod.messages.current-task', 'new-session-chat');
    const invalidated = vi.fn();
    const stopObserving = observeCodSessionInvalidated(invalidated);
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'unauthorized' }, 401)));
    const request = refreshAccount('old-session');
    await clearStarted;
    expect(invalidated).not.toHaveBeenCalled();
    releaseClear();
    await expect(request).rejects.toMatchObject({ status: 401 });
    stopObserving();
    expect(clearSessionToken).toHaveBeenCalledWith('old-session');
    expect(invalidated).not.toHaveBeenCalled();
    expect(secureToken).toBe('new-session');
    expect(window.localStorage.getItem('cod.messages.current-task')).toBe('new-session-chat');
    expect(window.localStorage.getItem('cod.session.logout-pending')).toBeNull();
    expect(markerMutations).toBe(0);
    vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL)=>String(input).endsWith('/api/account')
      ?json({userId:'user',displayName:'new session',balanceCents:0,currency:'CNY',plan:'developer'})
      :json([])));
    await expect(resumeCodSession()).resolves.toMatchObject({token:'new-session'});
  });

  it('persists the logout marker before waiting for the native tombstone write', async () => {
    let releaseClear:()=>void=()=>undefined;
    const clearGate=new Promise<void>((resolve)=>{releaseClear=resolve;});
    let markClearStarted:()=>void=()=>undefined;
    const clearStarted=new Promise<void>((resolve)=>{markClearStarted=resolve;});
    let secureToken:string|null='mobile-session';
    configureCodRuntime({
      hostPlatform:'android',
      loadSessionCleanupPending:async()=>false,
      loadSessionToken:async()=>secureToken,
      saveSessionToken:async(token)=>{secureToken=token;},
      clearSessionToken:async()=>{markClearStarted();await clearGate;secureToken=null;return true;},
    });
    const logout=logoutCod('mobile-session',{explicit:true});
    await clearStarted;
    expect(window.localStorage.getItem('cod.session.logout-pending')).toBe('1');
    const restartedStorage=createMemoryStorage();
    restartedStorage.setItem('cod.session.logout-pending',String(window.localStorage.getItem('cod.session.logout-pending')));
    expect(restartedStorage.getItem('cod.session.logout-pending')).toBe('1');
    releaseClear();
    await expect(logout).resolves.toBe(true);
    expect(window.localStorage.getItem('cod.session.logout-pending')).toBeNull();
  });

  it('keeps explicit mobile logout fail closed until a failed secure deletion is retried', async () => {
    let secureToken: string | null = 'mobile-session';
    configureCodRuntime({
      hostPlatform: 'android',
      loadSessionToken: async () => secureToken,
      saveSessionToken: async (token) => { secureToken = token; },
      clearSessionToken: async () => { throw new Error('secure deletion failed'); },
    });
    window.localStorage.setItem('cod.messages.private-task', 'private-chat');
    await expect(logoutCod('mobile-session', { explicit: true })).rejects.toThrow('secure deletion failed');
    expect(window.localStorage.getItem('cod.messages.private-task')).toBe('private-chat');
    expect(window.localStorage.getItem('cod.session.logout-pending')).toBe('1');

    configureCodRuntime({
      hostPlatform: 'android',
      loadSessionToken: async () => secureToken,
      saveSessionToken: async (token) => { secureToken = token; },
      clearSessionToken: async () => { secureToken = null; return true; },
    });
    await expect(resumeCodSession()).resolves.toBeNull();
    expect(secureToken).toBeNull();
    expect(window.localStorage.getItem('cod.messages.private-task')).toBeNull();
    expect(window.localStorage.getItem('cod.session.logout-pending')).toBeNull();
  });

  it('fails closed when the pending-logout marker cannot be read', async () => {
    const backing=window.localStorage;
    const storage:Storage={
      get length(){return backing.length;},
      clear:()=>backing.clear(),
      getItem:(key)=>{if(key==='cod.session.logout-pending')throw new Error('storage read failed');return backing.getItem(key);},
      key:(index)=>backing.key(index),
      removeItem:(key)=>backing.removeItem(key),
      setItem:(key,value)=>backing.setItem(key,value),
    };
    Object.defineProperty(window,'localStorage',{configurable:true,value:storage});
    let secureToken:string|null='mobile-session';
    configureCodRuntime({
      hostPlatform:'ios',
      loadSessionToken:async()=>secureToken,
      saveSessionToken:async(token)=>{secureToken=token;},
      clearSessionToken:async()=>{secureToken=null;return true;},
    });
    await expect(resumeCodSession()).rejects.toMatchObject({code:'logout_marker_unavailable'});
    expect(secureToken).toBeNull();
  });

  it('treats a corrupted mobile logout marker as pending and never restores the secure session', async () => {
    let secureToken:string|null='mobile-session';
    configureCodRuntime({
      hostPlatform:'android',
      loadSessionCleanupPending:async()=>false,
      loadSessionToken:async()=>secureToken,
      saveSessionToken:async(token)=>{secureToken=token;},
      clearSessionToken:async()=>{secureToken=null;return true;},
    });
    window.localStorage.setItem('cod.session.logout-pending','corrupted');
    await expect(resumeCodSession()).resolves.toBeNull();
    expect(secureToken).toBeNull();
    expect(window.localStorage.getItem('cod.session.logout-pending')).toBeNull();
  });

  it('requires app-data cleanup when both logout recovery layers fail', async () => {
    const backing=window.localStorage;
    const storage:Storage={
      get length(){return backing.length;},
      clear:()=>backing.clear(),
      getItem:(key)=>backing.getItem(key),
      key:(index)=>backing.key(index),
      removeItem:(key)=>backing.removeItem(key),
      setItem:(key,value)=>{if(key==='cod.session.logout-pending')throw new Error('marker write failed');backing.setItem(key,value);},
    };
    Object.defineProperty(window,'localStorage',{configurable:true,value:storage});
    let secureToken:string|null='mobile-session';
    configureCodRuntime({
      hostPlatform:'android',
      loadSessionToken:async()=>secureToken,
      saveSessionToken:async(token)=>{secureToken=token;},
      clearSessionToken:async()=>{throw new Error('secure deletion failed');},
    });
    window.localStorage.setItem('cod.messages.private-task','private-chat');
    await expect(logoutCod('mobile-session',{explicit:true})).rejects.toMatchObject({code:'logout_recovery_unavailable'});
    expect(window.localStorage.getItem('cod.messages.private-task')).toBe('private-chat');
    expect(window.localStorage.getItem('cod.session.logout-pending')).toBeNull();
    expect(secureToken).toBe('mobile-session');
  });

  it('retries the fallback logout marker after plaintext cleanup frees storage', async () => {
    const values=new Map<string,string>([
      ['cod.session.token','legacy-mobile-session'],
      ['cod.messages.private-task','private-chat'],
    ]);
    let markerWrites=0;
    const storage:Storage={
      get length(){return values.size;},
      clear:()=>values.clear(),
      getItem:(key)=>values.get(key)??null,
      key:(index)=>[...values.keys()][index]??null,
      removeItem:(key)=>{values.delete(key);},
      setItem:(key,value)=>{
        if(key==='cod.session.logout-pending'){
          markerWrites+=1;
          if(values.has('cod.session.token'))throw new Error('quota exhausted');
        }
        values.set(key,String(value));
      },
    };
    Object.defineProperty(window,'localStorage',{configurable:true,value:storage});
    let secureToken:string|null='mobile-session';
    let secureLogoutPending=false;
    let failSecureClear=true;
    const configureRestartedRuntime=()=>configureCodRuntime({
      hostPlatform:'android',
      loadSessionCleanupPending:async()=>secureLogoutPending,
      loadSessionToken:async()=>secureLogoutPending?null:secureToken,
      saveSessionToken:async(token)=>{secureToken=token;secureLogoutPending=false;},
      clearSessionToken:async(expected)=>{
        if(failSecureClear)throw new Error('secure tombstone failed');
        if(expected!==undefined&&secureToken!==null&&secureToken!==expected)return false;
        secureToken=null;secureLogoutPending=true;return true;
      },
    });
    configureRestartedRuntime();
    await expect(logoutCod('mobile-session',{explicit:true})).rejects.toThrow('secure tombstone failed');
    expect(markerWrites).toBe(2);
    expect(window.localStorage.getItem('cod.session.token')).toBeNull();
    expect(window.localStorage.getItem('cod.session.logout-pending')).toBe('1');
    expect(window.localStorage.getItem('cod.messages.private-task')).toBe('private-chat');

    failSecureClear=false;
    configureRestartedRuntime();
    await expect(resumeCodSession()).resolves.toBeNull();
    expect(secureLogoutPending).toBe(true);
    expect(window.localStorage.getItem('cod.messages.private-task')).toBeNull();
    expect(window.localStorage.getItem('cod.session.logout-pending')).toBeNull();
  });

  it('uses the native logout tombstone after restart when local fallback storage is unavailable', async () => {
    const values=new Map<string,string>([['cod.session.token','stale-legacy-session']]);
    let allowPlaintextRemoval=false;
    const storage:Storage={
      get length(){return values.size;},
      clear:()=>values.clear(),
      getItem:(key)=>values.get(key)??null,
      key:(index)=>[...values.keys()][index]??null,
      removeItem:(key)=>{if(key!=='cod.session.token'||allowPlaintextRemoval)values.delete(key);},
      setItem:(key,value)=>{
        if(key==='cod.session.logout-pending')throw new Error('marker storage unavailable');
        values.set(key,String(value));
      },
    };
    Object.defineProperty(window,'localStorage',{configurable:true,value:storage});
    let secureToken:string|null='mobile-session';
    let secureLogoutPending=false;
    const saveSessionToken=vi.fn(async(token:string)=>{secureToken=token;secureLogoutPending=false;});
    const configureRestartedRuntime=()=>configureCodRuntime({
      hostPlatform:'ios',
      loadSessionCleanupPending:async()=>secureLogoutPending,
      loadSessionToken:async()=>secureLogoutPending?null:secureToken,
      saveSessionToken,
      clearSessionToken:async(expected)=>{
        if(expected!==undefined&&secureToken!==null&&secureToken!==expected)return false;
        secureToken=null;secureLogoutPending=true;return true;
      },
    });
    configureRestartedRuntime();
    await expect(logoutCod('mobile-session',{explicit:true})).rejects.toMatchObject({code:'plaintext_session_cleanup_failed',sessionCredentialCleared:true});
    expect(secureLogoutPending).toBe(true);
    expect(window.localStorage.getItem('cod.session.token')).toBe('stale-legacy-session');
    expect(window.localStorage.getItem('cod.session.logout-pending')).toBeNull();

    allowPlaintextRemoval=true;
    configureRestartedRuntime();
    await expect(resumeCodSession()).resolves.toBeNull();
    expect(window.localStorage.getItem('cod.session.token')).toBeNull();
    expect(saveSessionToken).not.toHaveBeenCalled();
    expect(secureLogoutPending).toBe(true);
  });

  it('fails closed and removes the secure copy when legacy plaintext deletion cannot be verified', async () => {
    const values = new Map<string, string>([['cod.session.token', 'legacy-session']]);
    const storage: Storage = {
      get length() { return values.size; },
      clear: () => values.clear(),
      getItem: (key) => values.get(key) ?? null,
      key: (index) => [...values.keys()][index] ?? null,
      removeItem: (key) => { if (key !== 'cod.session.token') values.delete(key); },
      setItem: (key, value) => { values.set(key, String(value)); },
    };
    Object.defineProperty(window, 'localStorage', { configurable: true, value: storage });
    let secureToken: string | null = null;
    configureCodRuntime({
      hostPlatform: 'ios',
      loadSessionToken: async () => secureToken,
      saveSessionToken: async (token) => { secureToken = token; },
      clearSessionToken: async () => { secureToken = null; return true; },
    });
    await expect(resumeCodSession()).rejects.toMatchObject({ code: 'plaintext_session_cleanup_failed' });
    expect(secureToken).toBeNull();
    expect(window.localStorage.getItem('cod.session.token')).toBe('legacy-session');
  });

  it('does not invalidate an existing session for a login-credentials 401', async () => {
    window.localStorage.setItem('cod.session.token', 'existing-session');
    const invalidated = vi.fn();
    const stopObserving = observeCodSessionInvalidated(invalidated);
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'invalid_credentials', message: '邮箱或密码错误' }, 401)));
    await expect(loginCod('developer@kai.com', 'wrong-password')).rejects.toMatchObject({ status: 401 });
    stopObserving();
    expect(invalidated).not.toHaveBeenCalled();
    expect(window.localStorage.getItem('cod.session.token')).toBe('existing-session');
  });

  it('clears persisted Expo chat history on logout without removing harmless preferences', async () => {
    let secureToken: string | null = 'mobile-session';
    configureCodRuntime({
      hostPlatform: 'android',
      loadSessionToken: async () => secureToken,
      saveSessionToken: async (token) => { secureToken = token; },
      clearSessionToken: async (expected) => {
        if (expected !== undefined && secureToken !== null && secureToken !== expected) return false;
        secureToken = null; return true;
      },
    });
    window.localStorage.setItem('cod.messages.task-1', JSON.stringify([{ content: 'private' }]));
    window.localStorage.setItem('kai.color-mode.v1', 'dark');
    await logoutCod('mobile-session');
    expect(window.localStorage.getItem('cod.messages.task-1')).toBeNull();
    expect(window.localStorage.getItem('kai.color-mode.v1')).toBe('dark');
    expect(secureToken).toBeNull();
  });

  it('keeps a logout tombstone when a newly written secure session cannot be rolled back', async () => {
    let secureToken: string | null = null;
    let verificationReads = 0;
    configureCodRuntime({
      hostPlatform: 'android',
      loadSessionToken: async () => {
        verificationReads += 1;
        if (verificationReads === 1) return 'different-session';
        return secureToken;
      },
      saveSessionToken: async (token) => { secureToken = token; },
      clearSessionToken: async () => { throw new Error('secure deletion failed'); },
    });
    await expect(persistCodSession('new-session')).rejects.toMatchObject({ code: 'secure_session_storage_unavailable' });
    expect(secureToken).toBe('new-session');
    expect(window.localStorage.getItem('cod.session.logout-pending')).toBe('1');

    configureCodRuntime({
      hostPlatform: 'android',
      loadSessionToken: async () => secureToken,
      saveSessionToken: async (token) => { secureToken = token; },
      clearSessionToken: async () => { secureToken = null; return true; },
    });
    await expect(resumeCodSession()).resolves.toBeNull();
    expect(secureToken).toBeNull();
    expect(window.localStorage.getItem('cod.session.logout-pending')).toBeNull();
  });

  it('never cancels an older pending logout when pre-login cleanup cannot reach SecureStore', async () => {
    let secureToken:string|null='old-session';
    let secureLogoutPending=false;
    let clearAttempts=0;
    const saveSessionToken=vi.fn(async(token:string)=>{secureToken=token;secureLogoutPending=false;});
    const configureRestartedRuntime=()=>configureCodRuntime({
      hostPlatform:'android',
      loadSessionCleanupPending:async()=>secureLogoutPending,
      loadSessionToken:async()=>secureLogoutPending?null:secureToken,
      saveSessionToken,
      clearSessionToken:async(expected)=>{
        clearAttempts+=1;
        if(clearAttempts===1)throw new Error('temporary SecureStore failure');
        if(expected!==undefined&&secureToken!==null&&secureToken!==expected)return false;
        secureToken=null;secureLogoutPending=true;return true;
      },
    });
    window.localStorage.setItem('cod.session.logout-pending','1');
    configureRestartedRuntime();
    await expect(persistCodSession('new-session')).rejects.toMatchObject({code:'secure_session_storage_unavailable'});
    expect(clearAttempts).toBe(1);
    expect(saveSessionToken).not.toHaveBeenCalled();
    expect(secureToken).toBe('old-session');
    expect(window.localStorage.getItem('cod.session.logout-pending')).toBe('1');

    configureRestartedRuntime();
    await expect(resumeCodSession()).resolves.toBeNull();
    expect(secureLogoutPending).toBe(true);
    expect(secureToken).toBeNull();
    expect(window.localStorage.getItem('cod.session.logout-pending')).toBeNull();
  });

  it('does not complete mobile logout while private chat removal is unverified', async () => {
    const values = new Map<string, string>([['cod.messages.private-task', 'private-chat']]);
    let allowChatRemoval = false;
    const storage: Storage = {
      get length() { return values.size; },
      clear: () => values.clear(),
      getItem: (key) => values.get(key) ?? null,
      key: (index) => [...values.keys()][index] ?? null,
      removeItem: (key) => { if (allowChatRemoval || !key.startsWith('cod.messages.')) values.delete(key); },
      setItem: (key, value) => { values.set(key, String(value)); },
    };
    Object.defineProperty(window, 'localStorage', { configurable: true, value: storage });
    let secureToken: string | null = 'mobile-session';
    configureCodRuntime({
      hostPlatform: 'ios',
      loadSessionToken: async () => secureToken,
      saveSessionToken: async (token) => { secureToken = token; },
      clearSessionToken: async () => { secureToken = null; return true; },
    });
    await expect(logoutCod('mobile-session', { explicit: true })).rejects.toMatchObject({ code: 'chat_history_cleanup_failed', sessionCredentialCleared: true });
    expect(secureToken).toBeNull();
    expect(window.localStorage.getItem('cod.messages.private-task')).toBe('private-chat');
    expect(window.localStorage.getItem('cod.session.logout-pending')).toBe('1');
    allowChatRemoval = true;
    await expect(resumeCodSession()).resolves.toBeNull();
    expect(window.localStorage.getItem('cod.messages.private-task')).toBeNull();
    expect(window.localStorage.getItem('cod.session.logout-pending')).toBeNull();
  });

  it('does not claim Web logout succeeded when localStorage retains the token', async () => {
    const values = new Map<string, string>([['cod.session.token', 'web-session']]);
    const storage: Storage = {
      get length() { return values.size; },
      clear: () => values.clear(),
      getItem: (key) => values.get(key) ?? null,
      key: (index) => [...values.keys()][index] ?? null,
      removeItem: (key) => { if (key !== 'cod.session.token') values.delete(key); },
      setItem: (key, value) => { values.set(key, String(value)); },
    };
    Object.defineProperty(window, 'localStorage', { configurable: true, value: storage });
    await expect(logoutCod('web-session', { explicit: true })).rejects.toMatchObject({ code: 'session_cleanup_failed' });
    expect(window.localStorage.getItem('cod.session.token')).toBe('web-session');
  });

  it('sends recent multi-turn context to the model gateway', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void input; void init;
      return json({ choices: [{ message: { content: '继续回答' } }], usage: { prompt_tokens: 12, completion_tokens: 34 }, cod_source: 'ai-kai' });
    });
    vi.stubGlobal('fetch', fetchMock);
    expect(await sendChat('token', 'ai-kai', 'model-1', [{ role: 'user', content: '第一问' }, { role: 'assistant', content: '   ' }, { role: 'assistant', content: '第一答' }, { role: 'user', content: '继续' }])).toMatchObject({ inputTokens: 12, outputTokens: 34 });
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { messages: Array<{ role: string; content: string }>; max_tokens: number };
    expect(body.messages).toEqual([{ role: 'user', content: '第一问' }, { role: 'assistant', content: '第一答' }, { role: 'user', content: '继续' }]);
    expect(body).toMatchObject({ max_tokens: 4_096 });
  });

  it('rejects empty model responses instead of rendering a blank reply', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ choices: [{ message: { content: '   ' } }], usage: { prompt_tokens: 12, completion_tokens: 34 }, cod_source: 'ai-kai', cod_charge_cents: 4 })));
    await expect(sendChat('token', 'ai-kai', 'glm-5.2', [{ role: 'user', content: '问题' }])).rejects.toMatchObject({ code: 'empty_model_response' });
  });

  it('binds model requests to a task and aborts without retrying when cancelled',async()=>{
    const taskId='10000000-0000-4000-8000-000000000001';let requestSignal:AbortSignal|undefined;let requestBody:Record<string,unknown>|null=null;let started:()=>void=()=>undefined;const requestStarted=new Promise<void>((resolve)=>{started=resolve;});
    const fetchMock=vi.fn(async(input:RequestInfo|URL,init?:RequestInit):Promise<Response>=>{const url=String(input);if(url.includes('/api/tasks/')){const body=JSON.parse(String(init?.body)) as {leaseToken:string};return json({id:taskId,title:'长任务',status:'running',deviceId:'device',updatedAt:new Date().toISOString(),version:2,result:null,error:null,execution:{executionId:'20000000-0000-4000-8000-000000000002',leaseToken:body.leaseToken,leaseExpiresAt:new Date(Date.now()+90_000).toISOString()}});}requestSignal=init?.signal??undefined;requestBody=JSON.parse(String(init?.body)) as Record<string,unknown>;started();return new Promise<Response>((_resolve,reject)=>requestSignal?.addEventListener('abort',()=>reject(requestSignal?.reason),{once:true}));});
    vi.stubGlobal('fetch',fetchMock);await updateRemoteTask('token',{id:taskId,title:'长任务',status:'draft',deviceId:'device',updatedAt:new Date().toISOString(),version:1,result:null,error:null},'running');const controller=new AbortController();const pending=sendChat('token','ai-kai','model-1',[{role:'user',content:'长任务'}],{taskId,signal:controller.signal});await requestStarted;controller.abort(new DOMException('Task cancelled','AbortError'));await expect(pending).rejects.toMatchObject({name:'AbortError'});expect(requestSignal?.aborted).toBe(true);expect(requestBody).toMatchObject({task_id:taskId});expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries a lost claim response with exactly the same high-entropy credential',async()=>{
    const taskId='60000000-0000-4000-8000-000000000006';const bodies:Array<{expectedVersion:number;claimId:string;leaseToken:string}>=[];
    const fetchMock=vi.fn(async(_input:RequestInfo|URL,init?:RequestInit)=>{const body=JSON.parse(String(init?.body)) as {expectedVersion:number;claimId:string;leaseToken:string};bodies.push(body);if(bodies.length===1)throw new TypeError('response lost after commit');return json({id:taskId,title:'幂等启动',status:'running',deviceId:'device',updatedAt:new Date().toISOString(),version:2,result:null,error:null,execution:{executionId:'70000000-0000-4000-8000-000000000007',leaseToken:body.leaseToken,leaseExpiresAt:new Date(Date.now()+90_000).toISOString()}});});
    vi.stubGlobal('fetch',fetchMock);const result=await updateRemoteTask('token',{id:taskId,title:'幂等启动',status:'draft',deviceId:'device',updatedAt:new Date().toISOString(),version:1,result:null,error:null},'running');
    expect(result).toMatchObject({status:'running',version:2});expect(bodies).toHaveLength(2);expect(bodies[1]).toEqual(bodies[0]);expect(bodies[0]?.expectedVersion).toBe(1);expect(bodies[0]?.claimId).toMatch(/^[A-Za-z0-9_-]{43}$/);expect(bodies[0]?.leaseToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('retries a committed claim hidden by a gateway 502 with the same credential',async()=>{
    const taskId='61000000-0000-4000-8000-000000000006';const bodies:Array<{expectedVersion:number;claimId:string;leaseToken:string}>=[];
    const fetchMock=vi.fn(async(_input:RequestInfo|URL,init?:RequestInit)=>{const body=JSON.parse(String(init?.body)) as {expectedVersion:number;claimId:string;leaseToken:string};bodies.push(body);if(bodies.length===1)return json({error:'bad_gateway',message:'response lost after commit'},502);return json({id:taskId,title:'网关恢复',status:'running',deviceId:'device',updatedAt:new Date().toISOString(),version:2,result:null,error:null,execution:{executionId:'71000000-0000-4000-8000-000000000007',leaseToken:body.leaseToken,leaseExpiresAt:new Date(Date.now()+90_000).toISOString()}});});
    vi.stubGlobal('fetch',fetchMock);await expect(updateRemoteTask('token',{id:taskId,title:'网关恢复',status:'draft',deviceId:'device',updatedAt:new Date().toISOString(),version:1,result:null,error:null},'running')).resolves.toMatchObject({status:'running',version:2});
    expect(bodies).toHaveLength(2);expect(bodies[1]).toEqual(bodies[0]);
  });

  it('honors Retry-After before the single bounded claim retry',async()=>{
    vi.useFakeTimers();const taskId='62000000-0000-4000-8000-000000000006';let calls=0;
    const fetchMock=vi.fn(async(_input:RequestInfo|URL,init?:RequestInit)=>{calls+=1;const body=JSON.parse(String(init?.body)) as {leaseToken:string};if(calls===1)return Response.json({error:'rate_limited',message:'slow down'},{status:429,headers:{'retry-after':'1'}});return json({id:taskId,title:'限流恢复',status:'running',deviceId:'device',updatedAt:new Date().toISOString(),version:2,result:null,error:null,execution:{executionId:'72000000-0000-4000-8000-000000000007',leaseToken:body.leaseToken,leaseExpiresAt:new Date(Date.now()+90_000).toISOString()}});});
    vi.stubGlobal('fetch',fetchMock);const pending=updateRemoteTask('token',{id:taskId,title:'限流恢复',status:'draft',deviceId:'device',updatedAt:new Date().toISOString(),version:1,result:null,error:null},'running');
    await vi.advanceTimersByTimeAsync(999);expect(calls).toBe(1);await vi.advanceTimersByTimeAsync(1);await expect(pending).resolves.toMatchObject({status:'running'});expect(calls).toBe(2);
  });

  it('drops a cached execution credential after every fatal heartbeat lease error',async()=>{
    const taskId='63000000-0000-4000-8000-000000000006';let claimed=false;
    const fetchMock=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{if(String(input).includes('/status')){claimed=true;const body=JSON.parse(String(init?.body)) as {leaseToken:string};return json({id:taskId,title:'租约丢失',status:'running',deviceId:'device',updatedAt:new Date().toISOString(),version:2,result:null,error:null,execution:{executionId:'73000000-0000-4000-8000-000000000007',leaseToken:body.leaseToken,leaseExpiresAt:new Date(Date.now()+90_000).toISOString()}});}return json({error:'task_lease_required',message:'lease missing'},409);});
    vi.stubGlobal('fetch',fetchMock);await updateRemoteTask('token',{id:taskId,title:'租约丢失',status:'draft',deviceId:'device',updatedAt:new Date().toISOString(),version:1,result:null,error:null},'running');expect(claimed).toBe(true);expect(getTaskExecutionLease(taskId)).not.toBeNull();
    await expect(heartbeatDevice('token','device',taskId)).rejects.toMatchObject({code:'task_lease_required'});expect(getTaskExecutionLease(taskId)).toBeNull();
  });

  it('shows the workspace first and opens login when the first message is sent', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(capabilities)));
    render(<App />);
    expect(await screen.findByRole('heading', { name: '新对话' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    const composer = screen.getByPlaceholderText('问 COD 任何问题...');
    fireEvent.change(composer, { target: { value: '这是我的第一条消息' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    const dialog = await screen.findByRole('dialog', { name: '登录后继续' });
    expect(within(dialog).getByLabelText('密码')).toBeRequired();
    expect(composer).toHaveValue('这是我的第一条消息');
    act(() => requestCodTopmostUiClose());
    expect(screen.queryByRole('dialog', { name: '登录后继续' })).not.toBeInTheDocument();
    expect(composer).toHaveValue('这是我的第一条消息');
  });

  it('closes the topmost Web UI before releasing Android back navigation', async () => {
    const setNativeTopmostUiVisible = vi.fn(async () => undefined);
    configureCodRuntime({ setNativeTopmostUiVisible });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/capabilities')) return json(capabilities);
      if (url.endsWith('/api/model-catalog')) return json([]);
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    await screen.findByRole('heading', { name: '新对话' });
    await waitFor(() => expect(setNativeTopmostUiVisible).toHaveBeenLastCalledWith(false));

    fireEvent.click(screen.getByTitle('打开任务栏'));
    fireEvent.click(screen.getByTitle('模型库'));
    expect(await screen.findByRole('dialog', { name: '模型库' })).toBeInTheDocument();
    await waitFor(() => expect(setNativeTopmostUiVisible).toHaveBeenLastCalledWith(true));

    act(() => requestCodTopmostUiClose());
    expect(screen.queryByRole('dialog', { name: '模型库' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '关闭任务栏' })).toBeInTheDocument();
    expect(setNativeTopmostUiVisible).toHaveBeenLastCalledWith(true);

    act(() => requestCodTopmostUiClose());
    expect(screen.queryByRole('button', { name: '关闭任务栏' })).not.toBeInTheDocument();
    await waitFor(() => expect(setNativeTopmostUiVisible).toHaveBeenLastCalledWith(false));
  });

  it('traps keyboard focus inside a modal, closes it with Escape, and restores the trigger focus', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input).endsWith('/api/capabilities') ? json(capabilities) : json([])));
    render(<App />);
    await screen.findByRole('heading', { name: '新对话' });
    const trigger = screen.getByTitle('模型库');
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = await screen.findByRole('dialog', { name: '模型库' });
    const close = within(dialog).getByTitle('关闭');
    await waitFor(() => expect(dialog).toContainElement(document.activeElement as HTMLElement));
    const last = within(dialog).getByRole('button', { name: '登录后使用模型' });
    last.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(close).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: '模型库' })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('keeps the registration invite code optional', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(capabilities)));
    render(<App />);
    await screen.findByRole('heading', { name: '新对话' });
    fireEvent.click(screen.getByTitle('登录'));
    const dialog = await screen.findByRole('dialog', { name: '登录 COD' });
    fireEvent.click(within(dialog).getByRole('tab', { name: '注册账号' }));
    expect(within(dialog).getByLabelText('邀请码')).not.toBeRequired();
    expect(within(dialog).getByText(/邀请码选填，用于绑定邀请人与后续返佣/)).toBeInTheDocument();
  });

  it('offers only the one-time legacy migration flow when public registration is closed', async () => {
    const migrationCapabilities={...capabilities,authentication:{...capabilities.authentication,registrationEnabled:false,legacyMigrationEnabled:true}};
    vi.stubGlobal('fetch',vi.fn(async()=>json(migrationCapabilities)));
    render(<App />);
    await screen.findByRole('heading',{name:'新对话'});
    fireEvent.click(screen.getByTitle('登录'));
    const dialog=await screen.findByRole('dialog',{name:'登录 COD'});
    expect(within(dialog).queryByRole('tab',{name:'注册账号'})).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('tab',{name:'旧账号迁移'}));
    expect(within(dialog).getByRole('heading',{name:'迁移旧账号'})).toBeInTheDocument();
    expect(within(dialog).getByLabelText('旧试点访问码')).toBeRequired();
    expect(within(dialog).queryByLabelText('邀请码')).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/试用金|领取/)).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button',{name:/迁移旧账号/})).toBeInTheDocument();
  });

  it('does not expose enrollment while authentication capabilities are unavailable', async () => {
    vi.stubGlobal('fetch',vi.fn(async()=>{throw new Error('offline');}));
    render(<App />);
    await screen.findByRole('heading',{name:'新对话'});
    fireEvent.click(screen.getByTitle('登录'));
    const dialog=await screen.findByRole('dialog',{name:'登录 COD'});
    expect(within(dialog).queryByRole('tab',{name:'注册账号'})).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('tab',{name:'旧账号迁移'})).not.toBeInTheDocument();
    expect(within(dialog).getByText(/当前仅开放已有账号登录/)).toBeInTheDocument();
  });

  it('keeps only two primary mobile context items outside the more disclosure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(capabilities)));
    const { container } = render(<App />);
    await screen.findByRole('heading', { name: '新对话' });
    const strip = container.querySelector('.context-strip');
    expect(strip).not.toBeNull();
    expect(strip?.querySelectorAll('.mobile-context-primary')).toHaveLength(2);
    expect(strip?.querySelectorAll('.mobile-context-secondary')).toHaveLength(3);
    const toggle = screen.getByRole('button', { name: '展开更多上下文信息，共 3 项' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(strip).toHaveClass('mobile-expanded');
    expect(screen.getByRole('button', { name: '收起上下文信息' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('shows public model prices before login', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/capabilities')) return json(capabilities);
      if (url.endsWith('/api/model-catalog')) return json([{ id: 'ai-kai', label: 'AI.KAI.COM', status: 'live', callable: true, paymentDirection: '钱包 → ai.kai.com', note: '已连接', models: [{ id: 'glm-5.2', label: 'GLM 5.2', contextWindow: 128000, inputPricePerMillionCents: 836, outputPricePerMillionCents: 2926 }] }]);
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    await screen.findByRole('heading', { name: '新对话' });
    fireEvent.click(screen.getByTitle('模型库'));
    const dialog = await screen.findByRole('dialog', { name: '模型库' });
    expect(within(dialog).getByText('GLM 5.2')).toBeInTheDocument();
    expect(within(dialog).getByText('¥ 8.36')).toBeInTheDocument();
    expect(within(dialog).getByText('¥ 29.26')).toBeInTheDocument();
    expect(within(dialog).getByText('可调用')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '登录后使用模型' })).toBeInTheDocument();
  });

  it('shows the H100 card-hour market and keeps financing as a compliant application flow', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/capabilities')) return json(capabilities);
      if (url.endsWith('/api/model-catalog')) return json([]);
      if (url.endsWith('/api/compute/offers')) return json([{ id: 'cod-h100-pcie-card-hour', title: 'H100 80GB 单卡算力', gpuModel: 'NVIDIA H100 PCIe 80GB', gpuMemoryGb: 80, gpuCount: 1, region: '国内合规机房', provider: 'COD 机房直供', priceCents: 1880, priceUnit: 'card-hour', minimumUnits: 10, delivery: '人工确认后开通', network: '按需报价', availability: 'ready', verified: true, tags: ['按卡时'] }]);
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    await screen.findByRole('heading', { name: '新对话' });
    fireEvent.click(screen.getByTitle('算力市场'));
    const dialog = await screen.findByRole('dialog', { name: 'COD 算力市场 · 机房直供 / 卡时 / 分期' });
    expect(within(dialog).getByText('H100 80GB 单卡算力')).toBeInTheDocument();
    expect(within(dialog).getByText('¥18.80')).toBeInTheDocument();
    expect(within(dialog).getByText('/ 卡时起')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: /显卡分期/ }));
    expect(within(dialog).getByText(/COD 仅撮合申请，不自行授信或放款/)).toBeInTheDocument();
    expect(within(dialog).getByText(/具备相应资质的合作机构独立审核/)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '登录后提交需求' })).toBeInTheDocument();
  });

  it('persists the KAI semantic color mode', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(capabilities)));
    render(<App />);
    await screen.findByRole('heading', { name: '新对话' });
    const toggle = screen.getByRole('button', { name: '切换到深色模式' });
    fireEvent.click(toggle);
    await waitFor(() => expect(document.documentElement).toHaveAttribute('data-color-mode', 'dark'));
    expect(window.localStorage.getItem('kai.color-mode.v1')).toBe('dark');
    expect(screen.getByRole('button', { name: '切换到浅色模式' })).toBeInTheDocument();
  });

  it('can hide and restore the changes, files, and terminal inspector', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(capabilities)));
    render(<App />);
    await screen.findByRole('heading', { name: '新对话' });
    expect(screen.getByRole('button', { name: '改动' })).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: '隐藏右侧面板' })[0]);
    expect(screen.queryByRole('button', { name: '改动' })).not.toBeInTheDocument();
    expect(window.localStorage.getItem('cod.inspector.open')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: '显示右侧面板' }));
    expect(screen.getByRole('button', { name: '改动' })).toBeInTheDocument();
  });

  it('automatically continues the saved first message after login', async () => {
    let taskVersion = 1;
    let secureToken: string | null = null;
    let releasePersistence: () => void = () => undefined;
    const persistenceGate = new Promise<void>((resolve) => { releasePersistence = resolve; });
    let markPersistenceStarted: () => void = () => undefined;
    const persistenceStarted = new Promise<void>((resolve) => { markPersistenceStarted = resolve; });
    configureCodRuntime({
      hostPlatform: 'android',
      loadSessionToken: async () => secureToken,
      saveSessionToken: async (token) => { markPersistenceStarted(); await persistenceGate; secureToken = token; },
      clearSessionToken: async (expected) => {
        if (expected !== undefined && secureToken !== null && secureToken !== expected) return false;
        secureToken = null; return true;
      },
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/capabilities')) return json(capabilities);
      if (url.endsWith('/api/auth/login')) return json({ token: 'test-token' });
      if (url.endsWith('/api/account')) return json({ userId: 'user', displayName: 'developer', balanceCents: 6839, currency: 'CNY', plan: 'developer' });
      if (url.endsWith('/api/model-sources')) return json([{ id: 'ai-kai', label: 'AI.KAI.COM', status: 'live', callable: true, paymentDirection: '钱包 → ai.kai.com', note: '已连接', models: [{ id: 'glm-5.2', label: 'glm-5.2', contextWindow: 0, inputPricePerMillionCents: 836, outputPricePerMillionCents: 2926 }] }]);
      if (url.endsWith('/api/devices') && init?.method === 'POST') return json({ id: 'web-device', name: 'COD Web', platform: 'web', status: 'online', lastSeenAt: new Date().toISOString() }, 201);
      if (url.endsWith('/api/devices/web-device/heartbeat')) return json({ id: 'web-device', name: 'COD Web', platform: 'web', status: 'online', lastSeenAt: new Date().toISOString() });
      if (url.endsWith('/api/devices')) return json([]);
      if (url.endsWith('/api/tasks') && init?.method === 'POST') return json({ id: 'task-new', title: '登录后自动发送', status: 'draft', deviceId: 'web-device', updatedAt: new Date().toISOString(), version: taskVersion }, 201);
      if (url.endsWith('/api/tasks')) return json([]);
      if (url.endsWith('/api/credit-packs')) return json(creditPacks);
      if (/\/api\/tasks\/task-new\/status$/.test(url)) {
        const body = JSON.parse(String(init?.body)) as { status: 'running' | 'complete'; leaseToken?:string };
        taskVersion += 1;
        return json({ id: 'task-new', title: '登录后自动发送', status: body.status, deviceId: 'web-device', updatedAt: new Date().toISOString(), version: taskVersion, result: body.status === 'complete' ? '自动回复' : null, error: null, ...(body.status==='running'?{execution:{executionId:'30000000-0000-4000-8000-000000000003',leaseToken:body.leaseToken,leaseExpiresAt:new Date(Date.now()+90_000).toISOString()}}:{}) });
      }
      if (url.endsWith('/v1/chat/completions')) return json({ choices: [{ message: { content: '自动回复' } }], usage: { prompt_tokens: 12, completion_tokens: 34 }, cod_source: 'ai-kai', cod_charge_cents: 1 });
      if (url.endsWith('/api/products') || url.endsWith('/api/ledger')) return json([]);
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    await screen.findByRole('heading', { name: '新对话' });
    const composer = screen.getByPlaceholderText('问 COD 任何问题...');
    fireEvent.change(composer, { target: { value: '登录后自动发送' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    const dialog = await screen.findByRole('dialog', { name: '登录后继续' });
    fireEvent.change(within(dialog).getByLabelText('邮箱'), { target: { value: 'developer@kai.com' } });
    fireEvent.change(within(dialog).getByLabelText('密码'), { target: { value: 'Password123' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '登录并继续' }));
    await persistenceStarted;
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/v1/chat/completions'))).toBe(false);
    expect(screen.getByRole('dialog', { name: '登录后继续' })).toBeInTheDocument();
    releasePersistence();
    expect(await screen.findByText('自动回复')).toBeInTheDocument();
    expect(screen.getByText(/输入 12 \/ 输出 34 Token/)).toBeInTheDocument();
    expect(screen.queryByText('¥0.01')).not.toBeInTheDocument();
    const chatCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/v1/chat/completions'));
    expect(JSON.parse(String(chatCall?.[1]?.body)).messages).toEqual([{ role: 'user', content: '登录后自动发送' }]);
    const heartbeatIndex=fetchMock.mock.calls.findIndex(([url])=>String(url).endsWith('/api/devices/web-device/heartbeat'));const createIndex=fetchMock.mock.calls.findIndex(([url,init])=>String(url).endsWith('/api/tasks')&&init?.method==='POST');expect(heartbeatIndex).toBeGreaterThanOrEqual(0);expect(heartbeatIndex).toBeLessThan(createIndex);
  });

  it('does not load private workspace state or auto-send when secure persistence fails', async () => {
    configureCodRuntime({
      hostPlatform: 'ios',
      loadSessionToken: async () => null,
      saveSessionToken: async () => { throw new Error('keychain unavailable'); },
      clearSessionToken: async () => true,
    });
    const fetchMock=vi.fn(async(input:RequestInfo|URL)=>{
      const url=String(input);
      if(url.endsWith('/api/capabilities'))return json(capabilities);
      if(url.endsWith('/api/model-catalog'))return json([]);
      if(url.endsWith('/api/auth/login'))return json({token:'new-mobile-session'});
      if(url.endsWith('/api/account'))return json({userId:'private-user',displayName:'private developer',balanceCents:9876,currency:'CNY',plan:'developer'});
      if(url.endsWith('/api/model-sources'))return json([{id:'ai-kai',label:'AI.KAI.COM',status:'live',callable:true,paymentDirection:'钱包 → ai.kai.com',note:'已连接',models:[]}]);
      throw new Error(`Unexpected authenticated workspace request: ${url}`);
    });
    vi.stubGlobal('fetch',fetchMock);
    render(<App/>);
    await screen.findByRole('heading',{name:'新对话'});
    const composer=screen.getByPlaceholderText('问 COD 任何问题...');
    fireEvent.change(composer,{target:{value:'不要提前发送'}});
    fireEvent.click(screen.getByRole('button',{name:'发送'}));
    const dialog=await screen.findByRole('dialog',{name:'登录后继续'});
    fireEvent.change(within(dialog).getByLabelText('邮箱'),{target:{value:'developer@kai.com'}});
    fireEvent.change(within(dialog).getByLabelText('密码'),{target:{value:'Password123'}});
    fireEvent.click(within(dialog).getByRole('button',{name:'登录并继续'}));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('无法安全保存移动端登录状态，请重试。');
    expect(screen.getByRole('heading',{name:'新对话'})).toBeInTheDocument();
    expect(screen.getByText('登录后查看')).toBeInTheDocument();
    expect(screen.queryByText('private developer')).not.toBeInTheDocument();
    expect(screen.getByDisplayValue('不要提前发送')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url])=>/\/api\/(devices|tasks|products|ledger|credit-packs)$/.test(String(url)))).toBe(false);
    expect(fetchMock.mock.calls.some(([url])=>String(url).endsWith('/v1/chat/completions'))).toBe(false);
  });

  it('keeps a cleanup tombstone when closing login races a failed SecureStore rollback', async () => {
    let secureToken:string|null=null;
    let allowSecureClear=false;
    let releaseSave:()=>void=()=>undefined;
    const saveGate=new Promise<void>((resolve)=>{releaseSave=resolve;});
    let markSaveStarted:()=>void=()=>undefined;
    const saveStarted=new Promise<void>((resolve)=>{markSaveStarted=resolve;});
    const clearSessionToken=vi.fn(async(expected?:string)=>{if(!allowSecureClear)throw new Error('secure deletion failed');if(expected!==undefined&&secureToken!==null&&secureToken!==expected)return false;secureToken=null;return true;});
    configureCodRuntime({hostPlatform:'android',loadSessionToken:async()=>secureToken,saveSessionToken:async(token)=>{markSaveStarted();await saveGate;secureToken=token;},clearSessionToken});
    const fetchMock=vi.fn(async(input:RequestInfo|URL)=>{
      const url=String(input);
      if(url.endsWith('/api/capabilities'))return json(capabilities);
      if(url.endsWith('/api/model-catalog'))return json([]);
      if(url.endsWith('/api/auth/login'))return json({token:'cancelled-mobile-session'});
      if(url.endsWith('/api/account'))return json({userId:'user',displayName:'developer',balanceCents:0,currency:'CNY',plan:'developer'});
      if(url.endsWith('/api/model-sources'))return json([]);
      throw new Error(`Unexpected authenticated workspace request: ${url}`);
    });
    vi.stubGlobal('fetch',fetchMock);
    render(<App/>);
    await screen.findByRole('heading',{name:'新对话'});
    fireEvent.change(screen.getByPlaceholderText('问 COD 任何问题...'),{target:{value:'取消登录'}});
    fireEvent.click(screen.getByRole('button',{name:'发送'}));
    const dialog=await screen.findByRole('dialog',{name:'登录后继续'});
    fireEvent.change(within(dialog).getByLabelText('邮箱'),{target:{value:'developer@kai.com'}});
    fireEvent.change(within(dialog).getByLabelText('密码'),{target:{value:'Password123'}});
    fireEvent.click(within(dialog).getByRole('button',{name:'登录并继续'}));
    await saveStarted;
    fireEvent.click(within(dialog).getByTitle('关闭'));
    releaseSave();
    await waitFor(()=>expect(clearSessionToken).toHaveBeenCalledWith('cancelled-mobile-session'));
    expect(secureToken).toBe('cancelled-mobile-session');
    expect(window.localStorage.getItem('cod.session.logout-pending')).toBe('1');
    expect(screen.queryByRole('dialog',{name:'登录后继续'})).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url])=>/\/api\/(devices|tasks|products|ledger|credit-packs)$/.test(String(url)))).toBe(false);
    allowSecureClear=true;
    await expect(resumeCodSession()).resolves.toBeNull();
    expect(secureToken).toBeNull();
    expect(window.localStorage.getItem('cod.session.logout-pending')).toBeNull();
  });

  it('signs out the active session after an authenticated runtime 401', async () => {
    let expired=false;
    const fetchMock=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
      const url=String(input);const headers=new Headers(init?.headers);
      if(expired&&headers.has('authorization'))return json({error:'unauthorized'},401);
      if(url.endsWith('/api/capabilities'))return json(capabilities);
      if(url.endsWith('/api/model-catalog')||url.endsWith('/api/compute/offers'))return json([]);
      if(url.endsWith('/api/account'))return json({userId:'user',displayName:'developer',balanceCents:5000,currency:'CNY',plan:'developer'});
      if(url.endsWith('/api/model-sources'))return json([{id:'ai-kai',label:'AI.KAI.COM',status:'live',callable:true,paymentDirection:'钱包 → ai.kai.com',note:'已连接',models:[{id:'model',label:'模型',contextWindow:128000,inputPricePerMillionCents:100,outputPricePerMillionCents:200}]}]);
      if(url.endsWith('/api/devices/web-device/heartbeat'))return json({id:'web-device',name:'COD Web',platform:'web',status:'online',lastSeenAt:new Date().toISOString()});
      if(url.endsWith('/api/devices'))return json([{id:'web-device',name:'COD Web',platform:'web',status:'online',lastSeenAt:new Date().toISOString()}]);
      if(url.endsWith('/api/credit-packs'))return json(creditPacks);
      if(url.endsWith('/api/referrals'))return json({inviteCode:'KAI-TEST',referredUsers:0,commissionRateBps:0,pendingCommissionCents:0,settledCommissionCents:0});
      if(url.endsWith('/api/tasks')||url.endsWith('/api/products')||url.endsWith('/api/ledger')||url.endsWith('/api/compute/requests'))return json([]);
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch',fetchMock);window.localStorage.setItem('cod.session.token','active-session');window.localStorage.setItem('cod.device.id','web-device');
    render(<App/>);expect(await screen.findByRole('heading',{name:'新建或选择任务'})).toBeInTheDocument();
    expired=true;document.dispatchEvent(new Event('visibilitychange'));
    expect((await screen.findAllByText('登录已过期，请重新登录。')).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole('heading',{name:'新对话'})).toBeInTheDocument();
    expect(window.localStorage.getItem('cod.session.token')).toBeNull();
  });

  it('keeps the active session when a model provider authentication fails', async () => {
    window.localStorage.setItem('cod.session.token','active-session');
    const fetchMock=vi.fn(async(input:RequestInfo|URL)=>String(input).endsWith('/v1/chat/completions')
      ?json({error:'ai_upstream_auth_failed',message:'KAI model provider authentication failed'},502)
      :json({error:'unexpected'},500));
    vi.stubGlobal('fetch',fetchMock);
    await expect(sendChat('active-session','ai-kai','broken-model',[{role:'user',content:'hello'}])).rejects.toMatchObject({status:502,code:'ai_upstream_auth_failed'});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem('cod.session.token')).toBe('active-session');
  });

  it('ignores a late lease-heartbeat 409 after terminal commit and still refreshes the wallet',async()=>{
    let taskVersion=1;let taskStatus:'draft'|'running'|'complete'='draft';let taskReads=0;let accountReads=0;let releaseRefresh:()=>void=()=>undefined;const refreshGate=new Promise<void>((resolve)=>{releaseRefresh=resolve;});let releaseChat:()=>void=()=>undefined;const chatGate=new Promise<void>((resolve)=>{releaseChat=resolve;});let markChatStarted:()=>void=()=>undefined;const chatStarted=new Promise<void>((resolve)=>{markChatStarted=resolve;});let releaseLeaseHeartbeat:()=>void=()=>undefined;const leaseHeartbeatGate=new Promise<void>((resolve)=>{releaseLeaseHeartbeat=resolve;});let markLeaseHeartbeatStarted:()=>void=()=>undefined;const leaseHeartbeatStarted=new Promise<void>((resolve)=>{markLeaseHeartbeatStarted=resolve;});let releaseCompletionResponse:()=>void=()=>undefined;const completionResponseGate=new Promise<void>((resolve)=>{releaseCompletionResponse=resolve;});
    const taskId='80000000-0000-4000-8000-000000000008';
    const fetchMock=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{const url=String(input);if(url.endsWith('/api/capabilities'))return json(capabilities);if(url.endsWith('/api/model-catalog'))return json([]);if(url.endsWith('/api/account')){accountReads+=1;if(accountReads>1)await refreshGate;return json({userId:'user',displayName:'developer',balanceCents:5000,currency:'CNY',plan:'developer'});}if(url.endsWith('/api/model-sources'))return json([{id:'ai-kai',label:'AI.KAI.COM',status:'live',callable:true,paymentDirection:'钱包 → ai.kai.com',note:'已连接',models:[{id:'model',label:'模型',contextWindow:128000,inputPricePerMillionCents:100,outputPricePerMillionCents:200}]}]);if(url.endsWith('/api/devices/web-device/heartbeat')){const body=JSON.parse(String(init?.body)) as {taskId?:string};if(body.taskId){markLeaseHeartbeatStarted();await leaseHeartbeatGate;return json({error:'task_lease_expired',message:'expired'},409);}return json({id:'web-device',name:'COD Web',platform:'web',status:'online',lastSeenAt:new Date().toISOString()});}if(url.endsWith('/api/devices'))return json([{id:'web-device',name:'COD Web',platform:'web',status:'online',lastSeenAt:new Date().toISOString()}]);if(url.endsWith('/api/tasks')){taskReads+=1;return json([{id:taskId,title:'终态竞态',status:taskStatus,deviceId:'web-device',updatedAt:new Date().toISOString(),version:taskVersion,result:taskStatus==='complete'?'完成':null,error:null}]);}if(/\/api\/tasks\/[^/]+\/status$/.test(url)){const body=JSON.parse(String(init?.body)) as {status:'running'|'complete';leaseToken?:string};taskStatus=body.status;taskVersion+=1;if(body.status==='complete')await completionResponseGate;return json({id:taskId,title:'终态竞态',status:taskStatus,deviceId:'web-device',updatedAt:new Date().toISOString(),version:taskVersion,result:taskStatus==='complete'?'完成':null,error:null,...(taskStatus==='running'?{execution:{executionId:'90000000-0000-4000-8000-000000000009',leaseToken:body.leaseToken,leaseExpiresAt:new Date(Date.now()+90_000).toISOString()}}:{})});}if(url.endsWith('/v1/chat/completions')){markChatStarted();await chatGate;return json({choices:[{message:{content:'完成'}}],usage:{prompt_tokens:1,completion_tokens:1},cod_source:'ai-kai'});}if(url.endsWith('/api/credit-packs'))return json(creditPacks);if(url.endsWith('/api/products')||url.endsWith('/api/ledger'))return json([]);throw new Error(`Unexpected request: ${url}`);});
    vi.stubGlobal('fetch',fetchMock);window.localStorage.setItem('cod.session.token','test-token');window.localStorage.setItem('cod.device.id','web-device');render(<App/>);expect(await screen.findByRole('heading',{name:'终态竞态',level:1})).toBeInTheDocument();fireEvent.click(screen.getByTitle('普通对话'));const composer=screen.getByPlaceholderText('问 COD 任何问题...');fireEvent.change(composer,{target:{value:'完成时心跳迟到'}});fireEvent.click(screen.getByRole('button',{name:'发送'}));await chatStarted;document.dispatchEvent(new Event('visibilitychange'));await leaseHeartbeatStarted;releaseChat();await waitFor(()=>expect(taskStatus).toBe('complete'));releaseLeaseHeartbeat();await waitFor(()=>expect(taskReads).toBeGreaterThan(1));expect(screen.queryByText(/任务执行租约已失效/)).not.toBeInTheDocument();releaseCompletionResponse();await waitFor(()=>expect(accountReads).toBeGreaterThan(1));releaseRefresh();await waitFor(()=>expect(screen.getAllByText('完成').length).toBeGreaterThan(0));expect(screen.getAllByText('已完成').length).toBeGreaterThan(0);
  });

  it('terminates a running task, aborts the model request, and renders the synchronized cancelled state',async()=>{
    let taskVersion=1;let chatSignal:AbortSignal|undefined;let markChatStarted:()=>void=()=>undefined;const chatStarted=new Promise<void>((resolve)=>{markChatStarted=resolve;});
    const fetchMock=vi.fn(async(input:RequestInfo|URL,init?:RequestInit):Promise<Response>=>{const url=String(input);if(url.endsWith('/api/capabilities'))return json(capabilities);if(url.endsWith('/api/auth/login'))return json({token:'test-token'});if(url.endsWith('/api/account'))return json({userId:'user',displayName:'developer',balanceCents:5000,currency:'CNY',plan:'developer'});if(url.endsWith('/api/model-sources'))return json([{id:'ai-kai',label:'AI.KAI.COM',status:'live',callable:true,paymentDirection:'钱包 → ai.kai.com',note:'已连接',models:[{id:'slow-model',label:'慢模型',contextWindow:128000,inputPricePerMillionCents:100,outputPricePerMillionCents:200}]}]);if(url.endsWith('/api/devices')&&init?.method==='POST')return json({id:'web-device',name:'COD Web',platform:'web',status:'online',lastSeenAt:new Date().toISOString()},201);if(url.endsWith('/api/devices/web-device/heartbeat'))return json({id:'web-device',name:'COD Web',platform:'web',status:'online',lastSeenAt:new Date().toISOString()});if(url.endsWith('/api/devices'))return json([]);if(url.endsWith('/api/tasks'))return json([]);if(url.endsWith('/api/tasks')&&init?.method==='POST')throw new Error('unreachable');if(/\/api\/tasks\/task-cancel\/status$/.test(url)){const body=JSON.parse(String(init?.body)) as {leaseToken?:string};taskVersion+=1;return json({id:'task-cancel',title:'终止测试',status:'running',deviceId:'web-device',updatedAt:new Date().toISOString(),version:taskVersion,result:null,error:null,execution:{executionId:'40000000-0000-4000-8000-000000000004',leaseToken:body.leaseToken,leaseExpiresAt:new Date(Date.now()+90_000).toISOString()}});}if(/\/api\/tasks\/task-cancel\/cancel$/.test(url)){taskVersion+=1;return json({task:{id:'task-cancel',title:'终止测试',status:'cancelled',deviceId:'web-device',updatedAt:new Date().toISOString(),version:taskVersion,result:null,error:null},cancelledRequests:1});}if(url.endsWith('/v1/chat/completions')){chatSignal=init?.signal??undefined;markChatStarted();return new Promise<Response>((_resolve,reject)=>chatSignal?.addEventListener('abort',()=>reject(chatSignal?.reason),{once:true}));}if(url.endsWith('/api/credit-packs'))return json(creditPacks);if(url.endsWith('/api/products')||url.endsWith('/api/ledger'))return json([]);throw new Error(`Unexpected request: ${url}`);});
    vi.stubGlobal('fetch',fetchMock);window.localStorage.setItem('cod.device.id','web-device');window.localStorage.setItem('cod.session.token','test-token');
    const originalList=fetchMock.getMockImplementation();fetchMock.mockImplementation(async(input,init)=>{const url=String(input);if(url.endsWith('/api/tasks')&&init?.method!=='POST')return json([{id:'task-cancel',title:'终止测试',status:'draft',deviceId:'web-device',updatedAt:new Date().toISOString(),version:taskVersion,result:null,error:null}]);return originalList!(input,init);});
    render(<App/>);expect(await screen.findByRole('heading',{name:'终止测试',level:1})).toBeInTheDocument();fireEvent.click(screen.getByTitle('普通对话'));const composer=screen.getByPlaceholderText('问 COD 任何问题...');fireEvent.change(composer,{target:{value:'持续生成直到我终止'}});fireEvent.click(screen.getByRole('button',{name:'发送'}));await chatStarted;const cancelButton=await screen.findByRole('button',{name:'终止任务'});fireEvent.click(cancelButton);
    expect(await screen.findByRole('button',{name:'重新执行'})).toBeInTheDocument();expect(screen.getByText(/未结算请求不扣费，已完成或结算中的请求按实际用量计费/)).toBeInTheDocument();expect(screen.queryByText(/本次终止不会产生模型用量扣费/)).not.toBeInTheDocument();expect(chatSignal?.aborted).toBe(true);const chatCall=fetchMock.mock.calls.find(([url])=>String(url).endsWith('/v1/chat/completions'));expect(JSON.parse(String(chatCall?.[1]?.body))).toMatchObject({task_id:'task-cancel'});expect(fetchMock.mock.calls.some(([url])=>String(url).endsWith('/api/tasks/task-cancel/cancel'))).toBe(true);
  });

  it('runs model comparisons and preserves the session when one provider fails', async()=>{
    let taskVersion=1;let partialFailure=false;const fetchMock=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{const url=String(input);if(url.endsWith('/api/capabilities'))return json(capabilities);if(url.endsWith('/api/auth/login'))return json({token:'test-token'});if(url.endsWith('/api/account'))return json({userId:'user',displayName:'developer',balanceCents:5000,currency:'CNY',plan:'developer'});if(url.endsWith('/api/model-sources'))return json([{id:'ai-kai',label:'AI.KAI.COM',status:'live',callable:true,paymentDirection:'钱包 → ai.kai.com',note:'已连接',models:[{id:'model-a',label:'模型 A',contextWindow:128000,inputPricePerMillionCents:100,outputPricePerMillionCents:200},{id:'model-b',label:'模型 B',contextWindow:128000,inputPricePerMillionCents:150,outputPricePerMillionCents:300}]}]);if(url.endsWith('/api/devices')&&init?.method==='POST')return json({id:'web-device',name:'COD Web',platform:'web',status:'online',lastSeenAt:new Date().toISOString()},201);if(url.endsWith('/api/devices/web-device/heartbeat'))return json({id:'web-device',name:'COD Web',platform:'web',status:'online',lastSeenAt:new Date().toISOString()});if(url.endsWith('/api/devices'))return json([]);if(url.endsWith('/api/tasks')&&init?.method==='POST')return json({id:'compare-task',title:'同一个问题',status:'draft',deviceId:'web-device',updatedAt:new Date().toISOString(),version:taskVersion},201);if(url.endsWith('/api/tasks'))return json([]);if(/\/api\/tasks\/compare-task\/status$/.test(url)){const body=JSON.parse(String(init?.body)) as {status:'running'|'complete';leaseToken?:string};taskVersion+=1;return json({id:'compare-task',title:'同一个问题',status:body.status,deviceId:'web-device',updatedAt:new Date().toISOString(),version:taskVersion,result:body.status==='complete'?'比较完成':null,error:null,...(body.status==='running'?{execution:{executionId:'50000000-0000-4000-8000-000000000005',leaseToken:body.leaseToken,leaseExpiresAt:new Date(Date.now()+90_000).toISOString()}}:{})});}if(url.endsWith('/v1/chat/completions')){const body=JSON.parse(String(init?.body)) as {model:string;messages:Array<{content:string}>};if(partialFailure&&body.model==='model-a')return json({error:'ai_upstream_auth_failed',message:'KAI model provider authentication failed'},502);return json({choices:[{message:{content:`${body.model} 的回答`}}],usage:{prompt_tokens:10,completion_tokens:20},cod_source:'ai-kai'});}if(url.endsWith('/api/credit-packs'))return json(creditPacks);if(url.endsWith('/api/products')||url.endsWith('/api/ledger'))return json([]);throw new Error(`Unexpected request: ${url}`);});
    vi.stubGlobal('fetch',fetchMock);render(<App/>);await screen.findByRole('heading',{name:'新对话'});fireEvent.click(screen.getByTitle('登录'));const dialog=await screen.findByRole('dialog',{name:'登录 COD'});fireEvent.change(within(dialog).getByLabelText('邮箱'),{target:{value:'developer@kai.com'}});fireEvent.change(within(dialog).getByLabelText('密码'),{target:{value:'Password123'}});fireEvent.click(within(dialog).getByRole('button',{name:'登录'}));await screen.findByRole('heading',{name:'新建或选择任务'});fireEvent.click(screen.getByTitle('普通对话'));fireEvent.click(screen.getByRole('button',{name:/多模型对比/}));expect(screen.getByText('本次发送将产生 2 次独立计费请求')).toBeInTheDocument();const composer=screen.getByPlaceholderText('输入一个问题，同时询问 2 个模型...');fireEvent.change(composer,{target:{value:'同一个问题'}});fireEvent.click(screen.getByRole('button',{name:'发送'}));expect(await screen.findByText('model-a 的回答')).toBeInTheDocument();expect(screen.getByText('model-b 的回答')).toBeInTheDocument();expect(screen.getByText('同一问题 · 2 个模型')).toBeInTheDocument();let calls=fetchMock.mock.calls.filter(([url])=>String(url).endsWith('/v1/chat/completions'));expect(calls).toHaveLength(2);expect(calls.map(([,init])=>(JSON.parse(String(init?.body)) as {model:string}).model).sort()).toEqual(['model-a','model-b']);fireEvent.click(screen.getByRole('button',{name:'选用此回答'}));expect(screen.getByRole('combobox',{name:'模型'})).toHaveValue('model-b');expect(screen.getAllByText('已将 AI.KAI.COM · 模型 B 设为默认模型并用于后续上下文。').length).toBeGreaterThan(0);
    partialFailure=true;fireEvent.click(screen.getByRole('button',{name:/多模型对比/}));expect(screen.getByText('本次发送将产生 2 次独立计费请求')).toBeInTheDocument();fireEvent.change(composer,{target:{value:'继续比较'}});fireEvent.click(screen.getByRole('button',{name:'发送'}));expect(await screen.findByText('模型服务认证配置异常，本次失败未扣费。请切换其他模型或稍后再试。')).toBeInTheDocument();await waitFor(()=>expect(screen.getAllByText('model-b 的回答')).toHaveLength(2));calls=fetchMock.mock.calls.filter(([url])=>String(url).endsWith('/v1/chat/completions'));expect(calls).toHaveLength(4);expect(calls.filter(([,init])=>(JSON.parse(String(init?.body)) as {model:string}).model==='model-a')).toHaveLength(2);expect(window.localStorage.getItem('cod.session.token')).toBe('test-token');
  });

  it('loads synchronized tasks, filters them, and does not fake Web terminal output', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/capabilities')) return json(capabilities);
      if (url.endsWith('/api/auth/login')) return json({ token: 'test-token' });
      if (url.endsWith('/api/account')) return json({ userId: 'user', displayName: 'developer', balanceCents: 6839, currency: 'CNY', plan: 'developer' });
      if (url.endsWith('/api/model-sources')) return json([
        { id: 'ai-kai', label: 'AI.KAI.COM', status: 'live', callable: true, paymentDirection: '钱包 → ai.kai.com', note: '已连接', models: [{ id: 'glm-5.2', label: 'glm-5.2', contextWindow: 0, inputPricePerMillionCents: 836, outputPricePerMillionCents: 2926 }] },
        { id: 'chase-kai', label: 'CHASE.KAI.COM', status: 'catalog', callable: false, paymentDirection: '钱包 → chase.kai.com', note: '仅目录', models: [{ id: 'gpt-5.6-sol', label: 'gpt-5.6-sol', contextWindow: 0, inputPricePerMillionCents: 52500, outputPricePerMillionCents: 420000 }] },
      ]);
      if (url.endsWith('/api/devices') && init?.method === 'POST') return json({ id: 'web-device', name: 'COD Web', platform: 'web', status: 'online', lastSeenAt: new Date().toISOString() }, 201);
      if (url.endsWith('/api/devices')) return json([{ id: 'desktop-device', name: 'COD Desktop', platform: 'linux', status: 'online', lastSeenAt: new Date().toISOString() }]);
      if (url.endsWith('/api/tasks')) return json([{ id: 'task-1', title: '真实同步任务', status: 'draft', deviceId: 'desktop-device', updatedAt: new Date().toISOString(), version: 1 }]);
      if (url.endsWith('/api/credit-packs')) return json(creditPacks);
      if (url.endsWith('/api/products') || url.endsWith('/api/ledger')) return json([]);
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    await screen.findByRole('heading', { name: '新对话' });
    fireEvent.click(screen.getByTitle('登录'));
    const loginDialog = await screen.findByRole('dialog', { name: '登录 COD' });
    fireEvent.change(within(loginDialog).getByLabelText('邮箱'), { target: { value: 'developer@kai.com' } });
    fireEvent.change(within(loginDialog).getByLabelText('密码'), { target: { value: 'Password123' } });
    fireEvent.click(within(loginDialog).getByRole('button', { name: '登录' }));
    expect(await screen.findByRole('heading', { name: '真实同步任务', level: 1 })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: '模型源' })).toHaveValue('ai-kai');
    expect(screen.getByRole('combobox', { name: '模型' })).toHaveValue('glm-5.2');
    fireEvent.change(screen.getByRole('combobox', { name: '模型源' }), { target: { value: 'chase-kai' } });
    expect(screen.getByRole('combobox', { name: '模型' })).toHaveValue('gpt-5.6-sol');
    expect(screen.getAllByText('仅目录')).not.toHaveLength(0);
    fireEvent.change(screen.getByPlaceholderText('问 COD 任何问题...'), { target: { value: '不能从目录源调用' } });
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled();

    fireEvent.change(screen.getByLabelText('搜索任务'), { target: { value: '不存在' } });
    expect(screen.getByText('没有匹配的任务')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('搜索任务'), { target: { value: '' } });
    expect(screen.getByRole('button', { name: /真实同步任务/ })).toBeInTheDocument();
    fireEvent.click(screen.getByTitle('普通对话'));
    expect(screen.getByRole('heading', { name: '新建或选择任务', level: 1 })).toBeInTheDocument();
    expect(screen.getByDisplayValue('不能从目录源调用')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '终端' }));
    expect(screen.getByText('Web 端不会执行或伪造终端结果。请使用 COD Desktop。')).toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/auth/login', expect.anything()));
  });

  it('refreshes wallet and credit balances when another signed-in client changes them', async () => {
    let accountReads = 0; let creditReads = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/capabilities')) return json(capabilities);
      if (url.endsWith('/api/model-catalog')) return json([]);
      if (url.endsWith('/api/account')) { accountReads += 1; return json({ userId: 'user', displayName: 'developer', balanceCents: accountReads === 1 ? 688 : 0, currency: 'CNY', plan: 'developer' }); }
      if (url.endsWith('/api/model-sources')) return json([{ id: 'demo', label: 'Demo', status: 'demo', callable: true, paymentDirection: 'demo', note: '', models: [{ id: 'coder-pro', label: 'Coder Pro', contextWindow: 0, inputPricePerMillionCents: 0, outputPricePerMillionCents: 0 }] }]);
      if (url.endsWith('/api/credit-packs')) { creditReads += 1; return json({ packs: [], summary: { availableCents: creditReads === 1 ? 0 : 201, grants: [] } }); }
      if (url.endsWith('/api/devices') && init?.method === 'POST') return json({ id: 'web-device', name: 'COD Web', platform: 'web', status: 'online', lastSeenAt: new Date().toISOString() }, 201);
      if (url.endsWith('/api/devices/web-device/heartbeat')) return json({ id: 'web-device', name: 'COD Web', platform: 'web', status: 'online', lastSeenAt: new Date().toISOString() });
      if (url.endsWith('/api/devices') || url.endsWith('/api/tasks') || url.endsWith('/api/products') || url.endsWith('/api/ledger')) return json([]);
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock); window.localStorage.setItem('cod.session.token', 'test-token');
    render(<App />);
    expect(await screen.findByText('¥ 6.88')).toBeInTheDocument();
    document.dispatchEvent(new Event('visibilitychange'));
    expect(await screen.findByText('¥ 2.01')).toBeInTheDocument();
  });
});
