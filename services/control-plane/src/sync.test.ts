import { describe, expect, it } from 'vitest';
import type { Principal } from './database.js';
import { MemoryDatabase } from './memory-database.js';

const principal: Principal = { userId: 'user_demo', tenantId: 'tenant_kai_com', email: 'developer@kai.com', role: 'member' };

describe('synchronization database contract', () => {
  it('registers a device and synchronizes versioned task events', async () => {
    const database = new MemoryDatabase();
    const device = await database.registerDevice(principal, { name: 'MacBook Pro', platform: 'macos' });
    const task = await database.createTask(principal, { title: '优化登录流程', deviceId: device.id });
    const updated = await database.updateTask(principal, task.id, 'running', 1);
    expect(updated.version).toBe(2);
    expect(await database.eventsAfter(principal, 1)).toHaveLength(2);
    await expect(database.updateTask(principal, task.id, 'complete', 1)).rejects.toMatchObject({ status: 409 });
    const completed = await database.updateTask(principal, task.id, 'complete', 2, { result: '构建通过', error: null });
    expect(completed.result).toBe('构建通过');
    await expect(database.updateTask(principal, completed.id, 'draft', completed.version)).rejects.toMatchObject({ code: 'invalid_task_transition' });
  });

  it('validates device platforms', async () => {
    const database = new MemoryDatabase();
    await expect(database.registerDevice(principal, { name: 'Unknown', platform: 'watch' as 'linux' })).rejects.toMatchObject({ code: 'invalid_device_platform' });
  });

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
