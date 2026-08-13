import type { ReturnTypeComputeApi } from './shared-internal';

export interface ComputePageProps {
  api: ReturnTypeComputeApi;
  navigate(path: string): void;
  requireLogin(path: string): void;
  signedIn: boolean;
}

