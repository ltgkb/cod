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
    await expect(database.updateTask(principal, task.id, 'complete', 2)).rejects.toMatchObject({ code: 'task_result_required' });
    await expect(database.updateTask(principal, task.id, 'failed', 2)).rejects.toMatchObject({ code: 'task_error_required' });
    const completed = await database.updateTask(principal, task.id, 'complete', 2, { result: '构建通过', error: null });
    expect(completed.result).toBe('构建通过');
    await expect(database.updateTask(principal, completed.id, 'draft', completed.version)).rejects.toMatchObject({ code: 'invalid_task_transition' });
  });

  it('validates device platforms', async () => {
    const database = new MemoryDatabase();
    await expect(database.registerDevice(principal, { name: 'Unknown', platform: 'watch' as 'linux' })).rejects.toMatchObject({ code: 'invalid_device_platform' });
    await expect(database.registerDevice(principal, { name: 42 as unknown as string, platform: 'linux' })).rejects.toMatchObject({ status: 400, code: 'invalid_device' });
    await expect(database.createTask(principal, null as unknown as { title: string; deviceId: string })).rejects.toMatchObject({ status: 400, code: 'invalid_task' });
  });

  it('rejects malformed task outcomes as client errors', async () => {
    const database = new MemoryDatabase();
    const device = await database.registerDevice(principal, { name: 'Linux', platform: 'linux' });
    const task = await database.createTask(principal, { title: 'Validate outcome', deviceId: device.id });
    const running = await database.updateTask(principal, task.id, 'running', task.version);
    await expect(database.updateTask(principal, task.id, 'complete', running.version, { result: 42 as unknown as string })).rejects.toMatchObject({ status: 400, code: 'invalid_task_result' });
    await expect(database.updateTask(principal, task.id, 'failed', running.version, { error: {} as unknown as string })).rejects.toMatchObject({ status: 400, code: 'invalid_task_error' });
  });

  it('records cancellation as a terminal state and allows an explicit restart',async()=>{
    const database=new MemoryDatabase();const device=await database.registerDevice(principal,{name:'Windows PC',platform:'windows'});const task=await database.createTask(principal,{title:'长任务',deviceId:device.id});const running=await database.updateTask(principal,task.id,'running',task.version);const cancelled=await database.updateTask(principal,task.id,'cancelled',running.version,{result:'partial',error:'ignored'});
    expect(cancelled).toMatchObject({status:'cancelled',result:null,error:null});
    await expect(database.updateTask(principal,cancelled.id,'complete',cancelled.version,{result:'不应完成'})).rejects.toMatchObject({code:'invalid_task_transition'});
    const restarted=await database.updateTask(principal,cancelled.id,'running',cancelled.version);expect(restarted).toMatchObject({status:'running',result:null,error:null});
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
