export const nativeBridgeCapabilityGlobal = '__COD_NATIVE_BRIDGE_CAPABILITY_V1';
export const nativeBridgeCapabilityReadyEvent = 'cod:native-bridge-capability-ready';

const productionDocumentPolicy = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

const developmentDocumentPolicy = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  'connect-src http: https: ws: wss:',
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

function validCapability(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function assertNativeBridgeCapability(received: unknown, expected: string): void {
  const candidate=typeof received==='string'?received:'';
  let mismatch=candidate.length^expected.length;
  for(let index=0;index<expected.length;index+=1)mismatch|=expected.charCodeAt(index)^(candidate.charCodeAt(index)||0);
  if (!validCapability(expected) || mismatch!==0) throw new Error('Untrusted DOM bridge action');
}

export function runAuthorizedNativeBridgeAction<T>(received: unknown, expected: string, action: () => T): T {
  assertNativeBridgeCapability(received,expected);
  return action();
}

export function readNativeBridgeCapability(): string {
  const value=(window as typeof window & Record<string,string|undefined>)[nativeBridgeCapabilityGlobal];
  if(!validCapability(value))throw new Error('Native bridge capability is unavailable');
  return value;
}

export function tryReadNativeBridgeCapability(): string | null {
  try { return readNativeBridgeCapability(); }
  catch { return null; }
}

export function createNativeBridgeDocumentStartScript(
  capability: string,
  development: boolean,
  hostPlatform?: 'android' | 'ios',
  developmentOrigin?: string,
): string {
  if(!validCapability(capability))throw new Error('Native bridge capability is invalid');
  if(hostPlatform!=='android'&&hostPlatform!=='ios')throw new Error('Native bridge host platform is invalid');
  let trustedDevelopmentOrigin: string | null = null;
  if(developmentOrigin !== undefined) {
    const parsedOrigin = new URL(developmentOrigin);
    if((parsedOrigin.protocol!=='http:'&&parsedOrigin.protocol!=='https:')||parsedOrigin.username||parsedOrigin.password||parsedOrigin.origin!==developmentOrigin) {
      throw new Error('Native bridge development origin is invalid');
    }
    trustedDevelopmentOrigin=parsedOrigin.origin;
  }
  const policy=development?developmentDocumentPolicy:productionDocumentPolicy;
  return `(function(){
    var trusted=false;
    try{
      var currentUrl=new URL(String(window.location&&window.location.href||''));
      if(${development?'true':'false'}){
        var developmentOrigin=${JSON.stringify(trustedDevelopmentOrigin)};
        trusted=Boolean(developmentOrigin&&(currentUrl.protocol==='http:'||currentUrl.protocol==='https:')&&!currentUrl.username&&!currentUrl.password&&currentUrl.origin===developmentOrigin&&(currentUrl.pathname==='/_cod/expo-dom-bootstrap'||currentUrl.pathname.indexOf('/_expo/@dom/')===0));
      }else if(${JSON.stringify(hostPlatform)}==='android'){
        trusted=currentUrl.protocol==='file:'&&!currentUrl.username&&!currentUrl.password&&!currentUrl.hostname&&/^\\/android_asset\\/www\\.bundle\\/[0-9a-f]{32}\\.html$/i.test(currentUrl.pathname);
      }else if(${JSON.stringify(hostPlatform)}==='ios'){
        trusted=currentUrl.protocol==='file:'&&!currentUrl.username&&!currentUrl.password&&!currentUrl.hostname&&/\\/www\\.bundle\\/[0-9a-f]{32}\\.html$/i.test(currentUrl.pathname);
      }
    }catch(_error){trusted=false;}
    if(!trusted)return;
    var capability=${JSON.stringify(capability)};
    var installedCapability=window[${JSON.stringify(nativeBridgeCapabilityGlobal)}];
    if(installedCapability===capability)return;
    if(installedCapability!==undefined)return;
    Object.defineProperty(window,${JSON.stringify(nativeBridgeCapabilityGlobal)},{value:capability,writable:false,configurable:false,enumerable:false});
    try{window.dispatchEvent(new Event(${JSON.stringify(nativeBridgeCapabilityReadyEvent)}));}catch(_error){}
    var blockedOpen=function(){return null;};
    try{Object.defineProperty(window,'open',{value:blockedOpen,writable:false,configurable:false});}catch(_error){window.open=blockedOpen;}
    var blockAnchorNavigation=function(event){
      var node=event&&event.target;
      while(node&&node!==document){if(node.nodeType===1&&String(node.tagName).toLowerCase()==='a'&&node.hasAttribute('href')){event.preventDefault();return;}node=node.parentNode;}
    };
    document.addEventListener('click',blockAnchorNavigation,true);
    document.addEventListener('auxclick',blockAnchorNavigation,true);
    document.addEventListener('dragstart',blockAnchorNavigation,true);
    var policy=${JSON.stringify(policy)};
    var installPolicy=function(){
      if(!document.head)return false;
      var existing=document.head.querySelector('meta[data-cod-document-start-csp]');
      if(!existing){existing=document.createElement('meta');existing.setAttribute('http-equiv','Content-Security-Policy');existing.setAttribute('data-cod-document-start-csp','v1');document.head.prepend(existing);}
      existing.setAttribute('content',policy);
      return true;
    };
    if(!installPolicy()){
      var policyObserver=new MutationObserver(function(){if(installPolicy())policyObserver.disconnect();});
      policyObserver.observe(document.documentElement||document,{childList:true,subtree:true});
    }
    var removeEmbeddedContent=function(root){
      if(root&&root.matches&&root.matches('iframe,frame,object,embed'))root.remove();
      if(root&&root.querySelectorAll)root.querySelectorAll('iframe,frame,object,embed').forEach(function(node){node.remove();});
    };
    var frameObserver=new MutationObserver(function(records){records.forEach(function(record){record.addedNodes.forEach(removeEmbeddedContent);});});
    frameObserver.observe(document.documentElement||document,{childList:true,subtree:true});
  })();true;`;
}
