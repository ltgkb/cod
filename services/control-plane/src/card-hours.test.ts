import { describe, expect, it } from 'vitest';
import { cardHoursMilliToCents, centsToCardHoursMilli } from './card-hours.js';
import { HttpError } from './errors.js';

describe('card-hour accounting', () => {
  it('uses the exact CNY 1.002 conversion without floating point money', () => {
    expect(centsToCardHoursMilli(1_002)).toBe(10_000);
    expect(cardHoursMilliToCents(10_000)).toBe(1_002);
  });

  it('rounds entitlements down and charges up at cent boundaries', () => {
    expect(centsToCardHoursMilli(100)).toBe(998);
    expect(cardHoursMilliToCents(998)).toBe(100);
    expect(cardHoursMilliToCents(999)).toBe(101);
  });

  it('rejects negative, fractional, and unsafe values', () => {
    for (const amount of [-1, 1.5, Number.MAX_SAFE_INTEGER]) {
      expect(() => centsToCardHoursMilli(amount)).toThrow(HttpError);
      expect(() => cardHoursMilliToCents(amount)).toThrow(HttpError);
    }
  });
});
