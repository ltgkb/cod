import { randomUUID } from 'node:crypto';
import type {
  ComputeApiPage, ComputePrincipal, ComputeStatusEvent, ComputeTicket,
  HostedDeviceStatus, HostedDeviceV2, HostingApplicationV2,
} from '@cod/contracts/compute-market-v2';
import { HttpError } from '../errors.js';
import { assertDeviceTransition } from './validation.js';

function event(status: HostedDeviceStatus, label: string, actor: ComputeStatusEvent['actor'], note: string | null = null): ComputeStatusEvent<HostedDeviceStatus> {
  return { id: randomUUID(), status, label, actor, note, createdAt: new Date().toISOString() };
}

export class ComputeDeviceService {
  private readonly devices = new Map<string, HostedDeviceV2>();
  private readonly tickets = new Map<string, ComputeTicket>();
  private readonly ticketMutations = new Map<string, { fingerprint: string; id: string }>();

  createFromAcceptedApplication(application: HostingApplicationV2, principal: ComputePrincipal): HostedDeviceV2[] {
    if (application.status !== 'deploying' && application.status !== 'running') throw new HttpError('申请尚未完成验收部署', 409, 'hosting_not_accepted');
    const existing = [...this.devices.values()].filter((device) => device.hostingApplicationId === application.id);
    if (existing.length) return structuredClone(existing);
    const now = new Date().toISOString();
    const devices = application.devices.map((source, index): HostedDeviceV2 => ({
      id: randomUUID(), tenantId: application.tenantId, userId: application.userId, hostingApplicationId: application.id,
      name: `${source.gpuModel} 节点 ${index + 1}`, gpuModel: source.gpuModel, gpuCount: source.gpuCount, regionLabel: application.city,
      status: 'deploying', lastHeartbeatAt: null, availability24hPercent: null, actionRequired: null,
      events: [event('deploying', '设备完成验收并进入部署', 'operator')], revision: 1, createdAt: now, updatedAt: now,
    }));
    for (const device of devices) this.devices.set(device.id, device);
    return structuredClone(devices);
  }

  list(principal: ComputePrincipal, status?: HostedDeviceStatus): ComputeApiPage<HostedDeviceV2> {
    return { items: structuredClone([...this.devices.values()].filter((device) => this.owns(principal, device) && (!status || device.status === status)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))), nextCursor: null };
  }

  get(principal: ComputePrincipal, id: string): HostedDeviceV2 {
    const device = this.devices.get(id);
    if (!device || !this.owns(principal, device)) throw new HttpError('设备不存在', 404, 'hosted_device_not_found');
    return structuredClone(device);
  }

  createTicket(principal: ComputePrincipal, deviceId: string, input: Pick<ComputeTicket, 'category' | 'subject' | 'description'>, idempotencyKey: string): ComputeTicket {
    const device = this.devices.get(deviceId);
    if (!device || !this.owns(principal, device)) throw new HttpError('设备不存在', 404, 'hosted_device_not_found');
    const subject = input.subject?.trim() ?? ''; const description = input.description?.trim() ?? '';
    if (subject.length < 2 || subject.length > 120 || description.length < 5 || description.length > 5000) throw new HttpError('请完善工单主题和说明', 400, 'invalid_ticket');
    const mutationKey = `${principal.tenantId}:${principal.userId}:device-ticket:${idempotencyKey}`; const fingerprint = JSON.stringify({ deviceId, ...input });
    const previous = this.ticketMutations.get(mutationKey);
    if (previous) { if (previous.fingerprint !== fingerprint) throw new HttpError('幂等键已用于其他工单', 409, 'idempotency_conflict'); return structuredClone(this.tickets.get(previous.id)!); }
    const now = new Date().toISOString();
    const ticket: ComputeTicket = { id: randomUUID(), tenantId: principal.tenantId, userId: principal.userId, deviceId, category: input.category, subject, description, status: 'open', createdAt: now, updatedAt: now };
    this.tickets.set(ticket.id, ticket); this.ticketMutations.set(mutationKey, { fingerprint, id: ticket.id }); return structuredClone(ticket);
  }

  adminTransition(principal: ComputePrincipal, id: string, status: HostedDeviceStatus, expectedRevision: number, note: string, actionRequired: string | null): HostedDeviceV2 {
    const device = this.devices.get(id);
    if (!device || (principal.role !== 'super_admin' && device.tenantId !== principal.tenantId)) throw new HttpError('设备不存在', 404, 'hosted_device_not_found');
    if (device.revision !== expectedRevision) throw new HttpError('设备已被更新', 409, 'revision_conflict');
    assertDeviceTransition(device.status, status);
    device.status = status; device.actionRequired = status === 'action_required' ? actionRequired : null;
    device.revision += 1; device.updatedAt = new Date().toISOString(); device.events.push(event(status, `状态变更为 ${status}`, 'operator', note));
    return structuredClone(device);
  }

  allForAdmin(principal: ComputePrincipal): HostedDeviceV2[] { return structuredClone([...this.devices.values()].filter((item) => principal.role === 'super_admin' || item.tenantId === principal.tenantId)); }
  allTicketsForAdmin(principal: ComputePrincipal): ComputeTicket[] { return structuredClone([...this.tickets.values()].filter((item) => principal.role === 'super_admin' || item.tenantId === principal.tenantId)); }
  private owns(principal: ComputePrincipal, device: HostedDeviceV2): boolean { return device.tenantId === principal.tenantId && device.userId === principal.userId; }
}
