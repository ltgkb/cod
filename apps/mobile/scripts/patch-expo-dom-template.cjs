'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PATCH_MARKER = 'cod:strict-dom-csp-v1';
const expoDomTemplatePath = path.resolve(
  __dirname,
  '../../../node_modules/@expo/cli/build/src/start/server/middleware/DomComponentsMiddleware.js'
);

const originalFunction = 'function getDomComponentHtml(src, { title } = {}) {';
const renamedFunction = 'function getExpoDomComponentHtmlWithoutCodPolicy(src, { title } = {}) {';
const sourceMapMarker = '\n//# sourceMappingURL=DomComponentsMiddleware.js.map';

const wrapper = `
// ${PATCH_MARKER}
function codAddStrictDomContentSecurityPolicy(html) {
    const hashes = [...html.matchAll(/<script(?:\\s[^>]*)?>([\\s\\S]*?)<\\/script>/g)]
        .map((match)=>match[1])
        .filter((source)=>source.length > 0)
        .map((source)=>"'sha256-" + require('node:crypto').createHash('sha256').update(source).digest('base64') + "'");
    const policy = [
        "default-src 'none'",
        "script-src 'self' " + hashes.join(' '),
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "font-src 'self'",
        "connect-src 'none'",
        "frame-src 'none'",
        "child-src 'none'",
        "worker-src 'none'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'"
    ].join('; ');
    const meta = '<meta http-equiv="Content-Security-Policy" data-cod-generated="strict-dom-v1" content="' + policy + '" />';
    const charset = '<meta charset="utf-8" />';
    if (!html.includes(charset)) throw new Error('Expo DOM template no longer contains the expected charset marker');
    return html.replace(charset, charset + '\\n        ' + meta);
}
function getDomComponentHtml(src, options = {}) {
    return codAddStrictDomContentSecurityPolicy(getExpoDomComponentHtmlWithoutCodPolicy(src, options));
}
`;

function patchExpoDomTemplate(filename = expoDomTemplatePath) {
  const source = fs.readFileSync(filename, 'utf8');
  if (source.includes(PATCH_MARKER)) return false;
  if (!source.includes(originalFunction) || !source.includes(sourceMapMarker)) {
    throw new Error('Unsupported @expo/cli DOM template; refusing to build without the COD CSP patch');
  }
  const patched = source
    .replace(originalFunction, renamedFunction)
    .replace(sourceMapMarker, `${wrapper}${sourceMapMarker}`);
  fs.writeFileSync(filename, patched);
  return true;
}

if (require.main === module) patchExpoDomTemplate();

module.exports = { PATCH_MARKER, expoDomTemplatePath, patchExpoDomTemplate };
