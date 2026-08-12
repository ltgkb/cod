import { describe, expect, it, vi } from 'vitest';

import { forwardNativeBack } from './native-back';

describe('Android native back forwarding', () => {
  it('keeps the system default when the DOM has nothing dismissible', () => {
    const handleNativeBack = vi.fn();

    expect(forwardNativeBack(false, { handleNativeBack })).toBe(false);
    expect(handleNativeBack).not.toHaveBeenCalled();
  });

  it('consumes back only after the DOM handle is ready', () => {
    const handleNativeBack = vi.fn();

    expect(forwardNativeBack(true, null)).toBe(false);
    expect(forwardNativeBack(true, { handleNativeBack })).toBe(true);
    expect(handleNativeBack).toHaveBeenCalledOnce();
  });
});
