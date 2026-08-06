import { randomUUID } from 'node:crypto';
import type { AccountSummary, DeviceRecord, TaskStatus, UsageEvent } from '@cod/contracts';
import { validateDeviceInput, validateTaskTransition, type AuditEntry, type CodDatabase, type LedgerEntry, type Principal, type SyncedTask, type TaskEvent, type TaskOutcome, type TopupRequest } from './database.js';
import { HttpError } from './errors.js';

interface UserState {
  account: AccountSummary;
  ledger: LedgerEntry[];
  idempotency: Map<string, LedgerEntry>;
  devices: Map<string, DeviceRecord>;
  tasks: Map<string, SyncedTask>;
  events: TaskEvent[];
  audit: AuditEntry[];
  reservations: Map<string, { amountCents: number; status: 'reserved' | 'settled' | 'released' }>;
}

export class MemoryDatabase implements CodDatabase {
  private readonly users = new Map<string, UserState>();
  async initialize() {}
  async close() {}
  async health() { return true; }
  async ensurePrincipal(p: Principal) { this.state(p); }
  async getAccount(p: Principal) { return { ...this.state(p).account }; }
  async getLedger(p: Principal) { return [...this.state(p).ledger]; }
  async topup(p: Principal, request: TopupRequest) {
    const state=this.state(p); const existing=state.idempotency.get(request.idempotencyKey); if(existing) return existing;
    if(!Number.isInteger(request.amountCents)||request.amountCents<100||request.amountCents>1_000_000) throw new HttpError('Top-up amount must be between 100 and 1000000 cents',400,'invalid_topup');
    const entry:LedgerEntry={id:randomUUID(),type:'topup',amountCents:request.amountCents,createdAt:new Date().toISOString(),reference:`${request.channel}:${request.idempotencyKey}`,sourceId:null,model:null,paymentDirection:'用户 → COD 钱包'};
    state.account={...state.account,balanceCents:state.account.balanceCents+request.amountCents}; state.ledger.unshift(entry); state.idempotency.set(request.idempotencyKey,entry); return entry;
  }
  async recordUsage(p: Principal,event:UsageEvent) {
    const state=this.state(p); const existing=state.idempotency.get(event.idempotencyKey); if(existing) return existing;
    if(!Number.isInteger(event.costCents)||event.costCents<0) throw new HttpError('Usage cost is invalid',400,'invalid_usage');
    if(event.costCents>state.account.balanceCents) throw new HttpError('Insufficient balance',402,'insufficient_balance');
    const entry:LedgerEntry={id:randomUUID(),type:'usage',amountCents:-event.costCents,createdAt:new Date().toISOString(),reference:`${event.sourceId}:${event.model}:${event.taskId}`,sourceId:event.sourceId,model:event.model,paymentDirection:event.paymentDirection};
    state.account={...state.account,balanceCents:state.account.balanceCents-event.costCents}; state.ledger.unshift(entry); state.idempotency.set(event.idempotencyKey,entry); return entry;
  }
  async reserveUsage(p:Principal,id:string,amountCents:number){const state=this.state(p);if(state.reservations.has(id))return;if(!Number.isInteger(amountCents)||amountCents<0)throw new HttpError('Reservation amount is invalid',400,'invalid_reservation');if(state.account.balanceCents<amountCents)throw new HttpError('Insufficient balance',402,'insufficient_balance');state.account={...state.account,balanceCents:state.account.balanceCents-amountCents};state.reservations.set(id,{amountCents,status:'reserved'});}
  async settleUsage(p:Principal,id:string,event:UsageEvent){const state=this.state(p);const reservation=state.reservations.get(id);const existing=state.idempotency.get(event.idempotencyKey);if(existing){if(reservation?.status==='reserved'){state.account={...state.account,balanceCents:state.account.balanceCents+reservation.amountCents};reservation.status='released';}return existing;}if(!reservation||reservation.status!=='reserved')throw new HttpError('Usage reservation not found',409,'reservation_not_found');const delta=reservation.amountCents-event.costCents;if(delta>=0)state.account={...state.account,balanceCents:state.account.balanceCents+delta};else{if(state.account.balanceCents < -delta)throw new HttpError('Insufficient balance',402,'insufficient_balance');state.account={...state.account,balanceCents:state.account.balanceCents+delta};}const entry:LedgerEntry={id:randomUUID(),type:'usage',amountCents:-event.costCents,createdAt:new Date().toISOString(),reference:`${event.sourceId}:${event.model}:${event.taskId}`,sourceId:event.sourceId,model:event.model,paymentDirection:event.paymentDirection};state.ledger.unshift(entry);state.idempotency.set(event.idempotencyKey,entry);reservation.status='settled';return entry;}
  async releaseUsage(p:Principal,id:string){const state=this.state(p);const reservation=state.reservations.get(id);if(!reservation||reservation.status!=='reserved')return;state.account={...state.account,balanceCents:state.account.balanceCents+reservation.amountCents};reservation.status='released';}
  async listDevices(p:Principal){return [...this.state(p).devices.values()].map((device)=>Date.now()-new Date(device.lastSeenAt).getTime()>45_000?{...device,status:'offline' as const}:device);}
  async registerDevice(p:Principal,input:Pick<DeviceRecord,'name'|'platform'>){validateDeviceInput(input);const state=this.state(p);const device:DeviceRecord={id:randomUUID(),name:input.name.trim().slice(0,100),platform:input.platform,status:'online',lastSeenAt:new Date().toISOString()};state.devices.set(device.id,device);this.append(state,'device.registered',device.id,device);return device;}
  async heartbeat(p:Principal,id:string){const state=this.state(p);const current=state.devices.get(id);if(!current)throw new HttpError('Device not found',404,'device_not_found');const device={...current,status:'online' as const,lastSeenAt:new Date().toISOString()};state.devices.set(id,device);return device;}
  async listTasks(p:Principal){return [...this.state(p).tasks.values()];}
  async createTask(p:Principal,input:Pick<SyncedTask,'title'|'deviceId'>){const state=this.state(p);if(!input.title?.trim())throw new HttpError('Task title is required',400,'invalid_task');if(!state.devices.has(input.deviceId))throw new HttpError('Device not found',404,'device_not_found');const task:SyncedTask={id:randomUUID(),title:input.title.trim().slice(0,500),deviceId:input.deviceId,status:'draft',updatedAt:new Date().toISOString(),version:1,result:null,error:null};state.tasks.set(task.id,task);this.append(state,'task.created',task.id,task);return task;}
  async updateTask(p:Principal,id:string,status:TaskStatus,version:number,outcome:TaskOutcome={}){const state=this.state(p);const current=state.tasks.get(id);if(!current)throw new HttpError('Task not found',404,'task_not_found');if(current.version!==version)throw new HttpError('Task version conflict',409,'version_conflict');validateTaskTransition(current.status,status);if(outcome.result!==undefined&&outcome.result!==null&&outcome.result.length>50_000)throw new HttpError('Task result is too large',400,'task_result_too_large');if(outcome.error!==undefined&&outcome.error!==null&&outcome.error.length>5_000)throw new HttpError('Task error is too large',400,'task_error_too_large');if(current.status===status&&outcome.result===undefined&&outcome.error===undefined)return current;const task={...current,status,result:outcome.result===undefined?current.result:outcome.result,error:outcome.error===undefined?current.error:outcome.error,version:current.version+1,updatedAt:new Date().toISOString()};state.tasks.set(id,task);this.append(state,'task.updated',id,task);return task;}
  async eventsAfter(p:Principal,cursor:number){return this.state(p).events.filter((event)=>event.cursor>cursor);}
  async audit(p:Principal,action:string,entityType:string,entityId:string|null,data:unknown={}){this.state(p).audit.unshift({id:randomUUID(),action,entityType,entityId,data,createdAt:new Date().toISOString()});}
  async listAudit(p:Principal,limit:number){return this.state(p).audit.slice(0,Math.min(Math.max(limit,1),200));}
  private key(p:Principal){return `${p.tenantId}:${p.userId}`;}
  private state(p:Principal){const key=this.key(p);let state=this.users.get(key);if(!state){state={account:{userId:p.userId,displayName:p.email.split('@')[0],balanceCents:6840,currency:'CNY',plan:'developer'},ledger:[],idempotency:new Map(),devices:new Map(),tasks:new Map(),events:[],audit:[],reservations:new Map()};this.users.set(key,state);}return state;}
  private append(state:UserState,type:TaskEvent['type'],entityId:string,data:unknown){state.events.push({cursor:state.events.length+1,type,entityId,data,createdAt:new Date().toISOString()});}
}
