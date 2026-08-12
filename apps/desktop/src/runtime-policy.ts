export const defaultDesktopControlPlaneUrl = 'https://cod.kai.com';
export const defaultDesktopDevelopmentUrl = 'http://127.0.0.1:5173';

export interface DesktopRuntimeUrls {
  controlPlaneUrl: string;
  developmentUrl: string;
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

function originOnlyUrl(rawValue: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(rawValue);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '' && url.pathname !== '/')) {
    throw new Error(`${label} must be an origin without credentials, path, query, or fragment`);
  }
  return url;
}

/** Resolve renderer-visible endpoints once in the trusted main process. */
export function resolveDesktopRuntimeUrls(
  environment: NodeJS.ProcessEnv,
  packaged: boolean,
): DesktopRuntimeUrls {
  const controlPlane = originOnlyUrl(
    environment.COD_CONTROL_PLANE_URL ?? defaultDesktopControlPlaneUrl,
    'COD_CONTROL_PLANE_URL',
  );
  if (packaged) {
    if (controlPlane.protocol !== 'https:') {
      throw new Error('COD_CONTROL_PLANE_URL must use HTTPS in the packaged application');
    }
    // The shared renderer currently ships a strict meta CSP containing only
    // https://cod.kai.com. Fail during startup instead of opening an app whose
    // every API request will be silently rejected by Chromium. Supporting a
    // custom production origin requires the Web build to emit the same exact
    // origin in connect-src.
    if (controlPlane.origin !== defaultDesktopControlPlaneUrl) {
      throw new Error('This packaged COD build only permits https://cod.kai.com; rebuild the Web CSP before using another control plane');
    }
  } else if (controlPlane.protocol !== 'https:'
    && !(controlPlane.protocol === 'http:' && isLoopbackHostname(controlPlane.hostname))) {
    throw new Error('COD_CONTROL_PLANE_URL must use HTTPS or loopback HTTP');
  }

  const development = originOnlyUrl(
    environment.COD_DEV_SERVER_URL ?? defaultDesktopDevelopmentUrl,
    'COD_DEV_SERVER_URL',
  );
  if (development.protocol !== 'http:' || !isLoopbackHostname(development.hostname)) {
    throw new Error('COD_DEV_SERVER_URL must use loopback HTTP');
  }

  return Object.freeze({
    controlPlaneUrl: controlPlane.origin,
    developmentUrl: development.origin,
  });
}

export function isTrustedRendererUrl(
  rawUrl: string,
  packaged: boolean,
  developmentUrl: string,
  packagedEntryUrl: string,
): boolean {
  try {
    const target = new URL(rawUrl);
    if (target.username || target.password) return false;
    if (!packaged) return target.origin === new URL(developmentUrl).origin;
    const entry = new URL(packagedEntryUrl);
    return target.protocol === 'file:'
      && target.host === entry.host
      && !target.search
      && target.pathname === entry.pathname;
  } catch {
    return false;
  }
}
