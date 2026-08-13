import type { ComputeRoute } from './types';

export const computeTabPaths = ['/compute', '/compute/hosting', '/compute/assets', '/compute/news', '/compute/rankings', '/compute/me'] as const;

export function normalizeComputePath(path: string): string {
  const url = new URL(path || '/compute', 'https://cod.local');
  return url.pathname.startsWith('/compute') ? `${url.pathname}${url.search}` : '/compute';
}

export function parseComputeRoute(path: string): ComputeRoute {
  const url = new URL(normalizeComputePath(path), 'https://cod.local');
  return { path: url.pathname.replace(/\/$/, '') || '/compute', query: url.searchParams };
}

export function isDetailPath(path: string): boolean {
  return /^\/compute\/(offers|orders|devices|news)\/[^/]+$/.test(path)
    || /^\/compute\/hosting\/applications\/[^/]+$/.test(path)
    || path.startsWith('/compute/checkout/')
    || path === '/compute/hosting/apply'
    || path === '/compute/hosting/guide';
}

export function activeTab(path: string): typeof computeTabPaths[number] {
  if (path.startsWith('/compute/hosting') || path.startsWith('/compute/devices')) return '/compute/hosting';
  if (path.startsWith('/compute/assets')) return '/compute/assets';
  if (path.startsWith('/compute/news')) return '/compute/news';
  if (path.startsWith('/compute/rankings')) return '/compute/rankings';
  if (path.startsWith('/compute/me') || path.startsWith('/compute/referrals') || path.startsWith('/compute/coupons') || path.startsWith('/compute/addresses') || path.startsWith('/compute/verification') || path.startsWith('/compute/support')) return '/compute/me';
  return '/compute';
}

export const routeParam = (path: string): string => decodeURIComponent(path.split('/').filter(Boolean).at(-1) ?? '');
