import { describe, expect, it } from 'vitest';
import { SyncStore } from './sync.js';

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
