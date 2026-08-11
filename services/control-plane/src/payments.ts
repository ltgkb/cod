import { createDecipheriv, createSign, createVerify, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { IncomingHttpHeaders } from 'node:http';
import type { AlipayConfig, ControlPlaneConfig, WechatPayConfig } from './config.js';
import type { PaymentCompletion, PaymentOrder } from './database.js';
import { HttpError } from './errors.js';

export interface PaymentCheckout {
  kind: 'qr' | 'redirect';
  url: string;
  expiresAt: string;
}

interface WechatNotification {
  id?: string;
  event_type?: string;
  resource?: { algorithm?: string; ciphertext?: string; nonce?: string; associated_data?: string };
}

interface WechatTransaction {
  appid?: string;
  mchid?: string;
  out_trade_no?: string;
  transaction_id?: string;
  trade_state?: string;
  amount?: { total?: number; currency?: string };
}

const paymentDescription = 'COD 钱包充值';
const merchantRequestTimeoutMs = 15_000;
const timestampSeconds = () => Math.floor(Date.now() / 1000);
const pem = (path: string) => readFileSync(path, 'utf8');

function rsaSign(content: string, privateKeyPath: string): string {
  const signer = createSign('RSA-SHA256');
  signer.update(content, 'utf8');
  signer.end();
  return signer.sign(pem(privateKeyPath), 'base64');
}

function rsaVerify(content: string, signature: string, publicKeyPath: string): boolean {
  try {
    const verifier = createVerify('RSA-SHA256');
    verifier.update(content, 'utf8');
    verifier.end();
    return verifier.verify(pem(publicKeyPath), signature, 'base64');
  } catch {
    return false;
  }
}

function centsFromDecimal(value: string): number | null {
  if (!/^\d{1,7}(?:\.\d{1,2})?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(cents) ? cents : null;
}

export class OfficialPaymentService {
  constructor(private readonly config: ControlPlaneConfig, private readonly fetcher: typeof fetch = fetch) {}

  availableChannels(): Array<PaymentOrder['channel']> {
    return [this.config.wechatPay ? 'wechat' as const : null, this.config.alipay ? 'alipay' as const : null].filter((value): value is PaymentOrder['channel'] => value !== null);
  }

  async createCheckout(order: PaymentOrder): Promise<PaymentCheckout> {
    if (order.channel === 'wechat' && this.config.wechatPay) return this.createWechatCheckout(order, this.config.wechatPay);
    if (order.channel === 'alipay' && this.config.alipay) return this.createAlipayCheckout(order, this.config.alipay);
    throw new HttpError('所选支付渠道尚未配置', 503, 'payment_channel_unavailable');
  }

  private async createWechatCheckout(order: PaymentOrder, config: WechatPayConfig): Promise<PaymentCheckout> {
    const path = '/v3/pay/transactions/native';
    const body = JSON.stringify({
      appid: config.appId,
      mchid: config.mchId,
      description: paymentDescription,
      out_trade_no: order.id,
      notify_url: `${this.config.paymentPublicBaseUrl}/api/webhooks/payments/wechat`,
      time_expire: new Date(Date.now() + 15 * 60_000).toISOString().replace(/\.\d{3}Z$/, '+00:00'),
      amount: { total: order.amountCents, currency: 'CNY' },
    });
    const timestamp = String(timestampSeconds());
    const nonce = randomBytes(16).toString('hex');
    const signature = rsaSign(`POST\n${path}\n${timestamp}\n${nonce}\n${body}\n`, config.merchantPrivateKeyPath);
    const authorization = `WECHATPAY2-SHA256-RSA2048 mchid="${config.mchId}",nonce_str="${nonce}",timestamp="${timestamp}",serial_no="${config.merchantSerialNo}",signature="${signature}"`;
    let response: Response;
    try {
      response = await this.fetcher(`https://api.mch.weixin.qq.com${path}`, { method: 'POST', headers: { authorization, accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'COD/1.0' }, body, signal: AbortSignal.timeout(merchantRequestTimeoutMs) });
    } catch {
      throw new HttpError('微信支付下单超时，请稍后重试', 502, 'wechat_payment_timeout');
    }
    const rawResponse = await response.text();
    const responseTimestamp = response.headers.get('wechatpay-timestamp') ?? '';
    const responseNonce = response.headers.get('wechatpay-nonce') ?? '';
    const responseSignature = response.headers.get('wechatpay-signature') ?? '';
    const responseSerial = response.headers.get('wechatpay-serial') ?? '';
    if (!responseTimestamp || !responseNonce || !responseSignature || responseSerial !== config.platformSerialNo || !rsaVerify(`${responseTimestamp}\n${responseNonce}\n${rawResponse}\n`, responseSignature, config.platformPublicKeyPath)) throw new HttpError('微信支付响应签名无效', 502, 'invalid_wechat_response');
    let result: { code_url?: string; code?: string; message?: string };
    try { result = JSON.parse(rawResponse) as typeof result; } catch { result = {}; }
    if (!response.ok || !result.code_url) throw new HttpError(result.message ?? '微信支付下单失败', 502, 'wechat_payment_failed');
    return { kind: 'qr', url: result.code_url, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() };
  }

  private createAlipayCheckout(order: PaymentOrder, config: AlipayConfig): PaymentCheckout {
    const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
    const params: Record<string, string> = {
      app_id: config.appId,
      method: 'alipay.trade.page.pay',
      format: 'JSON',
      charset: 'utf-8',
      sign_type: 'RSA2',
      timestamp: new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }),
      version: '1.0',
      notify_url: `${this.config.paymentPublicBaseUrl}/api/webhooks/payments/alipay`,
      return_url: `${this.config.paymentPublicBaseUrl}/?payment_order=${encodeURIComponent(order.id)}`,
      biz_content: JSON.stringify({ out_trade_no: order.id, total_amount: (order.amountCents / 100).toFixed(2), subject: paymentDescription, product_code: 'FAST_INSTANT_TRADE_PAY', timeout_express: '15m' }),
    };
    const content = Object.keys(params).sort().map((key) => `${key}=${params[key]}`).join('&');
    const query = new URLSearchParams({ ...params, sign: rsaSign(content, config.merchantPrivateKeyPath) });
    return { kind: 'redirect', url: `${config.gatewayUrl}?${query.toString()}`, expiresAt };
  }

  verifyWechatNotification(rawBody: string, headers: IncomingHttpHeaders): PaymentCompletion | null {
    const config = this.config.wechatPay;
    if (!config) throw new HttpError('微信支付未配置', 503, 'wechat_payment_unavailable');
    const timestamp = String(headers['wechatpay-timestamp'] ?? '');
    const nonce = String(headers['wechatpay-nonce'] ?? '');
    const signature = String(headers['wechatpay-signature'] ?? '');
    const serial = String(headers['wechatpay-serial'] ?? '');
    if (!/^\d{10}$/.test(timestamp) || Math.abs(timestampSeconds() - Number(timestamp)) > 300 || !nonce || !signature || serial !== config.platformSerialNo) throw new HttpError('微信支付回调签名无效', 401, 'invalid_wechat_signature');
    if (!rsaVerify(`${timestamp}\n${nonce}\n${rawBody}\n`, signature, config.platformPublicKeyPath)) throw new HttpError('微信支付回调签名无效', 401, 'invalid_wechat_signature');
    let notification: WechatNotification;
    try { notification = JSON.parse(rawBody) as WechatNotification; }
    catch { throw new HttpError('微信支付回调格式无效', 400, 'invalid_wechat_notification'); }
    const resource = notification.resource;
    if (resource?.algorithm !== 'AEAD_AES_256_GCM' || !resource.ciphertext || !resource.nonce) throw new HttpError('微信支付回调资源无效', 400, 'invalid_wechat_resource');
    let transaction: WechatTransaction;
    try {
      const encrypted = Buffer.from(resource.ciphertext, 'base64');
      const ciphertext = encrypted.subarray(0, -16);
      const tag = encrypted.subarray(-16);
      const decipher = createDecipheriv('aes-256-gcm', Buffer.from(config.apiV3Key, 'utf8'), Buffer.from(resource.nonce, 'utf8'));
      decipher.setAuthTag(tag);
      decipher.setAAD(Buffer.from(resource.associated_data ?? '', 'utf8'));
      transaction = JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')) as WechatTransaction;
    } catch { throw new HttpError('微信支付回调解密失败', 400, 'invalid_wechat_resource'); }
    if (notification.event_type !== 'TRANSACTION.SUCCESS' || transaction.trade_state !== 'SUCCESS') return null;
    if (!notification.id || !transaction.out_trade_no || !transaction.transaction_id || transaction.appid !== config.appId || transaction.mchid !== config.mchId || transaction.amount?.currency !== 'CNY' || !Number.isInteger(transaction.amount.total)) throw new HttpError('微信支付回调内容无效', 400, 'invalid_wechat_payment');
    return { orderId: transaction.out_trade_no, amountCents: Number(transaction.amount.total), currency: 'CNY', channel: 'wechat', providerPaymentId: transaction.transaction_id, providerEventId: notification.id };
  }

  verifyAlipayNotification(rawBody: string): PaymentCompletion | null {
    const config = this.config.alipay;
    if (!config) throw new HttpError('支付宝未配置', 503, 'alipay_unavailable');
    const params = new URLSearchParams(rawBody);
    const signature = params.get('sign') ?? '';
    const content = [...params.entries()].filter(([key]) => key !== 'sign' && key !== 'sign_type').sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => `${key}=${value}`).join('&');
    if (params.get('sign_type') !== 'RSA2' || !signature || !rsaVerify(content, signature, config.alipayPublicKeyPath)) throw new HttpError('支付宝回调签名无效', 401, 'invalid_alipay_signature');
    const status = params.get('trade_status');
    if (status !== 'TRADE_SUCCESS' && status !== 'TRADE_FINISHED') return null;
    const orderId = params.get('out_trade_no');
    const tradeNo = params.get('trade_no');
    const amountCents = centsFromDecimal(params.get('total_amount') ?? '');
    if (!orderId || !tradeNo || amountCents === null || params.get('app_id') !== config.appId || params.get('seller_id') !== config.sellerId) throw new HttpError('支付宝回调内容无效', 400, 'invalid_alipay_payment');
    return { orderId, amountCents, currency: 'CNY', channel: 'alipay', providerPaymentId: tradeNo, providerEventId: params.get('notify_id') ?? `${tradeNo}:${status}` };
  }
}
