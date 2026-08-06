import { describe, expect, it } from 'vitest';
import { SyncStore } from './sync.js';
import { MemoryDatabase } from './memory-database.js';
import type { Principal } from './database.js';

const principal: Principal = { userId: 'user_demo', tenantId: 'tenant_kai_com', email: 'developer@kai.com', role: 'member' };

describe('SyncStore', () => {
  it('registers a device and synchronizes versioned task events', () => {
    const store = new SyncStore();
    const device = store.registerDevice({ name: 'MacBook Pro', platform: 'macos' });
    const task = store.createTask({ title: '优化登录流程', deviceId: device.id });
    const updated = store.updateTask(task.id, 'running', 1);
    expect(updated.version).toBe(2);
    expect(store.eventsAfter(1)).toHaveLength(2);
    expect(() => store.updateTask(task.id, 'complete', 1)).toThrow('version conflict');
  });
});

describe('MemoryDatabase tenant isolation', () => {
  it('does not expose devices and tasks across users', async () => {
    const database = new MemoryDatabase();
    const device = await database.registerDevice(principal, { name: 'Developer PC', platform: 'linux' });
    await database.createTask(principal, { title: 'private task', deviceId: device.id });
    const other = { ...principal, userId: 'other', email: 'other@kai.com' };
    expect(await database.listDevices(other)).toHaveLength(0);
    expect(await database.listTasks(other)).toHaveLength(0);
    await expect(database.createTask(other, { title: 'escape', deviceId: device.id })).rejects.toMatchObject({ status: 404 });
  });
});
