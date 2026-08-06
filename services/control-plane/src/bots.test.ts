import { describe, expect, it } from 'vitest';
import { BotService, parseBotCommand, verifyWebhookSignature } from './bots.js';
import { SyncStore } from './sync.js';
import { createHmac } from 'node:crypto';

describe('Bot integration', () => {
  it('verifies signed webhook bodies', () => {
    const signature = createHmac('sha256', 'secret').update('123.{}').digest('hex');
    expect(verifyWebhookSignature('{}', '123', signature, 'secret')).toBe(true);
  });

  it('creates a remote task from an allowlisted command', () => {
    const sync = new SyncStore();
    sync.registerDevice({ name: 'COD Desktop', platform: 'linux' });
    const response = new BotService(sync).execute('feishu', parseBotCommand('/run 检查构建失败'));
    expect(response.text).toContain('任务已创建');
    expect(sync.listTasks()).toHaveLength(1);
  });
});
