import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEVICE_OFFLINE_AFTER_MS, TASK_LEASE_DURATION_MS, TASK_LEASE_EXPIRED_ERROR, type Principal } from './database.js';
import { MemoryDatabase } from './memory-database.js';

const principal: Principal = { userId: 'user_demo', tenantId: 'tenant_kai_com', email: 'developer@kai.com', role: 'member' };
const claimCredential=(marker='A')=>({claimId:marker.repeat(43),leaseToken:(marker==='Z'?'Y':'Z').repeat(43)});
afterEach(()=>vi.useRealTimers());

describe('synchronization database contract', () => {
  it('registers a device and synchronizes versioned task events', async () => {
    const database = new MemoryDatabase();
    const device = await database.registerDevice(principal, { name: 'MacBook Pro', platform: 'macos' });
    const task = await database.createTask(principal, { title: '优化登录流程', deviceId: device.id });
    const claim = await database.claimTask(principal, task.id, 1, claimCredential('A'));
    const updated = claim.task;
    expect(updated.version).toBe(2);
    expect(await database.eventsAfter(principal, 1)).toHaveLength(2);
    await expect(database.updateTask(principal, task.id, 'complete', 1)).rejects.toMatchObject({ status: 409 });
    await expect(database.updateTask(principal, task.id, 'complete', 2, {}, claim)).rejects.toMatchObject({ code: 'task_result_required' });
    await expect(database.updateTask(principal, task.id, 'failed', 2, {}, claim)).rejects.toMatchObject({ code: 'task_error_required' });
    const completed = await database.updateTask(principal, task.id, 'complete', 2, { result: '构建通过', error: null }, claim);
    expect(completed.result).toBe('构建通过');
    await expect(database.updateTask(principal, completed.id, 'draft', completed.version)).rejects.toMatchObject({ code: 'invalid_task_transition' });
  });

  it('validates device platforms', async () => {
    const database = new MemoryDatabase();
    await expect(database.registerDevice(principal, { name: 'Unknown', platform: 'watch' as 'linux' })).rejects.toMatchObject({ code: 'invalid_device_platform' });
  });

  it('records cancellation as a terminal state and allows an explicit restart',async()=>{
    const database=new MemoryDatabase();const device=await database.registerDevice(principal,{name:'Windows PC',platform:'windows'});const task=await database.createTask(principal,{title:'长任务',deviceId:device.id});const claim=await database.claimTask(principal,task.id,task.version,claimCredential('B'));const cancelled=await database.updateTask(principal,task.id,'cancelled',claim.task.version,{result:'partial',error:'ignored'});
    expect(cancelled).toMatchObject({status:'cancelled',result:null,error:null});
    await expect(database.updateTask(principal,cancelled.id,'complete',cancelled.version,{result:'不应完成'})).rejects.toMatchObject({code:'invalid_task_transition'});
    const restarted=await database.claimTask(principal,cancelled.id,cancelled.version,claimCredential('C'));expect(restarted.task).toMatchObject({status:'running',result:null,error:null});expect(restarted.executionId).not.toBe(claim.executionId);
  });

  it('clears stale waiting output when the same execution resumes',async()=>{
    const database=new MemoryDatabase();const device=await database.registerDevice(principal,{name:'Resume Mac',platform:'macos'});const task=await database.createTask(principal,{title:'resume cleanly',deviceId:device.id});const claim=await database.claimTask(principal,task.id,task.version,claimCredential('W'));
    const waiting=await database.updateTask(principal,task.id,'waiting',claim.task.version,{result:'partial output',error:'waiting detail'},claim);expect(waiting).toMatchObject({status:'waiting',result:'partial output',error:'waiting detail'});
    await expect(database.updateTask(principal,task.id,'running',waiting.version,{},claim)).resolves.toMatchObject({status:'running',result:null,error:null});
  });

  it('marks devices offline after 45 seconds and refuses new work until a heartbeat',async()=>{
    vi.useFakeTimers();vi.setSystemTime(new Date('2026-08-11T00:00:00Z'));
    const database=new MemoryDatabase();const device=await database.registerDevice(principal,{name:'Offline Mac',platform:'macos'});
    vi.advanceTimersByTime(DEVICE_OFFLINE_AFTER_MS+1);
    expect(await database.listDevices(principal)).toEqual([expect.objectContaining({id:device.id,status:'offline'})]);
    await expect(database.createTask(principal,{title:'must not queue',deviceId:device.id})).rejects.toMatchObject({status:409,code:'device_offline'});
    await database.heartbeat(principal,device.id);expect(await database.createTask(principal,{title:'now online',deviceId:device.id})).toMatchObject({status:'draft'});
  });

  it('renews only the matching active execution without version or event churn',async()=>{
    vi.useFakeTimers();vi.setSystemTime(new Date('2026-08-11T00:00:00Z'));
    const database=new MemoryDatabase();const device=await database.registerDevice(principal,{name:'Lease Mac',platform:'macos'});const task=await database.createTask(principal,{title:'long run',deviceId:device.id});const claim=await database.claimTask(principal,task.id,task.version,claimCredential('D'));const cursor=(await database.eventsAfter(principal,0)).at(-1)!.cursor;
    vi.advanceTimersByTime(TASK_LEASE_DURATION_MS-10_000);await database.heartbeat(principal,device.id,{taskId:task.id,executionId:claim.executionId,leaseToken:claim.leaseToken});
    vi.advanceTimersByTime(20_000);expect(await database.getTask(principal,task.id)).toMatchObject({status:'running',version:claim.task.version});expect(await database.eventsAfter(principal,cursor)).toHaveLength(0);
    const wrongLeaseToken=`${claim.leaseToken.slice(0,-1)}${claim.leaseToken.endsWith('x')?'y':'x'}`;
    await expect(database.heartbeat(principal,device.id,{taskId:task.id,executionId:claim.executionId,leaseToken:wrongLeaseToken})).rejects.toMatchObject({status:409,code:'task_lease_expired'});
    vi.advanceTimersByTime(TASK_LEASE_DURATION_MS-20_000+1);const expired=await database.getTask(principal,task.id);expect(expired).toMatchObject({status:'failed',version:claim.task.version+1,error:TASK_LEASE_EXPIRED_ERROR});expect(await database.eventsAfter(principal,cursor)).toHaveLength(1);expect((await database.listAudit(principal,20)).some((entry)=>entry.action==='task.execution.interrupted'&&(entry.data as {reason?:string}).reason==='lease_expired')).toBe(true);
    await expect(database.updateTask(principal,task.id,'complete',claim.task.version,{result:'stale'},claim)).rejects.toMatchObject({code:'version_conflict'});
  });

  it('replays a committed claim response with the same credential without duplicate mutations',async()=>{
    const database=new MemoryDatabase();const device=await database.registerDevice(principal,{name:'Retry Mac',platform:'macos'});const task=await database.createTask(principal,{title:'response may be lost',deviceId:device.id});const credential=claimCredential('E');
    const first=await database.claimTask(principal,task.id,task.version,credential);const cursor=(await database.eventsAfter(principal,0)).at(-1)!.cursor;const auditCount=(await database.listAudit(principal,200)).length;
    const replay=await database.claimTask(principal,task.id,task.version,credential);
    expect(replay).toEqual({...first,replayed:true});expect(replay.task.version).toBe(first.task.version);expect(await database.eventsAfter(principal,cursor)).toHaveLength(0);expect(await database.listAudit(principal,200)).toHaveLength(auditCount);
    await expect(database.claimTask(principal,task.id,task.version,claimCredential('F'))).rejects.toMatchObject({status:409,code:'task_already_running'});
  });

  it('replays an already committed settlement after its task becomes terminal',async()=>{
    const database=new MemoryDatabase();const device=await database.registerDevice(principal,{name:'Billing replay',platform:'web'});const task=await database.createTask(principal,{title:'settle once',deviceId:device.id});const claim=await database.claimTask(principal,task.id,task.version,claimCredential('G'));const requestKey='terminal-settlement';const fingerprint='a'.repeat(64);const reservationId='00000000-0000-4000-8000-000000000010';const event={idempotencyKey:`chat:${requestKey}:${fingerprint}`,taskId:task.id,sourceId:'demo',paymentDirection:'测试',model:'coder-pro',inputTokens:1,outputTokens:1,costCents:1};const completion={requestKey,fingerprint,executionId:claim.executionId,responsePayload:{answer:'done'},audit:{entityId:'coder-pro',data:{taskId:task.id}}};
    expect(await database.claimChatRequest(principal,requestKey,fingerprint,claim.executionId)).toEqual({state:'claimed'});await database.reserveUsage(principal,reservationId,1,{taskId:task.id,executionId:claim.executionId});const first=await database.settleUsage(principal,reservationId,event,completion,claim.executionId);await database.updateTask(principal,task.id,'complete',claim.task.version,{result:'done'},claim);expect(await database.settleUsage(principal,reservationId,event,completion,claim.executionId)).toEqual(first);expect((await database.getLedger(principal)).filter((entry)=>entry.id===first.id)).toHaveLength(1);
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
