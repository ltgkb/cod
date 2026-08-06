import { describe, expect, it } from 'vitest';
import { BotService, parseBotCommand, verifyWebhookSignature } from './bots.js';
import { createHmac } from 'node:crypto';
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
});
