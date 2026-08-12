import { createHmac, randomBytes, scrypt as nodeScrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

const scrypt=(password:string,salt:Buffer,keyLength:number,options:ScryptOptions)=>new Promise<Buffer>((resolve,reject)=>nodeScrypt(password,salt,keyLength,options,(error,derived)=>error?reject(error):resolve(derived)));
const passwordPattern = /^(?=.*\p{L})(?=.*\d).{10,128}$/u;

interface TokenPrincipal {
  sub: string;
  tenantId: string;
  email: string;
  role: 'member' | 'admin';
}

export interface SessionPayload extends TokenPrincipal {
  kind?: 'session';
  exp: number;
}

export interface AgentSessionScope {
  taskId: string;
  sourceId: string;
  model: string;
}

export interface AgentSessionPayload extends TokenPrincipal, AgentSessionScope {
  kind: 'agent';
  jti: string;
  exp: number;
}

export const AGENT_SESSION_TTL_MS = 60 * 60 * 1000;

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

function signPayload(value: SessionPayload | AgentSessionPayload, secret: string): string {
  const payload = encode(JSON.stringify(value));
  const signature = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function verifySignedPayload(token: string, secret: string): Record<string, unknown> | null {
  const segments = token.split('.');
  if (segments.length !== 2) return null;
  const [payload, signature] = segments;
  if (!payload || !signature) return null;
  const expected = createHmac('sha256', secret).update(payload).digest();
  let actual: Buffer;
  try { actual = Buffer.from(signature, 'base64url'); } catch { return null; }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

const hasValidPrincipal = (value: Record<string, unknown>): boolean => typeof value.sub === 'string' && Boolean(value.sub) && typeof value.tenantId === 'string' && Boolean(value.tenantId) && typeof value.email === 'string' && Boolean(value.email) && (value.role === 'member' || value.role === 'admin');

export function createSessionToken(principal: TokenPrincipal, secret: string, now = Date.now()): string {
  return signPayload({ ...principal, kind: 'session', exp: now + 7 * 24 * 60 * 60 * 1000 }, secret);
}

export function verifySessionToken(token: string, secret: string, now = Date.now()): SessionPayload | null {
  const parsed = verifySignedPayload(token, secret);
  if (!parsed || (parsed.kind !== undefined && parsed.kind !== 'session') || typeof parsed.exp !== 'number' || parsed.exp <= now || !hasValidPrincipal(parsed)) return null;
  return parsed as unknown as SessionPayload;
}

export function createAgentSessionToken(principal: TokenPrincipal, scope: AgentSessionScope, secret: string, now = Date.now()): string {
  return signPayload({ ...principal, ...scope, kind: 'agent', jti: randomBytes(16).toString('hex'), exp: now + AGENT_SESSION_TTL_MS }, secret);
}

export function verifyAgentSessionToken(token: string, secret: string, now = Date.now()): AgentSessionPayload | null {
  const parsed = verifySignedPayload(token, secret);
  if (!parsed || parsed.kind !== 'agent' || typeof parsed.exp !== 'number' || parsed.exp <= now || !hasValidPrincipal(parsed)) return null;
  if (typeof parsed.jti !== 'string' || !/^[a-f0-9]{32}$/.test(parsed.jti)) return null;
  if (typeof parsed.taskId !== 'string' || !/^[a-f0-9-]{36}$/i.test(parsed.taskId)) return null;
  if (typeof parsed.sourceId !== 'string' || !/^[a-z0-9-]{2,40}$/.test(parsed.sourceId)) return null;
  if (typeof parsed.model !== 'string' || !parsed.model.trim() || parsed.model.length > 200) return null;
  return parsed as unknown as AgentSessionPayload;
}
