import { createHmac, randomBytes, scrypt as nodeScrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

const scrypt=(password:string,salt:Buffer,keyLength:number,options:ScryptOptions)=>new Promise<Buffer>((resolve,reject)=>nodeScrypt(password,salt,keyLength,options,(error,derived)=>error?reject(error):resolve(derived)));
const passwordPattern = /^(?=.*\p{L})(?=.*\d).{10,128}$/u;

interface SessionPayload {
  sub: string;
  tenantId: string;
  email: string;
  role: 'member' | 'admin';
  exp: number;
}

const encode = (value: string) => Buffer.from(value).toString('base64url');

export function validatePassword(password: unknown): string {
  if (typeof password !== 'string' || !passwordPattern.test(password)) {
    throw new Error('密码须为 10-128 位，并同时包含字母和数字');
  }
  return password;
}

export async function hashPassword(password: string): Promise<string> {
  validatePassword(password);
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, 64, { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }) as Buffer;
  return `scrypt$16384$8$1$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

export async function verifyPassword(password: unknown, encoded: string): Promise<boolean> {
  if (typeof password !== 'string' || password.length > 128) return false;
  const [algorithm, n, r, p, saltValue, hashValue] = encoded.split('$');
  if (algorithm !== 'scrypt' || !saltValue || !hashValue) return false;
  const cost = Number(n); const blockSize = Number(r); const parallelization = Number(p);
  if (cost !== 16_384 || blockSize !== 8 || parallelization !== 1) return false;
  try {
    const expected = Buffer.from(hashValue, 'base64url');
    const actual = await scrypt(password, Buffer.from(saltValue, 'base64url'), expected.length, { N: cost, r: blockSize, p: parallelization, maxmem: 64 * 1024 * 1024 }) as Buffer;
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function createSessionToken(principal: Omit<SessionPayload, 'exp'>, secret: string, now = Date.now()): string {
  const payload = encode(JSON.stringify({ ...principal, exp: now + 7 * 24 * 60 * 60 * 1000 } satisfies SessionPayload));
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
    return parsed.exp > now && parsed.sub && parsed.tenantId && parsed.email && (parsed.role === 'member' || parsed.role === 'admin') ? parsed : null;
  } catch {
    return null;
  }
}
