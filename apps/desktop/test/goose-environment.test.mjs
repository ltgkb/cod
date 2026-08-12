import assert from 'node:assert/strict';
import test from 'node:test';
import { minimalGooseEnvironment } from '../dist/goose-environment.js';

test('inherits only runtime paths and locale/certificate settings, never host credentials', () => {
  const environment = minimalGooseEnvironment({
    PATH: '/usr/bin:/bin',
    HOME: '/Users/tester',
    USER: 'tester',
    TMPDIR: '/tmp',
    LANG: 'zh_CN.UTF-8',
    LC_MESSAGES: 'zh_CN.UTF-8',
    LC_SECRET: 'locale-shaped-secret',
    SSL_CERT_FILE: '/etc/ssl/cert.pem',
    AWS_ACCESS_KEY_ID: 'aws-id',
    AWS_SECRET_ACCESS_KEY: 'aws-secret',
    AZURE_CLIENT_SECRET: 'azure-secret',
    GOOGLE_APPLICATION_CREDENTIALS: '/tmp/gcp-key.json',
    GH_TOKEN: 'github-token',
    GITHUB_TOKEN: 'github-token-2',
    NPM_TOKEN: 'npm-token',
    NPM_CONFIG_USERCONFIG: '/tmp/npmrc',
    DATABASE_URL: 'postgres://secret',
    COD_SESSION_TOKEN: 'full-cod-session',
    CUSTOM_API_KEY: 'custom-key',
    PASSWORD: 'password',
    MALFORMED: 'bad\0value',
  });

  assert.deepEqual(environment, {
    PATH: '/usr/bin:/bin',
    HOME: '/Users/tester',
    USER: 'tester',
    TMPDIR: '/tmp',
    LANG: 'zh_CN.UTF-8',
    LC_MESSAGES: 'zh_CN.UTF-8',
    SSL_CERT_FILE: '/etc/ssl/cert.pem',
  });
  for (const name of Object.keys(environment)) assert.doesNotMatch(name, /(TOKEN|KEY|SECRET|PASSWORD|AWS|AZURE|GOOGLE|GITHUB|NPM)/i);
});
