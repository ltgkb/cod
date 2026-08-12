import { HttpError } from './errors.js';

/** One card-hour is worth exactly CNY 1.002 (1,002 milli-CNY). */
export const CARD_HOUR_MILLI_CNY = 1_002;
export const CARD_HOUR_MILLI_UNITS = 1_000;

function requireSafeNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new HttpError(`${label} is invalid`, 400, 'invalid_card_hour_amount');
}

/**
 * Converts the existing cent-denominated grant balance to thousandths of a
 * card-hour. It rounds down so the displayed entitlement never exceeds the
 * money-backed balance.
 */
export function centsToCardHoursMilli(cents: number): number {
  requireSafeNonNegativeInteger(cents, 'Credit balance');
  const milliCny = cents * 10;
  if (!Number.isSafeInteger(milliCny * CARD_HOUR_MILLI_UNITS)) throw new HttpError('Credit balance is too large', 400, 'invalid_card_hour_amount');
  return Math.floor((milliCny * CARD_HOUR_MILLI_UNITS) / CARD_HOUR_MILLI_CNY);
}

/** Converts thousandths of a card-hour back to cents, rounding charges up. */
export function cardHoursMilliToCents(cardHoursMilli: number): number {
  requireSafeNonNegativeInteger(cardHoursMilli, 'Card-hour amount');
  if (!Number.isSafeInteger(cardHoursMilli * CARD_HOUR_MILLI_CNY)) throw new HttpError('Card-hour amount is too large', 400, 'invalid_card_hour_amount');
  return Math.ceil((cardHoursMilli * CARD_HOUR_MILLI_CNY) / (CARD_HOUR_MILLI_UNITS * 10));
}
