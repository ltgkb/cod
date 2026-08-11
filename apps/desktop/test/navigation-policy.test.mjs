import assert from 'node:assert/strict';
import test from 'node:test';

import { isAllowedDevelopmentNavigation } from '../dist/navigation-policy.js';

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
