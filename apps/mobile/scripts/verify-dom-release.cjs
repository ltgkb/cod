'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const requiredDirectives = [
  "default-src 'none'",
  "connect-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
];

function verifyDomReleaseDirectory(outputDirectory) {
  const bundleDirectory=path.join(outputDirectory,'www.bundle');
  const htmlFiles=fs.readdirSync(bundleDirectory).filter((name)=>/^[0-9a-f]{32}\.html$/i.test(name));
  assert.ok(htmlFiles.length>0,`No Expo DOM release HTML found in ${bundleDirectory}`);
  for(const name of htmlFiles){
    const html=fs.readFileSync(path.join(bundleDirectory,name),'utf8');
    const meta=html.match(/<meta http-equiv="Content-Security-Policy" data-cod-generated="strict-dom-v1" content="([^"]+)" \/>/);
    assert.ok(meta,`${name} is missing the generated CSP`);
    const policy=meta[1];
    assert.ok(html.indexOf(meta[0])<html.search(/<(?:style|script)(?:\s|>)/),`${name} CSP must precede executable content`);
    for(const directive of requiredDirectives)assert.ok(policy.includes(directive),`${name} CSP is missing ${directive}`);
    assert.ok(!/script-src[^;]*'unsafe-inline'/.test(policy),`${name} production script-src must not use unsafe-inline`);
    assert.ok(!/script-src[^;]*'unsafe-eval'/.test(policy),`${name} production script-src must not use unsafe-eval`);
    const inlineScripts=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map((match)=>match[1]).filter((source)=>source.length>0);
    assert.ok(inlineScripts.length>0,`${name} should contain Expo bootstrap scripts`);
    const expectedScriptSources=["'self'",...inlineScripts.map((source)=>`'sha256-${crypto.createHash('sha256').update(source).digest('base64')}'`)];
    const scriptDirective=policy.split(';').map((directive)=>directive.trim()).find((directive)=>directive.startsWith('script-src '));
    assert.ok(scriptDirective,`${name} CSP is missing script-src`);
    assert.deepEqual(scriptDirective.split(/\s+/).slice(1),expectedScriptSources,`${name} production script-src must contain only self and exact inline-script hashes`);
    assert.doesNotMatch(html,/<(?:iframe|frame|object|embed)(?:\s|>)/i);
  }
  return htmlFiles.length;
}

if(require.main===module){
  const directory=process.argv[2];
  if(!directory)throw new Error('Usage: node verify-dom-release.cjs <expo-output-directory>');
  const count=verifyDomReleaseDirectory(path.resolve(directory));
  process.stdout.write(`Verified ${count} strict Expo DOM release document(s).\n`);
}

module.exports={verifyDomReleaseDirectory};
