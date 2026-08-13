import type { AccountSummary } from '@cod/contracts';

export interface ComputeSession {
  token: string;
  account: AccountSummary;
}

export interface ComputeAppProps {
  session: ComputeSession | null;
  initialPath: string;
  apiBaseUrl?: string;
  platform: 'web' | 'desktop' | 'mobile';
  onRequireLogin(returnTo: string): void;
  onExit(): void;
  onOpenCodTask?(input: { title: string; prompt: string }): void;
}

export type ComputeLoadState = 'idle' | 'loading' | 'ready' | 'refreshing' | 'error' | 'offline';

export interface ComputeRoute {
  path: string;
  query: URLSearchParams;
}
