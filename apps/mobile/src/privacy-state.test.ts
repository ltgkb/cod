import { describe, expect, it } from 'vitest';

import { shouldObscureWorkspace } from './privacy-state';

describe('mobile workspace privacy cover', () => {
  it('shows only while the application is not active', () => {
    expect(shouldObscureWorkspace('active')).toBe(false);
    expect(shouldObscureWorkspace('inactive')).toBe(true);
    expect(shouldObscureWorkspace('background')).toBe(true);
    expect(shouldObscureWorkspace('unknown')).toBe(true);
    expect(shouldObscureWorkspace(null)).toBe(true);
  });
});
