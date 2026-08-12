import { createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import type { RegistrationVerificationConfig, RegistrationWebhookConfig } from './config.js';
import { HttpError } from './errors.js';

export type RegistrationChannel = 'email' | 'phone';

export interface RegistrationDeliveryMessage {
  challengeId: string;
  destination: string;
  code: string;
  expiresAt: string;
}

export interface RegistrationDelivery {
  sendEmailCode(message: RegistrationDeliveryMessage): Promise<void>;
  sendSmsCode(message: RegistrationDeliveryMessage): Promise<void>;
}

export const REGISTRATION_OTP_DIGITS = 6;

function decodeHmacKey(value: string): Buffer {
  if(value.startsWith('base64url:'))return Buffer.from(value.slice('base64url:'.length),'base64url');
  return value.startsWith('base64:') ? Buffer.from(value.slice('base64:'.length), 'base64') : Buffer.from(value, 'utf8');
}

function safeEqualHex(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false;
  const leftBuffer = Buffer.from(left, 'hex');
  const rightBuffer = Buffer.from(right, 'hex');
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function normalizeRegistrationEmail(raw: unknown): string {
  if (typeof raw !== 'string') throw new HttpError('请输入有效邮箱', 400, 'invalid_email');
  const email = raw.trim().toLowerCase();
  if (email.length > 254 || !/^\S+@\S+\.\S+$/.test(email)) throw new HttpError('请输入有效邮箱', 400, 'invalid_email');
  return email;
}

export function normalizeRegistrationPhone(raw: unknown): string {
  if (typeof raw !== 'string' || !/^\+[1-9][0-9]{7,14}$/.test(raw)) {
    throw new HttpError('请输入带国家区号的手机号', 400, 'invalid_phone');
  }
  return raw;
}

export function validateRegistrationChallengeId(raw: unknown): string {
  if (typeof raw !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(raw)) {
    throw new HttpError('注册验证已失效，请重新开始', 400, 'invalid_registration_challenge');
  }
  return raw.toLowerCase();
}

export function validateRegistrationCode(raw: unknown): string {
  if (typeof raw !== 'string' || !/^[0-9]{6}$/.test(raw)) {
    throw new HttpError('验证码不正确', 400, 'invalid_verification_code');
  }
  return raw;
}

export function maskRegistrationDestination(channel: RegistrationChannel, value: string): string {
  if (channel === 'phone') return `${value.slice(0, Math.min(3, value.length - 4))}${'*'.repeat(Math.max(3, value.length - 7))}${value.slice(-4)}`;
  const [local = '', domain = ''] = value.split('@');
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}${'*'.repeat(Math.max(3, local.length - visible.length))}@${domain}`;
}

export class RegistrationVerification {
  readonly available: boolean;
  private readonly key: Buffer | null;

  constructor(
    readonly config: RegistrationVerificationConfig,
    private readonly delivery: RegistrationDelivery | null,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.key = config.hmacKey ? decodeHmacKey(config.hmacKey) : null;
    this.available = Boolean(this.key?.length === 32 && delivery && config.turnstileSiteKey && config.turnstileSecretKey);
  }

  createCode(challengeId: string, channel: RegistrationChannel, destination: string): { code: string; hash: string } {
    if (!this.key) throw new HttpError('账号注册暂不可用', 503, 'registration_unavailable');
    const code = randomInt(0, 1_000_000).toString().padStart(REGISTRATION_OTP_DIGITS, '0');
    return { code, hash: this.hashCode(challengeId, channel, destination, code) };
  }

  hashCode(challengeId: string, channel: RegistrationChannel, destination: string, code: string): string {
    if (!this.key) throw new HttpError('账号注册暂不可用', 503, 'registration_unavailable');
    return createHmac('sha256', this.key)
      .update(`cod-registration-otp-v1\0${challengeId}\0${channel}\0${destination}\0${code}`)
      .digest('hex');
  }

  matchesCode(expectedHash: string, challengeId: string, channel: RegistrationChannel, destination: string, code: string): boolean {
    return safeEqualHex(expectedHash, this.hashCode(challengeId, channel, destination, code));
  }

  rateLimitKey(scope: string, value: string): string {
    if (!this.key) throw new HttpError('账号注册暂不可用', 503, 'registration_unavailable');
    return createHmac('sha256', this.key).update(`cod-registration-rate-v1\0${scope}\0${value}`).digest('hex');
  }

  requestFingerprint(input: { challengeId: string; email: string; phone: string; password: string; inviteCode: string | null }): string {
    if (!this.key) throw new HttpError('账号注册暂不可用', 503, 'registration_unavailable');
    return createHmac('sha256', this.key)
      .update('cod-registration-request-v1\0')
      .update(JSON.stringify(input))
      .digest('hex');
  }

  async verifyHuman(token: unknown, remoteIp?: string): Promise<void> {
    if (!this.config.turnstileSecretKey) throw new HttpError('人机验证服务暂不可用', 503, 'human_verification_unavailable');
    if (typeof token !== 'string' || !token || token.length > 2048) {
      throw new HttpError('请完成人机验证', 400, 'human_verification_required');
    }
    const form = new URLSearchParams({
      secret: this.config.turnstileSecretKey,
      response: token,
      idempotency_key: randomUUID(),
    });
    if (remoteIp) form.set('remoteip', remoteIp);
    try {
      const response = await this.fetcher(this.config.turnstileVerifyUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
        signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok) throw new Error('verification provider unavailable');
      const result = await response.json() as { success?: unknown };
      if (result.success !== true) throw new HttpError('人机验证失败，请重试', 400, 'human_verification_failed');
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError('人机验证服务暂不可用', 503, 'human_verification_unavailable');
    }
  }

  async deliver(channel: RegistrationChannel, message: RegistrationDeliveryMessage): Promise<void> {
    if (!this.delivery) throw new HttpError('验证码发送服务暂不可用', 503, 'registration_delivery_unavailable');
    try {
      if (channel === 'email') await this.delivery.sendEmailCode(message);
      else await this.delivery.sendSmsCode(message);
    } catch {
      throw new HttpError('验证码发送失败，请稍后重试', 503, 'registration_delivery_failed');
    }
  }
}

class WebhookRegistrationDelivery implements RegistrationDelivery {
  constructor(
    private readonly email: RegistrationWebhookConfig,
    private readonly sms: RegistrationWebhookConfig,
    private readonly fetcher: typeof fetch,
  ) {}

  sendEmailCode(message: RegistrationDeliveryMessage): Promise<void> { return this.send(this.email, 'email', message); }
  sendSmsCode(message: RegistrationDeliveryMessage): Promise<void> { return this.send(this.sms, 'sms', message); }

  private async send(config: RegistrationWebhookConfig, channel: 'email' | 'sms', message: RegistrationDeliveryMessage): Promise<void> {
    const response = await this.fetcher(config.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.bearerToken}` },
      body: JSON.stringify({ type: 'cod.registration.otp', channel, ...message }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new Error('registration delivery rejected');
  }
}

export function registrationDeliveryFromConfig(config: RegistrationVerificationConfig, fetcher: typeof fetch = fetch): RegistrationDelivery | null {
  return config.emailWebhook && config.smsWebhook ? new WebhookRegistrationDelivery(config.emailWebhook, config.smsWebhook, fetcher) : null;
}
