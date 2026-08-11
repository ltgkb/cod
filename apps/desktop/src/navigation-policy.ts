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
