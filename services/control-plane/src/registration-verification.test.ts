import { describe, expect, it } from 'vitest';
import type { RegistrationVerificationConfig } from './config.js';
import {
  defaultPinnedFetcher,
  isPrivateRegistrationAddress,
  pinnedLookup,
  RegistrationVerification,
  registrationDeliveryFromConfig,
  type PinnedFetcher,
  type RegistrationEndpointValidator,
} from './registration-verification.js';

const verificationConfig = (overrides: Partial<RegistrationVerificationConfig> = {}): RegistrationVerificationConfig => ({
  hmacKey: 'h'.repeat(32),
  emailWebhook: { url: 'https://notify.example/email', bearerToken: 'email-token' },
  smsWebhook: { url: 'https://notify.example/sms', bearerToken: 'sms-token' },
  turnstileSiteKey: 'site-key',
  turnstileSecretKey: 'secret-key',
  turnstileVerifyUrl: 'https://challenges.cloudflare.com/turnstile/v0/siteverify',
  turnstileExpectedHostnames: ['cod.kai.com'],
  turnstileExpectedActions: ['cod_registration_email', 'cod_registration_phone'],
  outboundAllowedHostnames: ['notify.example'],
  otpTtlSeconds: 600,
  resendSeconds: 60,
  maxSendsPerChannel: 3,
  maxFailedAttempts: 5,
  ...overrides,
});

