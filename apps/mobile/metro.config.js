const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
const upstreamEnhanceMiddleware = config.server.enhanceMiddleware;
const controlPlaneUrl = process.env.EXPO_PUBLIC_COD_CONTROL_PLANE_URL || 'https://cod.kai.com';
const nativeActionNames = [
  'nativeRequest',
  'cancelNativeRequest',
  'openExternalUrl',
  'copyText',
  'setNativeColorMode',
  'setNativeBackAvailable',
];

const expoDomBootstrapPattern = /<script>\s*var injectedObject = \{\};[\s\S]*?window\.\$\$EXPO_INITIAL_PROPS = injectedObject\.initialProps;\s*<\/script>/;

function patchExpoDomHtml(html) {
  if (!expoDomBootstrapPattern.test(html)) return html;
  const bootstrap = JSON.stringify({
    names: nativeActionNames,
    controlPlaneUrl,
  });
  return html.replace(expoDomBootstrapPattern, () => `<script>
          (function () {
            var bootstrap = ${bootstrap};
            var hostPlatform = /Android/i.test(navigator.userAgent) ? 'android' : 'ios';
            window.$$EXPO_DOM_HOST_OS = hostPlatform;
            window.$$EXPO_INITIAL_PROPS = {
              names: bootstrap.names,
              props: {
                controlPlaneUrl: bootstrap.controlPlaneUrl,
                hostPlatform: hostPlatform
              }
            };
          })();
        </script>`);
}

config.server.enhanceMiddleware = (metroMiddleware, server) => {
  const enhancedMetroMiddleware = upstreamEnhanceMiddleware
    ? upstreamEnhanceMiddleware(metroMiddleware, server)
    : metroMiddleware;

  return (request, response, next) => {
    if (!request.url || !request.url.startsWith('/_expo/@dom')) {
      return enhancedMetroMiddleware(request, response, next);
    }

    const originalEnd = response.end;
    response.end = function patchedEnd(chunk, ...args) {
      let nextChunk = chunk;
      if (typeof chunk === 'string' || Buffer.isBuffer(chunk)) {
        const html = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
        const patched = patchExpoDomHtml(html);
        if (patched !== html) {
          response.removeHeader('Content-Length');
          nextChunk = Buffer.isBuffer(chunk) ? Buffer.from(patched, 'utf8') : patched;
        }
      }
      return originalEnd.call(this, nextChunk, ...args);
    };

    return enhancedMetroMiddleware(request, response, next);
  };
};

module.exports = config;
