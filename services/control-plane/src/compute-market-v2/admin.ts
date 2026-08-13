import { randomUUID } from 'node:crypto';
import type { ComputeAuditEvent, ComputeInventoryPool, ComputePrincipal } from '@cod/contracts/compute-market-v2';
import { HttpError } from '../errors.js';

export class ComputeAdminService {
  private readonly inventory = new Map<string, ComputeInventoryPool>();
  private readonly auditEvents: ComputeAuditEvent[] = [];
  private readonly mutations = new Map<string, { fingerprint: string; value: unknown }>();

  idempotent<T>(principal: ComputePrincipal, key: string, fingerprint: string, operation: () => T): T {
    const scopedKey = `${principal.tenantId}:${principal.userId}:${key}`; const previous = this.mutations.get(scopedKey);
    if (previous) { if (previous.fingerprint !== fingerprint) throw new HttpError('幂等键已用于其他管理操作', 409, 'idempotency_conflict'); return structuredClone(previous.value as T); }
    const value = operation(); this.mutations.set(scopedKey, { fingerprint, value: structuredClone(value) }); return value;
  }

  listInventory(principal: ComputePrincipal): ComputeInventoryPool[] {
    return structuredClone([...this.inventory.values()].filter((pool) => principal.role === 'super_admin' || pool.facilityLabel.startsWith(`${principal.tenantId}:`)));
  }

  saveInventory(principal: ComputePrincipal, input: Omit<ComputeInventoryPool, 'revision' | 'updatedAt'>, expectedRevision: number | null, reason: string): ComputeInventoryPool {
    const current = this.inventory.get(input.id); const revision = current?.revision ?? 0;
    if (current && expectedRevision !== revision) throw new HttpError('库存已被更新', 409, 'revision_conflict');
    if (!current && expectedRevision !== null) throw new HttpError('新库存池不能携带版本', 400, 'unexpected_revision');
    for (const field of ['availableUnits', 'reservedUnits', 'allocatedUnits', 'maintenanceUnits'] as const) if (!Number.isInteger(input[field]) || input[field] < 0) throw new HttpError('库存数量必须是非负整数', 400, 'invalid_inventory');
    const saved: ComputeInventoryPool = { ...input, facilityLabel: principal.role === 'super_admin' ? input.facilityLabel : `${principal.tenantId}:${input.facilityLabel.replace(`${principal.tenantId}:`, '')}`, revision: revision + 1, updatedAt: new Date().toISOString() };
    this.inventory.set(saved.id, saved); this.audit(principal, current ? 'compute.inventory.updated' : 'compute.inventory.created', 'inventory', saved.id, { reason, beforeAvailable: current?.availableUnits ?? null, afterAvailable: saved.availableUnits }); return structuredClone(saved);
  }

  audit(principal: ComputePrincipal, action: string, entityType: string, entityId: string | null, summary: ComputeAuditEvent['summary']): void {
    this.auditEvents.unshift({ id: randomUUID(), tenantId: principal.tenantId, actorUserId: principal.userId, action, entityType, entityId, summary, createdAt: new Date().toISOString() });
  }

  listAudit(principal: ComputePrincipal): ComputeAuditEvent[] { return structuredClone(this.auditEvents.filter((event) => principal.role === 'super_admin' || event.tenantId === principal.tenantId)); }
}
