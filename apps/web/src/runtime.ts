export interface NativeHttpRequest {
  id: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

export interface NativeHttpResponse {
  status: number;
  body: string;
}

export interface CodRuntimeConfig {
  controlPlaneUrl?: string;
  hostPlatform?: 'android' | 'ios';
  nativeRequest?: (request: NativeHttpRequest) => Promise<NativeHttpResponse>;
  cancelNativeRequest?: (id: string) => Promise<void>;
  openExternalUrl?: (url: string) => Promise<void>;
  copyText?: (value: string) => Promise<void>;
  setNativeColorMode?: (mode: 'light' | 'dark') => Promise<void>;
  setNativeTopmostUiVisible?: (visible: boolean) => Promise<void>;
  loadSessionCleanupPending?: () => Promise<boolean>;
  loadSessionToken?: () => Promise<string | null>;
  saveSessionToken?: (token: string) => Promise<void>;
  clearSessionToken?: (expectedToken?: string) => Promise<boolean>;
}

let runtime: CodRuntimeConfig = {};
const closeTopmostUiEvent = 'cod:close-topmost-ui';

export function configureCodRuntime(next: CodRuntimeConfig): void {
  runtime = next;
}

export function getCodRuntime(): Readonly<CodRuntimeConfig> {
  return runtime;
}

export function requestCodTopmostUiClose(): void {
  window.dispatchEvent(new Event(closeTopmostUiEvent));
}

export function observeCodTopmostUiClose(listener: () => void): () => void {
  window.addEventListener(closeTopmostUiEvent, listener);
  return () => window.removeEventListener(closeTopmostUiEvent, listener);
}

export async function openCodExternalUrl(value: string): Promise<void> {
  const url = new URL(value, window.location.href);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('只允许打开 HTTP 或 HTTPS 链接');
  if (runtime.openExternalUrl) {
    await runtime.openExternalUrl(url.href);
    return;
  }
  window.open(url.href, '_blank', 'noopener,noreferrer');
}

export async function copyCodText(value: string): Promise<boolean> {
  if (runtime.copyText) {
    await runtime.copyText(value);
    return true;
  }
  if (!navigator.clipboard) return false;
  await navigator.clipboard.writeText(value);
  return true;
}
