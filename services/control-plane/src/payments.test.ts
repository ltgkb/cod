import { createCipheriv, createSign, createVerify, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from './config.js';
import type { PaymentOrder } from './database.js';
import { OfficialPaymentService } from './payments.js';

const directories: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });

function keys() {
  const directory = mkdtempSync(join(tmpdir(), 'cod-payments-')); directories.push(directory);
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  const privatePath = join(directory, 'private.pem'); const publicPath = join(directory, 'public.pem');
  writeFileSync(privatePath, pair.privateKey, { mode: 0o600 }); writeFileSync(publicPath, pair.publicKey, { mode: 0o600 });
  return { ...pair, privatePath, publicPath };
}

const order = (channel: PaymentOrder['channel']): PaymentOrder => ({ id: '550e8400-e29b-41d4-a716-446655440000', amountCents: 1200, currency: 'CNY', channel, status: 'pending', providerPaymentId: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
const sign = (content: string, privateKey: string) => { const signer = createSign('RSA-SHA256'); signer.update(content); signer.end(); return signer.sign(privateKey, 'base64'); };

describe('official merchant payment adapters', () => {
  it('creates a signed WeChat Native order and verifies an encrypted official callback', async () => {
    const merchant = keys(); const platform = keys(); const apiV3Key = '0123456789abcdef0123456789abcdef';
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const authorization = String((init?.headers as Record<string, string>).authorization);
      expect(authorization).toContain('WECHATPAY2-SHA256-RSA2048');
      expect(JSON.parse(String(init?.body))).toMatchObject({ out_trade_no: order('wechat').id, amount: { total: 1200, currency: 'CNY' } });
      const body = JSON.stringify({ code_url: 'weixin://wxpay/bizpayurl?pr=test' }); const timestamp = String(Math.floor(Date.now() / 1000)); const nonce = 'response-nonce';
      return new Response(body, { headers: { 'content-type': 'application/json', 'wechatpay-timestamp': timestamp, 'wechatpay-nonce': nonce, 'wechatpay-signature': sign(`${timestamp}\n${nonce}\n${body}\n`, platform.privateKey), 'wechatpay-serial': 'PLATFORMSERIAL' } });
    });
    const config = loadConfig({ NODE_ENV: 'test', COD_PAYMENT_PUBLIC_BASE_URL: 'https://cod.example', COD_WECHAT_PAY_MCH_ID: '1900000001', COD_WECHAT_PAY_APP_ID: 'wx-app', COD_WECHAT_PAY_SERIAL_NO: 'MERCHANTSERIAL', COD_WECHAT_PAY_PRIVATE_KEY_PATH: merchant.privatePath, COD_WECHAT_PAY_API_V3_KEY: apiV3Key, COD_WECHAT_PAY_PLATFORM_PUBLIC_KEY_PATH: platform.publicPath, COD_WECHAT_PAY_PLATFORM_SERIAL_NO: 'PLATFORMSERIAL' });
    const service = new OfficialPaymentService(config, fetcher as typeof fetch);
    await expect(service.createCheckout(order('wechat'))).resolves.toMatchObject({ kind: 'qr', url: 'weixin://wxpay/bizpayurl?pr=test' });

    const transaction = JSON.stringify({ appid: 'wx-app', mchid: '1900000001', out_trade_no: order('wechat').id, transaction_id: 'wx-transaction-1', trade_state: 'SUCCESS', amount: { total: 1200, currency: 'CNY' } });
    const nonce = '123456789012'; const aad = 'transaction'; const cipher = createCipheriv('aes-256-gcm', Buffer.from(apiV3Key), Buffer.from(nonce)); cipher.setAAD(Buffer.from(aad));
    const ciphertext = Buffer.concat([cipher.update(transaction), cipher.final(), cipher.getAuthTag()]).toString('base64');
    const body = JSON.stringify({ id: 'wx-event-1', event_type: 'TRANSACTION.SUCCESS', resource: { algorithm: 'AEAD_AES_256_GCM', ciphertext, nonce, associated_data: aad } });
    const timestamp = String(Math.floor(Date.now() / 1000)); const callbackNonce = 'callback-nonce';
    const headers = { 'wechatpay-timestamp': timestamp, 'wechatpay-nonce': callbackNonce, 'wechatpay-signature': sign(`${timestamp}\n${callbackNonce}\n${body}\n`, platform.privateKey), 'wechatpay-serial': 'PLATFORMSERIAL' };
    expect(service.verifyWechatNotification(body, headers)).toEqual({ orderId: order('wechat').id, amountCents: 1200, currency: 'CNY', channel: 'wechat', providerPaymentId: 'wx-transaction-1', providerEventId: 'wx-event-1' });
  });

  it('creates a signed Alipay page-pay URL and accepts only a verified matching callback', async () => {
    const merchant = keys(); const alipay = keys();
    const config = loadConfig({ NODE_ENV: 'test', COD_PAYMENT_PUBLIC_BASE_URL: 'https://cod.example', COD_ALIPAY_APP_ID: '2026000000000001', COD_ALIPAY_SELLER_ID: '2088000000000001', COD_ALIPAY_PRIVATE_KEY_PATH: merchant.privatePath, COD_ALIPAY_PUBLIC_KEY_PATH: alipay.publicPath });
    const service = new OfficialPaymentService(config);
    const checkout = await service.createCheckout(order('alipay'));
    expect(checkout).toMatchObject({ kind: 'redirect' });
    const url = new URL(checkout.url); const requestSignature = url.searchParams.get('sign') ?? '';
    const requestContent = [...url.searchParams.entries()].filter(([key]) => key !== 'sign').sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => `${key}=${value}`).join('&');
    const verifier = createVerify('RSA-SHA256'); verifier.update(requestContent); verifier.end(); expect(verifier.verify(merchant.publicKey, requestSignature, 'base64')).toBe(true);

    const params = new URLSearchParams({ app_id: '2026000000000001', seller_id: '2088000000000001', out_trade_no: order('alipay').id, trade_no: 'ali-trade-1', trade_status: 'TRADE_SUCCESS', total_amount: '12.00', notify_id: 'ali-event-1', sign_type: 'RSA2' });
    const content = [...params.entries()].filter(([key]) => key !== 'sign' && key !== 'sign_type').sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => `${key}=${value}`).join('&');
    params.set('sign', sign(content, alipay.privateKey));
    expect(service.verifyAlipayNotification(params.toString())).toEqual({ orderId: order('alipay').id, amountCents: 1200, currency: 'CNY', channel: 'alipay', providerPaymentId: 'ali-trade-1', providerEventId: 'ali-event-1' });
    params.set('total_amount', '12.01');
    expect(() => service.verifyAlipayNotification(params.toString())).toThrow('支付宝回调签名无效');
  });
});
