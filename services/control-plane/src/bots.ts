import { createHmac, timingSafeEqual } from 'node:crypto';
import { SyncStore } from './sync.js';

export type BotPlatform = 'feishu' | 'wecom';

export interface BotCommand {
  action: 'help' | 'status' | 'run';
  text: string;
}

export function verifyWebhookSignature(rawBody: string, timestamp: string, signature: string, secret: string): boolean {
  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest();
  const actual = Buffer.from(signature, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function parseBotCommand(text: string): BotCommand {
  const normalized = text.trim();
  if (normalized === '/help') return { action: 'help', text: '' };
  if (normalized === '/status') return { action: 'status', text: '' };
  if (normalized.startsWith('/run ')) return { action: 'run', text: normalized.slice(5).trim() };
  return { action: 'help', text: '' };
}

export class BotService {
  constructor(private readonly sync: SyncStore) {}

  execute(platform: BotPlatform, command: BotCommand): { text: string } {
    if (command.action === 'help') return { text: 'COD 命令：/status 查看设备，/run <任务> 发送任务。' };
    if (command.action === 'status') {
      const devices = this.sync.listDevices();
      return { text: devices.length ? devices.map((device) => `${device.name}: ${device.status}`).join('\n') : '暂未绑定设备。' };
    }
    const device = this.sync.listDevices()[0];
    if (!device) return { text: '请先在 COD Web 或桌面端绑定设备。' };
    const task = this.sync.createTask({ title: command.text, deviceId: device.id });
    return { text: `${platform === 'feishu' ? '飞书' : '企业微信'}任务已创建：${task.title}` };
  }
}
