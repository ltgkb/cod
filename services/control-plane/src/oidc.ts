import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify, type JsonWebKey as NodeJsonWebKey } from 'node:crypto';
import type { OidcConfig } from './config.js';
import { HttpError } from './errors.js';

interface OidcMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint: string;
  code_challenge_methods_supported?: string[];
  id_token_signing_alg_values_supported?: string[];
}

interface LoginTransaction {
  stateHash: string;
  nonce: string;
  verifier: string;
  returnTo: string;
  expiresAt: number;
}

interface ExchangeTicket {
  token: string;
  expiresAt: number;
}

interface IdTokenClaims {
  iss?: unknown;
  sub?: unknown;
  aud?: unknown;
  azp?: unknown;
  exp?: unknown;
  iat?: unknown;
  nonce?: unknown;
  email?: unknown;
  email_verified?: unknown;
  name?: unknown;
}

type OidcJwk = NodeJsonWebKey & { kid?: string; kty?: string; crv?: string };

export interface OidcIdentity {
  issuer: string;
  subject: string;
  email: string;
  name: string | null;
}

const transactionTtlMs = 10 * 60 * 1_000;
const exchangeTicketTtlMs = 60 * 1_000;
const clockToleranceSeconds = 60;
const randomValue = (bytes = 32) => randomBytes(bytes).toString('base64url');
const digest = (value: string) => createHash('sha256').update(value).digest('base64url');

function decodeObject(segment: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new HttpError('统一身份凭据格式无效', 502, 'oidc_invalid_token');
  }
}

function sameValue(left: string, right: string): boolean {
  const first = Buffer.from(left);
  const second = Buffer.from(right);
  return first.length === second.length && timingSafeEqual(first, second);
}

export class OidcClient {
  private readonly transactions = new Map<string, LoginTransaction>();
  private readonly exchangeTickets = new Map<string, ExchangeTicket>();
  private metadataPromise: Promise<OidcMetadata> | null = null;
  private jwks: { keys: OidcJwk[]; expiresAt: number } | null = null;