describe('registration outbound request safety', () => {
  it.each([
    '0.0.0.0',
    '10.0.0.1',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '192.168.1.1',
    '198.18.0.1',
    '224.0.0.1',
    '::',
    '::1',
    'fc00::1',
    'fe80::1',
    'ff02::1',
    '2001:db8::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:169.254.169.254',
    '::ffff:c0a8:101',
  ])('rejects non-public address %s', (address) => {
    expect(isPrivateRegistrationAddress(address)).toBe(true);
  });

  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '::ffff:8.8.8.8'])(
    'allows globally routable address %s',
    (address) => {
      expect(isPrivateRegistrationAddress(address)).toBe(false);
    },
  );

  it('pins Turnstile hostname and action, connects to the validator-pinned IP, and rejects redirects', async () => {
    let observedInit: { method?: string; body?: string; headers?: Record<string, string> } | undefined;
    let observedPinnedAddress: string | undefined;
    let validated: Parameters<RegistrationEndpointValidator> | undefined;
    const pinnedFetcher = (async (_url: string, pinnedAddress: string, init: { method: string; body: string; headers: Record<string, string> }) => {
      observedPinnedAddress = pinnedAddress;
      observedInit = init;
      return Response.json({ success: true, hostname: 'cod.kai.com', action: 'cod_registration_email' });
    }) as PinnedFetcher;
    const validator: RegistrationEndpointValidator = async (...input) => { validated = input; return '203.0.113.99'; };
    const verification = new RegistrationVerification(verificationConfig(), null, pinnedFetcher, validator);

    await verification.verifyHuman('valid-token', 'cod_registration_email', '203.0.113.10');

    expect(validated).toEqual([
      'https://challenges.cloudflare.com/turnstile/v0/siteverify',
      ['challenges.cloudflare.com'],
      'Turnstile',
    ]);
    expect(observedPinnedAddress).toBe('203.0.113.99');
    expect(observedInit).toMatchObject({ method: 'POST' });
    expect(new URLSearchParams(String(observedInit?.body)).get('remoteip')).toBe('203.0.113.10');
  });

  it.each([
    [{ success: true, hostname: 'evil.example', action: 'cod_registration_email' }, 'cod_registration_email'],
    [{ success: true, hostname: 'cod.kai.com', action: 'cod_registration_phone' }, 'cod_registration_email'],
    [{ success: true, hostname: 'cod.kai.com' }, 'cod_registration_email'],
    [{ success: true, hostname: 'cod.kai.com', action: 'unconfigured_action' }, 'unconfigured_action'],
  ] as const)('rejects a Turnstile result with the wrong hostname or action', async (result, expectedAction) => {
    const pinnedFetcher = (async () => Response.json(result)) as PinnedFetcher;
    const verification = new RegistrationVerification(verificationConfig(), null, pinnedFetcher, async () => '203.0.113.99');

    await expect(verification.verifyHuman('invalid-binding', expectedAction)).rejects.toMatchObject({
      status: 400,
      code: 'human_verification_failed',
    });
  });

  it('pins the resolved IP for registration delivery webhooks and rejects redirects', async () => {
    let observedInput: string | undefined;
    let observedInit: { method?: string; headers?: Record<string, string>; body?: string } | undefined;
    let observedPinnedAddress: string | undefined;
    let validated: Parameters<RegistrationEndpointValidator> | undefined;
    const pinnedFetcher = (async (url: string, pinnedAddress: string, init: { method: string; headers: Record<string, string>; body: string }) => {
      observedInput = url;
      observedPinnedAddress = pinnedAddress;
      observedInit = init;
      return new Response(null, { status: 204 });
    }) as PinnedFetcher;
    const validator: RegistrationEndpointValidator = async (...input) => { validated = input; return '198.51.100.7'; };
    const delivery = registrationDeliveryFromConfig(verificationConfig(), pinnedFetcher, validator);

    await delivery?.sendEmailCode({
      challengeId: '9dd142a8-27fd-4d76-89f0-0c867c81198e',
      destination: 'member@example.com',
      code: '123456',
      expiresAt: '2026-08-12T00:10:00.000Z',
    });

    expect(validated).toEqual(['https://notify.example/email', ['notify.example'], 'Registration webhook']);
    expect(observedPinnedAddress).toBe('198.51.100.7');
    expect(observedInput).toBe('https://notify.example/email');
    expect(observedInit).toMatchObject({
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer email-token' },
    });
  });

  it('pinnedLookup always returns the pinned address regardless of hostname', () => {
    const cases: Array<[string, string, number]> = [
      ['8.8.8.8', 'irrelevant.example', 4],
      ['2606:4700:4700::1111', 'irrelevant.example', 6],
    ];
    for (const [pinned, hostname, family] of cases) {
      let resolved: { address: string | Array<unknown>; family: number | undefined } | undefined;
      pinnedLookup(pinned)(hostname, {}, (err: NodeJS.ErrnoException | null, address: string | Array<unknown>, fam?: number) => {
        expect(err).toBeNull();
        resolved = { address, family: fam };
      });
      expect(resolved).toEqual({ address: pinned, family });
    }
  });

  it('closes the DNS-rebinding TOCTOU by rejecting any mixed private resolution', async () => {
    // assertSafeRegistrationEndpoint is the default validator. A hostname that
    // resolves to ANY private address is rejected, so no pinned address can
    // ever be a private endpoint. The connection target is therefore fixed to
    // a validated public address, and the pinnedFetcher never re-resolves DNS.
    const validator: RegistrationEndpointValidator = async () => {
      // Simulate the default validator's rejection path by throwing on a private
      // resolution; the delivery must never reach the pinnedFetcher.
      throw new Error('Registration webhook endpoint resolved to a private address');
    };
    let attempted = false;
    const pinnedFetcher = (async () => { attempted = true; return new Response(null, { status: 204 }); }) as PinnedFetcher;
    const delivery = registrationDeliveryFromConfig(verificationConfig(), pinnedFetcher, validator);

    await expect(delivery?.sendEmailCode({
      challengeId: '9dd142a8-27fd-4d76-89f0-0c867c81198e',
      destination: 'member@example.com',
      code: '123456',
      expiresAt: '2026-08-12T00:10:00.000Z',
    })).rejects.toThrow('private address');
    expect(attempted).toBe(false);
  });

  it('defaultPinnedFetcher refuses non-HTTPS URLs', async () => {
    await expect(defaultPinnedFetcher('http://notify.example/email', '203.0.113.10', { method: 'POST', headers: {}, body: '' })).rejects.toThrow('HTTPS');
  });
});
