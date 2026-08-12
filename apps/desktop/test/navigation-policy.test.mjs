import assert from 'node:assert/strict';
import test from 'node:test';

import { isAllowedDevelopmentNavigation, isSafeExternalUrl } from '../dist/navigation-policy.js';

const developmentUrl = 'http://127.0.0.1:5173';

test('allows paths, queries, and fragments only on the exact development origin', () => {
  assert.equal(isAllowedDevelopmentNavigation(developmentUrl, developmentUrl), true);
  assert.equal(isAllowedDevelopmentNavigation(`${developmentUrl}/tasks/123?view=chat#latest`, developmentUrl), true);
  assert.equal(isAllowedDevelopmentNavigation('http://127.0.0.1:5173.evil.example/', developmentUrl), false);
  assert.equal(isAllowedDevelopmentNavigation('http://127.0.0.1:5173@evil.example/', developmentUrl), false);
  assert.equal(isAllowedDevelopmentNavigation('http://evil.example@127.0.0.1:5173/', developmentUrl), false);
  assert.equal(isAllowedDevelopmentNavigation('http://127.0.0.1:5174/', developmentUrl), false);
  assert.equal(isAllowedDevelopmentNavigation('https://127.0.0.1:5173/', developmentUrl), false);
});

test('rejects malformed and non-web development navigations', () => {
  assert.equal(isAllowedDevelopmentNavigation('not a URL', developmentUrl), false);
  assert.equal(isAllowedDevelopmentNavigation('javascript:alert(1)', developmentUrl), false);
  assert.equal(isAllowedDevelopmentNavigation(`blob:${developmentUrl}/opaque`, developmentUrl), false);
  assert.equal(isAllowedDevelopmentNavigation(developmentUrl, 'not a URL'), false);
});

test('opens ordinary HTTPS links and payment destinations in the system browser', () => {
  assert.equal(isSafeExternalUrl('https://kai.com/docs'), true);
  assert.equal(isSafeExternalUrl('https://openapi.alipay.com/gateway.do?order=123'), true);
  assert.equal(isSafeExternalUrl('https://github.com/Kai-Singapore-Unlimited/Kai_Zanzibar_Next'), true);
  assert.equal(isSafeExternalUrl('http://127.0.0.1:4174/docs'), true);
  assert.equal(isSafeExternalUrl('http://localhost:4174/docs'), true);
});

test('never delegates unsafe schemes, remote clear-text URLs, or embedded credentials', () => {
  assert.equal(isSafeExternalUrl('http://example.com/'), false);
  assert.equal(isSafeExternalUrl('file:///etc/passwd'), false);
  assert.equal(isSafeExternalUrl('javascript:alert(1)'), false);
  assert.equal(isSafeExternalUrl('cod://auth/callback?code=secret'), false);
  assert.equal(isSafeExternalUrl('https://user:password@example.com/'), false);
  assert.equal(isSafeExternalUrl('not a URL'), false);
});
