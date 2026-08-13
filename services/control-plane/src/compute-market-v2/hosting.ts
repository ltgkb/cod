import { randomUUID } from 'node:crypto';
import type {
  ComputeApiPage, ComputePrincipal, ComputeStatusEvent, HostingApplicationDraft,
  HostingApplicationStatus, HostingApplicationV2,
} from '@cod/contracts/compute-market-v2';
import { HttpError } from '../errors.js';
import { assertHostingTransition, validateHostingDraft } from './validation.js';

function event(status: HostingApplicationStatus, label: string, actor: ComputeStatusEvent['actor'], note: string | null = null): ComputeStatusEvent<HostingApplicationStatus> {
  return { id: randomUUID(), status, label, actor, note, createdAt: new Date().toISOString() };
}

export class ComputeHostingService {
  private readonly applications = new Map<string, HostingApplicationV2>();
  private readonly mutations = new Map<string, { fingerprint: string; id: string }>();

  create(principal: ComputePrincipal, rawDraft: HostingApplicationDraft, submit: boolean, idempotencyKey: string): HostingApplicationV2 {
    const draft = validateHostingDraft(rawDraft, submit);
    const mutationKey = `${principal.tenantId}:${principal.userId}:hosting-create:${idempotencyKey}`;
    const fingerprint = JSON.stringify({ draft, submit });
    const previous = this.mutations.get(mutationKey);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new HttpError('幂等键已用于其他托管申请', 409, 'idempotency_conflict');
      return structuredClone(this.applications.get(previous.id)!);
    }
    const now = new Date().toISOString();
    const status: HostingApplicationStatus = submit ? 'submitted' : 'draft';
    const application: HostingApplicationV2 = {
      ...draft, id: randomUUID(), tenantId: principal.tenantId, userId: principal.userId, status,
      events: [event(status, submit ? '托管申请已提交' : '草稿已保存', 'user')],
      nextAction: submit ? 'COD 将核验主体与设备资料' : '继续完善并提交申请', responsibleParty: submit ? 'cod' : 'user',
      revision: 1, createdAt: now, updatedAt: now,
    };
    this.applications.set(application.id, application);
    this.mutations.set(mutationKey, { fingerprint, id: application.id });
    return structuredClone(application);
  }

  list(principal: ComputePrincipal): ComputeApiPage<HostingApplicationV2> {
    return { items: structuredClone([...this.applications.values()].filter((application) => this.owns(principal, application)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))), nextCursor: null };
  }

  get(principal: ComputePrincipal, id: string): HostingApplicationV2 {
    const application = this.applications.get(id);
    if (!application || !this.owns(principal, application)) throw new HttpError('托管申请不存在', 404, 'hosting_application_not_found');
    return structuredClone(application);
  }

  updateDraft(principal: ComputePrincipal, id: string, rawDraft: HostingApplicationDraft, expectedRevision: number, submit: boolean): HostingApplicationV2 {
    const application = this.mutable(principal, id);
    if (application.status !== 'draft') throw new HttpError('仅草稿可由用户修改', 409, 'hosting_application_not_draft');
    if (application.revision !== expectedRevision) throw new HttpError('草稿已被更新，请重新加载', 409, 'revision_conflict');
    const draft = validateHostingDraft(rawDraft, submit);
    Object.assign(application, draft);
    application.revision += 1; application.updatedAt = new Date().toISOString();
    if (submit) {
      assertHostingTransition(application.status, 'submitted'); application.status = 'submitted';
      application.events.push(event('submitted', '托管申请已提交', 'user')); application.nextAction = 'COD 将核验主体与设备资料'; application.responsibleParty = 'cod';
    } else application.events.push(event('draft', '草稿已保存', 'user'));
    return structuredClone(application);
  }

  adminTransition(principal: ComputePrincipal, id: string, status: HostingApplicationStatus, expectedRevision: number, note: string, nextAction: string | null, responsibleParty: HostingApplicationV2['responsibleParty']): HostingApplicationV2 {
    const application = this.applications.get(id);
    if (!application || (principal.role !== 'super_admin' && application.tenantId !== principal.tenantId)) throw new HttpError('托管申请不存在', 404, 'hosting_application_not_found');
    if (application.revision !== expectedRevision) throw new HttpError('申请已被更新', 409, 'revision_conflict');
    assertHostingTransition(application.status, status);
    application.status = status; application.nextAction = nextAction; application.responsibleParty = responsibleParty;
    application.revision += 1; application.updatedAt = new Date().toISOString(); application.events.push(event(status, `状态变更为 ${status}`, 'operator', note));
    return structuredClone(application);
  }

  allForAdmin(principal: ComputePrincipal): HostingApplicationV2[] {
    return structuredClone([...this.applications.values()].filter((item) => principal.role === 'super_admin' || item.tenantId === principal.tenantId).map((item) => ({ ...item, contactName: item.contactName.length > 1 ? `${item.contactName[0]}**` : '*', contactPhone: item.contactPhone.replace(/(\d{3})\d+(\d{2})/, '$1****$2') })));
  }

  private mutable(principal: ComputePrincipal, id: string): HostingApplicationV2 {
    const application = this.applications.get(id);
    if (!application || !this.owns(principal, application)) throw new HttpError('托管申请不存在', 404, 'hosting_application_not_found');
    return application;
  }
  private owns(principal: ComputePrincipal, application: HostingApplicationV2): boolean { return application.tenantId === principal.tenantId && application.userId === principal.userId; }
}
