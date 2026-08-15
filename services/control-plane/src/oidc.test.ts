import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { OidcClient } from './oidc.js';

const issuer = 'https://auth.kai.com/api/auth';
const clientId = 'cod-test-client';
const config = {
  mode: 'hybrid' as const,
  issuer,
  clientId,
  clientSecret: 'test-client-secret',
  redirectUri: 'https://cod.kai.com/api/auth/oidc/callback',
  tenantId: 'tenant_kai_identity',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('KAI Identity OIDC client', () => {
  it('uses PKCE, verifies an EdDSA ID token, and consumes exchange tickets once', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'kai-test-key', alg: 'EdDSA', use: 'sig' };
    let nonce = '';
    const now = Date.parse('2026-08-15T08:00:00.000Z');
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/.well-known/openid-configuration')) return json({
        issuer,
        authorization_endpoint: `${issuer}/oauth2/authorize`,
        token_endpoint: `${issuer}/oauth2/token`,
        jwks_uri: `${issuer}/jwks`,
        userinfo_endpoint: `${issuer}/oauth2/userinfo`,
        code_challenge_methods_supported: ['S256'],
        id_token_signing_alg_values_supported: ['EdDSA'],
      });
      if (url.endsWith('/oauth2/token')) {
        expect(new Headers(init?.headers).get('authorization')).toMatch(/^Basic /);
        expect(String(init?.body)).toContain('code_verifier=');
        const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', kid: 'kai-test-key', typ: 'JWT' })).toString('base64url');
        const payload = Buffer.from(JSON.stringify({ iss: issuer, sub: 'identity-user-1', aud: clientId, exp: now / 1_000 + 300, iat: now / 1_000, nonce, email: 'member@kai.com', email_verified: true, name: 'KAI Member' })).toString('base64url');
        const signature = sign(null, Buffer.from(`${header}.${payload}`), privateKey).toString('base64url');
        return json({ id_token: `${header}.${payload}.${signature}`, access_token: 'access-token' });
      }
      if (url.endsWith('/jwks')) return json({ keys: [jwk] });
      throw new Error(`Unexpected OIDC request: ${url}`);
    }) as typeof fetch;
    const client = new OidcClient(config, fetcher, () => now);

    const authorizationUrl = new URL(await client.begin('/app/?from=login'));
    nonce = authorizationUrl.searchParams.get('nonce') ?? '';
    expect(authorizationUrl.origin).toBe('https://auth.kai.com');
    expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorizationUrl.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const state = authorizationUrl.searchParams.get('state') ?? '';
    const completed = await client.complete(state, 'authorization-code');
    expect(completed).toEqual({ identity: { issuer, subject: 'identity-user-1', email: 'member@kai.com', name: 'KAI Member' }, returnTo: '/app/?from=login' });
    await expect(client.complete(state, 'authorization-code')).rejects.toMatchObject({ code: 'oidc_state_invalid' });

    const ticket = client.issueExchangeTicket('cod-session-token');
    expect(client.consumeExchangeTicket(ticket)).toBe('cod-session-token');
    expect(() => client.consumeExchangeTicket(ticket)).toThrow('登录兑换码无效或已过期');
  });

  it('rejects unsafe return locations before redirecting to the identity service', async () => {
    const client = new OidcClient(config, vi.fn() as unknown as typeof fetch);
    await expect(client.begin('//evil.example')).rejects.toMatchObject({ code: 'invalid_return_to' });
  });
});