  constructor(
    private readonly config: OidcConfig,
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  private cleanup() {
    const current = this.now();
    for (const [key, value] of this.transactions) if (value.expiresAt <= current) this.transactions.delete(key);
    for (const [key, value] of this.exchangeTickets) if (value.expiresAt <= current) this.exchangeTickets.delete(key);
  }

  private async metadata(): Promise<OidcMetadata> {
    this.metadataPromise ??= this.fetcher(`${this.config.issuer}/.well-known/openid-configuration`, { headers: { accept: 'application/json' } })
      .then(async (response) => {
        if (!response.ok) throw new HttpError('统一身份服务暂不可用', 503, 'oidc_discovery_unavailable');
        const metadata = await response.json() as Partial<OidcMetadata>;
        if (metadata.issuer !== this.config.issuer) throw new HttpError('统一身份服务签发方不匹配', 502, 'oidc_issuer_mismatch');
        for (const field of ['authorization_endpoint', 'token_endpoint', 'jwks_uri', 'userinfo_endpoint'] as const) {
          const value = metadata[field];
          if (typeof value !== 'string') throw new HttpError('统一身份服务发现文档不完整', 502, 'oidc_discovery_invalid');
          const parsed = new URL(value);
          if (parsed.protocol !== 'https:' || parsed.origin !== new URL(this.config.issuer).origin) throw new HttpError('统一身份服务端点不安全', 502, 'oidc_discovery_invalid');
        }
        if (!metadata.code_challenge_methods_supported?.includes('S256')) throw new HttpError('统一身份服务不支持 PKCE S256', 502, 'oidc_pkce_unsupported');
        if (!metadata.id_token_signing_alg_values_supported?.includes('EdDSA')) throw new HttpError('统一身份服务签名算法不受支持', 502, 'oidc_signing_algorithm_unsupported');
        return metadata as OidcMetadata;
      })
      .catch((error) => { this.metadataPromise = null; throw error; });
    return this.metadataPromise;
  }

  async begin(returnTo = '/app/'): Promise<string> {
    this.cleanup();
    if (!returnTo.startsWith('/') || returnTo.startsWith('//') || returnTo.includes('\\')) throw new HttpError('登录返回地址无效', 400, 'invalid_return_to');
    const metadata = await this.metadata();
    const state = randomValue();
    const verifier = randomValue(48);
    const transaction: LoginTransaction = {
      stateHash: digest(state),
      nonce: randomValue(),
      verifier,
      returnTo,
      expiresAt: this.now() + transactionTtlMs,
    };
    this.transactions.set(transaction.stateHash, transaction);
    const authorization = new URL(metadata.authorization_endpoint);
    authorization.searchParams.set('client_id', this.config.clientId);
    authorization.searchParams.set('redirect_uri', this.config.redirectUri);
    authorization.searchParams.set('response_type', 'code');
    authorization.searchParams.set('scope', 'openid profile email');
    authorization.searchParams.set('state', state);
    authorization.searchParams.set('nonce', transaction.nonce);
    authorization.searchParams.set('code_challenge', digest(verifier));
    authorization.searchParams.set('code_challenge_method', 'S256');
    return authorization.href;
  }

  private async loadJwks(uri: string): Promise<OidcJwk[]> {
    if (this.jwks && this.jwks.expiresAt > this.now()) return this.jwks.keys;
    const response = await this.fetcher(uri, { headers: { accept: 'application/json' } });
    if (!response.ok) throw new HttpError('统一身份签名密钥暂不可用', 503, 'oidc_jwks_unavailable');
    const body = await response.json() as { keys?: unknown };
    if (!Array.isArray(body.keys)) throw new HttpError('统一身份签名密钥格式无效', 502, 'oidc_jwks_invalid');
    this.jwks = { keys: body.keys as OidcJwk[], expiresAt: this.now() + 5 * 60 * 1_000 };
    return this.jwks.keys;
  }

  private async verifyIdToken(idToken: string, transaction: LoginTransaction, metadata: OidcMetadata): Promise<IdTokenClaims> {
    const segments = idToken.split('.');
    if (segments.length !== 3 || !segments[0] || !segments[1] || !segments[2]) throw new HttpError('统一身份凭据格式无效', 502, 'oidc_invalid_token');
    const header = decodeObject(segments[0]);
    const claims = decodeObject(segments[1]) as IdTokenClaims;
    if (header.alg !== 'EdDSA' || typeof header.kid !== 'string') throw new HttpError('统一身份签名算法无效', 502, 'oidc_invalid_signature');
    const keys = await this.loadJwks(metadata.jwks_uri);
    const key = keys.find((candidate) => candidate.kid === header.kid && candidate.kty === 'OKP' && candidate.crv === 'Ed25519');
    if (!key) {
      this.jwks = null;
      const refreshed = await this.loadJwks(metadata.jwks_uri);
      const rotated = refreshed.find((candidate) => candidate.kid === header.kid && candidate.kty === 'OKP' && candidate.crv === 'Ed25519');
      if (!rotated) throw new HttpError('统一身份签名密钥不存在', 502, 'oidc_signing_key_missing');
      if (!verify(null, Buffer.from(`${segments[0]}.${segments[1]}`), createPublicKey({ key: rotated, format: 'jwk' }), Buffer.from(segments[2], 'base64url'))) throw new HttpError('统一身份签名无效', 502, 'oidc_invalid_signature');
    } else if (!verify(null, Buffer.from(`${segments[0]}.${segments[1]}`), createPublicKey({ key, format: 'jwk' }), Buffer.from(segments[2], 'base64url'))) {
      throw new HttpError('统一身份签名无效', 502, 'oidc_invalid_signature');
    }
    const current = Math.floor(this.now() / 1_000);
    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (claims.iss !== this.config.issuer || !audience.includes(this.config.clientId)) throw new HttpError('统一身份凭据签发对象无效', 502, 'oidc_claims_invalid');
    if (audience.length > 1 && claims.azp !== this.config.clientId) throw new HttpError('统一身份授权方无效', 502, 'oidc_claims_invalid');
    if (typeof claims.exp !== 'number' || claims.exp < current - clockToleranceSeconds || typeof claims.iat !== 'number' || claims.iat > current + clockToleranceSeconds) throw new HttpError('统一身份凭据已过期', 401, 'oidc_token_expired');
    if (typeof claims.sub !== 'string' || !claims.sub || claims.nonce !== transaction.nonce) throw new HttpError('统一身份会话校验失败', 401, 'oidc_claims_invalid');
    return claims;
  }

  async complete(state: string, code: string): Promise<{ identity: OidcIdentity; returnTo: string }> {
    this.cleanup();
    if (!state || !code || state.length > 512 || code.length > 4_096) throw new HttpError('统一身份回调参数无效', 400, 'oidc_callback_invalid');
    const stateHash = digest(state);
    const transaction = this.transactions.get(stateHash);
    if (!transaction || !sameValue(transaction.stateHash, stateHash)) throw new HttpError('统一身份登录状态无效或已过期', 400, 'oidc_state_invalid');
    this.transactions.delete(stateHash);
    const metadata = await this.metadata();
    const tokenResponse = await this.fetcher(metadata.token_endpoint, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        authorization: `Basic ${Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: this.config.redirectUri, code_verifier: transaction.verifier }),
    });
    if (!tokenResponse.ok) throw new HttpError('统一身份授权码兑换失败', 401, 'oidc_token_exchange_failed');
    const tokens = await tokenResponse.json() as { id_token?: unknown; access_token?: unknown };
    if (typeof tokens.id_token !== 'string' || typeof tokens.access_token !== 'string') throw new HttpError('统一身份服务未返回完整凭据', 502, 'oidc_token_response_invalid');
    const claims = await this.verifyIdToken(tokens.id_token, transaction, metadata);
    let email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '';
    let emailVerified = claims.email_verified === true;
    let name = typeof claims.name === 'string' && claims.name.trim() ? claims.name.trim() : null;
    if (!email || !emailVerified || !name) {
      const userInfoResponse = await this.fetcher(metadata.userinfo_endpoint, { headers: { accept: 'application/json', authorization: `Bearer ${tokens.access_token}` } });
      if (!userInfoResponse.ok) throw new HttpError('统一身份用户信息获取失败', 502, 'oidc_userinfo_failed');
      const userInfo = await userInfoResponse.json() as Record<string, unknown>;
      if (userInfo.sub !== claims.sub) throw new HttpError('统一身份用户信息不匹配', 502, 'oidc_userinfo_mismatch');
      email = typeof userInfo.email === 'string' ? userInfo.email.trim().toLowerCase() : email;
      emailVerified = userInfo.email_verified === true || emailVerified;
      name = typeof userInfo.name === 'string' && userInfo.name.trim() ? userInfo.name.trim() : name;
    }
    if (!email || !emailVerified) throw new HttpError('统一身份账号必须包含已验证邮箱', 403, 'oidc_verified_email_required');
    return { identity: { issuer: this.config.issuer, subject: claims.sub as string, email, name }, returnTo: transaction.returnTo };
  }

  issueExchangeTicket(token: string): string {
    this.cleanup();
    const code = randomValue();
    this.exchangeTickets.set(digest(code), { token, expiresAt: this.now() + exchangeTicketTtlMs });
    return code;
  }

  consumeExchangeTicket(code: string): string {
    this.cleanup();
    if (!code || code.length > 512) throw new HttpError('登录兑换码无效', 400, 'oidc_exchange_invalid');
    const key = digest(code);
    const ticket = this.exchangeTickets.get(key);
    this.exchangeTickets.delete(key);
    if (!ticket) throw new HttpError('登录兑换码无效或已过期', 400, 'oidc_exchange_invalid');
    return ticket.token;
  }
}
