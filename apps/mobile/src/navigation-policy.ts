type MobileHostPlatform = 'android' | 'ios';

function isBundledDomDocument(url: URL, hostPlatform?: MobileHostPlatform): boolean {
  if(url.protocol!=='file:'||url.username||url.password||url.hostname)return false;
  if(hostPlatform==='android')return /^\/android_asset\/www\.bundle\/[0-9a-f]{32}\.html$/i.test(url.pathname);
  return /\/www\.bundle\/[0-9a-f]{32}\.html$/i.test(url.pathname);
}

function isDevelopmentDomDocument(url: URL, developmentOrigin?: string): boolean {
  if(!developmentOrigin||(url.protocol!=='http:'&&url.protocol!=='https:')||url.username||url.password||url.origin!==developmentOrigin)return false;
  return url.pathname==='/_cod/expo-dom-bootstrap'||url.pathname.startsWith('/_expo/@dom/');
}

export function isTrustedDomNavigation(rawUrl: string, developmentOrigin?: string, hostPlatform?: MobileHostPlatform): boolean {
  let url: URL;
  try { url = new URL(rawUrl); } catch { return false; }
  if (isBundledDomDocument(url,hostPlatform)) return true;
  return isDevelopmentDomDocument(url,developmentOrigin);
}

export type DomNavigationDecision = 'allow' | 'external' | 'block';

export function decideDomNavigation(rawUrl: string, isTopFrame: boolean | undefined, developmentOrigin?: string, hostPlatform?: MobileHostPlatform): DomNavigationDecision {
  if (isTrustedDomNavigation(rawUrl, developmentOrigin,hostPlatform)) return 'allow';
  if (isTopFrame === false) return 'block';
  try {
    const url = new URL(rawUrl);
    return url.protocol === 'http:' || url.protocol === 'https:' ? 'external' : 'block';
  } catch {
    return 'block';
  }
}

export function domOriginWhitelist(developmentOrigin?: string): string[] {
  return developmentOrigin ? [developmentOrigin] : ['file://'];
}
