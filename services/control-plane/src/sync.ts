import { randomUUID } from 'node:crypto';
import type { DeviceRecord, TaskStatus } from '@cod/contracts';

export interface SyncedTask {
  id: string;
  title: string;
  status: TaskStatus;
  deviceId: string;
  updatedAt: string;
  version: number;
}

export interface TaskEvent {
  cursor: number;
  type: 'device.registered' | 'device.heartbeat' | 'task.created' | 'task.updated';
  entityId: string;
  data: unknown;
  createdAt: string;
}

export class SyncStore {
  private readonly devices = new Map<string, DeviceRecord>();
  private readonly tasks = new Map<string, SyncedTask>();
  private readonly events: TaskEvent[] = [];

  registerDevice(input: Pick<DeviceRecord, 'name' | 'platform'>): DeviceRecord {
    const device: DeviceRecord = { id: randomUUID(), name: input.name, platform: input.platform, status: 'online', lastSeenAt: new Date().toISOString() };
    this.devices.set(device.id, device);
    this.append('device.registered', device.id, device);
    return device;
  }

  heartbeat(deviceId: string): DeviceRecord {
    const existing = this.devices.get(deviceId);
    if (!existing) throw new Error('Device not found');
    const device = { ...existing, status: 'online' as const, lastSeenAt: new Date().toISOString() };
    this.devices.set(deviceId, device);
    this.append('device.heartbeat', device.id, device);
    return device;
  }

  listDevices(): DeviceRecord[] {
    return [...this.devices.values()];
  }

  createTask(input: Pick<SyncedTask, 'title' | 'deviceId'>): SyncedTask {
    if (!this.devices.has(input.deviceId)) throw new Error('Device not found');
    const task: SyncedTask = { id: randomUUID(), title: input.title, deviceId: input.deviceId, status: 'draft', updatedAt: new Date().toISOString(), version: 1 };
    this.tasks.set(task.id, task);
    this.append('task.created', task.id, task);
    return task;
  }

  updateTask(taskId: string, status: TaskStatus, expectedVersion: number): SyncedTask {
    const existing = this.tasks.get(taskId);
    if (!existing) throw new Error('Task not found');
    if (existing.version !== expectedVersion) throw new Error('Task version conflict');
    const task = { ...existing, status, version: existing.version + 1, updatedAt: new Date().toISOString() };
    this.tasks.set(task.id, task);
    this.append('task.updated', task.id, task);
    return task;
  }

  listTasks(): SyncedTask[] {
    return [...this.tasks.values()];
  }

  eventsAfter(cursor: number): TaskEvent[] {
    return this.events.filter((event) => event.cursor > cursor);
  }

  private append(type: TaskEvent['type'], entityId: string, data: unknown): void {
    this.events.push({ cursor: this.events.length + 1, type, entityId, data, createdAt: new Date().toISOString() });
  }
}
