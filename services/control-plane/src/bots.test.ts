import { describe, expect, it } from 'vitest';
import { BotService, parseBotCommand, parseFeishuWebhook, verifyWebhookSignature } from './bots.js';
import { createCipheriv, createHash, createHmac } from 'node:crypto';
import { MemoryDatabase } from './memory-database.js';
import type { Principal } from './database.js';

const principal: Principal = { userId: 'user_demo', tenantId: 'tenant_kai_com', email: 'developer@kai.com', role: 'member' };

describe('Bot integration', () => {
  it('verifies signed webhook bodies', () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac('sha256', 'secret').update(`${timestamp}.{}`).digest('hex');
    expect(verifyWebhookSignature('{}', timestamp, signature, 'secret')).toBe(true);
  });

  it('creates a remote task from an allowlisted command', async () => {
    const database = new MemoryDatabase();
    await database.registerDevice(principal, { name: 'COD Desktop', platform: 'linux' });
    const response = await new BotService(database, principal).execute('feishu', parseBotCommand('/run 检查构建失败'));
    expect(response.text).toContain('任务已创建');
    expect(await database.listTasks(principal)).toHaveLength(1);
  });

  it('verifies, decrypts, binds, and parses official Feishu message events', () => {
    const encryptKey = 'feishu-encrypt-key';
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = 'nonce-1';
    const event = JSON.stringify({
      schema: '2.0',
      header: { event_id: 'event-1', event_type: 'im.message.receive_v1', token: 'verify-token', tenant_key: 'tenant-feishu' },
      event: { sender: { sender_id: { open_id: 'open-1' } }, message: { message_id: 'message-1', message_type: 'text', content: JSON.stringify({ text: '/run 修复构建' }) } },
    });
    const iv = Buffer.alloc(16, 7);
    const cipher = createCipheriv('aes-256-cbc', createHash('sha256').update(encryptKey).digest(), iv);
    const encrypt = Buffer.concat([iv, cipher.update(event), cipher.final()]).toString('base64');
    const rawBody = JSON.stringify({ encrypt });
    const signature = createHash('sha256').update(`${timestamp}${nonce}${encryptKey}${rawBody}`).digest('hex');
    expect(parseFeishuWebhook(rawBody, { timestamp, nonce, signature }, { verificationToken: 'verify-token', encryptKey, bindings: { 'tenant-feishu:open-1': 'developer@kai.com' } })).toMatchObject({
      kind: 'message', eventId: 'event-1', messageId: 'message-1', text: '/run 修复构建', email: 'developer@kai.com',
    });
  });
});
