import { describe, expect, it } from 'vitest';
import type { RegistrationVerificationConfig } from './config.js';
import {
  isPrivateRegistrationAddress,
  RegistrationVerification,
  registrationDeliveryFromConfig,
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

  it('pins Turnstile hostname and action and refuses automatic redirects', async () => {
    let observedInit: RequestInit | undefined;
    let validated: Parameters<RegistrationEndpointValidator> | undefined;
    const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      observedInit = init;
      return Response.json({ success: true, hostname: 'cod.kai.com', action: 'cod_registration_email' });
    }) as typeof fetch;
    const validator: RegistrationEndpointValidator = async (...input) => { validated = input; };
    const verification = new RegistrationVerification(verificationConfig(), null, fetcher, validator);

    await verification.verifyHuman('valid-token', 'cod_registration_email', '203.0.113.10');

    expect(validated).toEqual([
      'https://challenges.cloudflare.com/turnstile/v0/siteverify',
      ['challenges.cloudflare.com'],
      'Turnstile',
    ]);
    expect(observedInit).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(new URLSearchParams(String(observedInit?.body)).get('remoteip')).toBe('203.0.113.10');
  });

  it.each([
    [{ success: true, hostname: 'evil.example', action: 'cod_registration_email' }, 'cod_registration_email'],
    [{ success: true, hostname: 'cod.kai.com', action: 'cod_registration_phone' }, 'cod_registration_email'],
    [{ success: true, hostname: 'cod.kai.com' }, 'cod_registration_email'],
    [{ success: true, hostname: 'cod.kai.com', action: 'unconfigured_action' }, 'unconfigured_action'],
  ] as const)('rejects a Turnstile result with the wrong hostname or action', async (result, expectedAction) => {
    const fetcher = (async () => Response.json(result)) as typeof fetch;
    const verification = new RegistrationVerification(verificationConfig(), null, fetcher, async () => undefined);

    await expect(verification.verifyHuman('invalid-binding', expectedAction)).rejects.toMatchObject({
      status: 400,
      code: 'human_verification_failed',
    });
  });

  it('refuses automatic redirects for registration delivery webhooks', async () => {
    let observedInput: RequestInfo | URL | undefined;
    let observedInit: RequestInit | undefined;
    let validated: Parameters<RegistrationEndpointValidator> | undefined;
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      observedInput = input;
      observedInit = init;
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const validator: RegistrationEndpointValidator = async (...input) => { validated = input; };
    const delivery = registrationDeliveryFromConfig(verificationConfig(), fetcher, validator);

    await delivery?.sendEmailCode({
      challengeId: '9dd142a8-27fd-4d76-89f0-0c867c81198e',
      destination: 'member@example.com',
      code: '123456',
      expiresAt: '2026-08-12T00:10:00.000Z',
    });

    expect(validated).toEqual(['https://notify.example/email', ['notify.example'], 'Registration webhook']);
    expect(observedInput).toBe('https://notify.example/email');
    expect(observedInit).toMatchObject({
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/json', authorization: 'Bearer email-token' },
    });
  });
});
