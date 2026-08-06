import { createDecipheriv, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { CodDatabase, Principal } from './database.js';

export type BotPlatform = 'feishu' | 'wecom';

export interface BotCommand {
  action: 'help' | 'status' | 'run';
  text: string;
}

export interface FeishuWebhookConfig {
  verificationToken: string;
  encryptKey: string | null;
  bindings: Record<string, string>;
}

export interface FeishuWebhookEvent {
  kind: 'challenge' | 'message';
  challenge?: string;
  eventId?: string;
  messageId?: string;
  text?: string;
  email?: string;
  tenantKey?: string;
  openId?: string;
}

export function verifyWebhookSignature(rawBody: string, timestamp: string, signature: string, secret: string): boolean {
  const numericTimestamp = Number(timestamp);
  if (!Number.isFinite(numericTimestamp) || Math.abs(Date.now() - numericTimestamp * 1000) > 5 * 60 * 1000) return false;
  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest();
  const actual = Buffer.from(signature, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function verifyFeishuSignature(rawBody: string, timestamp: string, nonce: string, signature: string, encryptKey: string): boolean {
  const numericTimestamp = Number(timestamp);
  if (!Number.isFinite(numericTimestamp) || Math.abs(Date.now() - numericTimestamp * 1000) > 5 * 60 * 1000) return false;
  const expected = createHash('sha256').update(`${timestamp}${nonce}${encryptKey}${rawBody}`).digest();
  const actual = Buffer.from(signature, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function decryptFeishuPayload(encrypted: string, encryptKey: string): string {
  const payload = Buffer.from(encrypted, 'base64');
  if (payload.length < 32 || (payload.length - 16) % 16 !== 0) throw new Error('Invalid encrypted Feishu payload');
  const key = createHash('sha256').update(encryptKey).digest();
  const decipher = createDecipheriv('aes-256-cbc', key, payload.subarray(0, 16));
  return Buffer.concat([decipher.update(payload.subarray(16)), decipher.final()]).toString('utf8');
}

export function parseFeishuWebhook(rawBody: string, headers: { timestamp?: string; nonce?: string; signature?: string }, config: FeishuWebhookConfig): FeishuWebhookEvent {
  let envelope: Record<string, unknown>;
  try { envelope = JSON.parse(rawBody || '{}') as Record<string, unknown>; }
  catch { throw new Error('Invalid Feishu JSON'); }
  if (typeof envelope.challenge === 'string') {
    if (envelope.token !== config.verificationToken) throw new Error('Invalid Feishu verification token');
    return { kind: 'challenge', challenge: envelope.challenge };
  }
  if (config.encryptKey) {
    if (!verifyFeishuSignature(rawBody, headers.timestamp ?? '', headers.nonce ?? '', headers.signature ?? '', config.encryptKey)) throw new Error('Invalid Feishu signature');
    if (typeof envelope.encrypt === 'string') {
      try { envelope = JSON.parse(decryptFeishuPayload(envelope.encrypt, config.encryptKey)) as Record<string, unknown>; }
      catch { throw new Error('Invalid encrypted Feishu event'); }
    }
  }
  if (typeof envelope.challenge === 'string') {
    if (envelope.token !== config.verificationToken) throw new Error('Invalid Feishu verification token');
    return { kind: 'challenge', challenge: envelope.challenge };
  }
  const header = envelope.header as Record<string, unknown> | undefined;
  if (!header || header.token !== config.verificationToken || header.event_type !== 'im.message.receive_v1') throw new Error('Unsupported Feishu event');
  const event = envelope.event as Record<string, unknown> | undefined;
  const sender = event?.sender as Record<string, unknown> | undefined;
  const senderId = sender?.sender_id as Record<string, unknown> | undefined;
  const message = event?.message as Record<string, unknown> | undefined;
  const tenantKey = String(header.tenant_key ?? sender?.tenant_key ?? '');
  const openId = String(senderId?.open_id ?? '');
  const messageId = String(message?.message_id ?? '');
  if (!tenantKey || !openId || !messageId || message?.message_type !== 'text') throw new Error('Unsupported Feishu message');
  let content: Record<string, unknown>;
  try { content = JSON.parse(String(message.content ?? '{}')) as Record<string, unknown>; }
  catch { throw new Error('Invalid Feishu message content'); }
  const email = config.bindings[`${tenantKey}:${openId}`];
  if (!email) throw new Error('Feishu identity is not bound to COD');
  return { kind: 'message', eventId: String(header.event_id ?? ''), messageId, text: String(content.text ?? ''), email, tenantKey, openId };
}

export async function replyFeishuMessage(messageId: string, text: string, appId: string, appSecret: string, fetcher: typeof fetch = fetch): Promise<void> {
  const tokenResponse = await fetcher('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ app_id: appId, app_secret: appSecret }), signal: AbortSignal.timeout(2_000),
  });
  const tokenBody = await tokenResponse.json() as { code?: number; tenant_access_token?: string };
  if (!tokenResponse.ok || tokenBody.code !== 0 || !tokenBody.tenant_access_token) throw new Error('Unable to acquire Feishu access token');
  const reply = await fetcher(`https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenBody.tenant_access_token}` }, body: JSON.stringify({ msg_type: 'text', content: JSON.stringify({ text: text.slice(0, 4_000) }) }), signal: AbortSignal.timeout(2_000),
  });
  if (!reply.ok) throw new Error(`Feishu reply failed: ${reply.status}`);
}

export function parseBotCommand(text: string): BotCommand {
  const normalized = text.trim();
  if (normalized === '/help') return { action: 'help', text: '' };
  if (normalized === '/status') return { action: 'status', text: '' };
  if (normalized.startsWith('/run ')) return { action: 'run', text: normalized.slice(5).trim() };
  return { action: 'help', text: '' };
}

export class BotService {
  constructor(private readonly database: CodDatabase, private readonly principal: Principal) {}

  async execute(platform: BotPlatform, command: BotCommand): Promise<{ text: string }> {
    if (command.action === 'help') return { text: 'COD 命令：/status 查看设备，/run <任务> 发送任务。' };
    if (command.action === 'status') {
      const devices = await this.database.listDevices(this.principal);
      const tasks = (await this.database.listTasks(this.principal)).slice(0, 3);
      const deviceStatus = devices.length ? devices.map((device) => `${device.name}: ${device.status}`).join('\n') : '暂未绑定设备。';
      const taskStatus = tasks.length ? `\n最近任务：\n${tasks.map((task) => `${task.title}: ${task.status}${task.result ? ` · ${task.result.slice(0, 120)}` : task.error ? ` · ${task.error.slice(0, 120)}` : ''}`).join('\n')}` : '';
      return { text: `${deviceStatus}${taskStatus}` };
    }
    const device = (await this.database.listDevices(this.principal))[0];
    if (!device) return { text: '请先在 COD Web 或桌面端绑定设备。' };
    const task = await this.database.createTask(this.principal, { title: command.text, deviceId: device.id });
    await this.database.audit(this.principal, 'bot.task.create', 'task', task.id, { platform });
    return { text: `${platform === 'feishu' ? '飞书' : '企业微信'}任务已创建：${task.title}` };
  }
}
