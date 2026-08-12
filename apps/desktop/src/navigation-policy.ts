export function isAllowedDevelopmentNavigation(rawUrl: string, rawDevelopmentUrl: string): boolean {
  try {
    const target = new URL(rawUrl);
    const development = new URL(rawDevelopmentUrl);
    if (development.protocol !== 'http:' && development.protocol !== 'https:') return false;
    if (target.protocol !== development.protocol) return false;
    if (target.username || target.password || development.username || development.password) return false;
    return target.origin === development.origin;
  } catch {
    return false;
  }
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

/**
 * Links in model output, knowledge results, and payment checkout are opened in
 * the user's default browser. Keep custom protocols and credential-bearing
 * URLs out of shell.openExternal, while allowing ordinary HTTPS destinations.
 * Loopback HTTP is useful for local development documentation without making
 * clear-text remote navigation available in the packaged client.
 */
export function isSafeExternalUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (url.username || url.password) return false;
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && isLoopbackHostname(url.hostname);
  } catch {
    return false;
  }
}
