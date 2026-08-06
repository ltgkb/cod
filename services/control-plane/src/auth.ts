import { createHmac, timingSafeEqual } from 'node:crypto';

interface SessionPayload {
  sub: string;
  exp: number;
}

const encode = (value: string) => Buffer.from(value).toString('base64url');

export function createSessionToken(userId: string, secret: string, now = Date.now()): string {
  const payload = encode(JSON.stringify({ sub: userId, exp: now + 7 * 24 * 60 * 60 * 1000 } satisfies SessionPayload));
  const signature = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

export function verifySessionToken(token: string, secret: string, now = Date.now()): SessionPayload | null {
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return null;
  const expected = createHmac('sha256', secret).update(payload).digest();
  const actual = Buffer.from(signature, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as SessionPayload;
    return parsed.exp > now && parsed.sub ? parsed : null;
  } catch {
    return null;
  }
}
