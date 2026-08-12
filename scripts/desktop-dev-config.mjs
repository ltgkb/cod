const DEFAULT_RENDERER_URL = 'http://127.0.0.1:5173';
const DEFAULT_CONTROL_PLANE_URL = 'http://127.0.0.1:8787';

const safeInheritedCodDevelopmentNames = new Set([
  'COD_DEV_SERVER_URL',
  'COD_DEV_CONTROL_PLANE_URL',
  // A local executable path is needed to exercise the Goose sidecar in a
  // source checkout. Remote ACP endpoints and credentials are not allowed.
  'COD_GOOSE_BINARY',
  // The reviewed desktop-pet bundle may live outside the repository during
  // local integration testing. Packaged builds deliberately ignore it.
  'COD_DESKTOP_PET_PATH',
]);

function isIsolatedApplicationEnvironmentName(name) {
  const normalizedName = name.toUpperCase();
  if (normalizedName === 'DATABASE_URL') return true;
  if (normalizedName.startsWith('COD_')) return !safeInheritedCodDevelopmentNames.has(normalizedName);
  if (normalizedName.startsWith('KAI_')) return true;
  if (normalizedName.startsWith('VITE_COD_') || normalizedName.startsWith('EXPO_PUBLIC_COD_')) return true;
  return normalizedName === 'TOKEN_RETAIL_COMMISSION_RATE_BPS'
    || normalizedName === 'CHASE_COMMISSION_RATE_BPS'
    || normalizedName === 'GOOSE_SERVER__SECRET_KEY';
}

function loopbackHttpUrl(rawValue, fallback, label) {
  let url;
  try {
    url = new URL(rawValue || fallback);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
  if (url.protocol !== 'http:') throw new Error(`${label} must use HTTP for local development`);
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
    throw new Error(`${label} must use the loopback host 127.0.0.1 or localhost`);
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error(`${label} must be an origin without credentials, path, query, or fragment`);
  }
  url.pathname = '/';
  return url;
}

export function resolveDesktopDevelopmentEndpoints(environment = {}) {
  const renderer = loopbackHttpUrl(environment.COD_DEV_SERVER_URL, DEFAULT_RENDERER_URL, 'COD_DEV_SERVER_URL');
  const controlPlane = loopbackHttpUrl(environment.COD_DEV_CONTROL_PLANE_URL, DEFAULT_CONTROL_PLANE_URL, 'COD_DEV_CONTROL_PLANE_URL');
  if (renderer.origin === controlPlane.origin) throw new Error('Desktop renderer and control plane must use different origins');
  return Object.freeze({ renderer, controlPlane });
}

export function controlPlanePort(url) {
  return url.port || '80';
}

/**
 * Build the child-process environments used by `npm run desktop` without
 * inheriting production control-plane credentials from the invoking shell.
 * A developer database must be opted into with COD_DEV_DATABASE_URL; omitting
 * it deliberately selects the control plane's in-memory store.
 */
export function resolveDesktopDevelopmentProcessEnvironments(environment = {}) {
  if (environment.NODE_ENV === 'production') {
    throw new Error('npm run desktop is a development command and cannot run with NODE_ENV=production');
  }

  const shared = { ...environment, NODE_ENV: 'development' };
  for (const name of Object.keys(environment)) {
    if (isIsolatedApplicationEnvironmentName(name)) delete shared[name];
  }

  const controlPlane = {
    ...shared,
    COD_SESSION_SECRET: 'cod-local-development-secret',
  };
  if (typeof environment.COD_DEV_DATABASE_URL === 'string' && environment.COD_DEV_DATABASE_URL.length > 0) {
    controlPlane.DATABASE_URL = environment.COD_DEV_DATABASE_URL;
  }

  return Object.freeze({
    shared: Object.freeze(shared),
    controlPlane: Object.freeze(controlPlane),
  });
}
