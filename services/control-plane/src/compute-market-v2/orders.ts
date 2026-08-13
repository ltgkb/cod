import { randomUUID } from 'node:crypto';
import type {
  ComputeApiPage, ComputeOrderStatus, ComputeOrderV2, ComputePrincipal,
  ComputeStatusEvent, CreateComputeOrderInput, InventoryReservation,
} from '@cod/contracts/compute-market-v2';
import { HttpError } from '../errors.js';
import type { ComputeCatalogService } from './catalog.js';
import type { CardHourLedgerPort } from './settlements.js';
import { assertOrderTransition, validateOrderInput } from './validation.js';

const reservationMinutes = 15;

interface StoredMutation<T> { fingerprint: string; value: T }

function fingerprint(value: unknown): string { return JSON.stringify(value); }

function event(status: ComputeOrderStatus, label: string, actor: ComputeStatusEvent['actor'], note: string | null = null): ComputeStatusEvent<ComputeOrderStatus> {
  return { id: randomUUID(), status, label, actor, note, createdAt: new Date().toISOString() };
}

export class ComputeOrderService {
  private readonly orders = new Map<string, ComputeOrderV2>();
  private readonly reservations = new Map<string, InventoryReservation>();
  private readonly mutations = new Map<string, StoredMutation<ComputeOrderV2 | InventoryReservation>>();

  constructor(private readonly catalog: ComputeCatalogService, private readonly ledger: CardHourLedgerPort) {}

  createReservation(principal: ComputePrincipal, input: { skuId: string; quantity: number; inventoryRevision: number }, idempotencyKey: string): InventoryReservation {
    const key = this.key(principal, 'reservation', idempotencyKey);
    const requestFingerprint = fingerprint(input);
    const previous = this.mutations.get(key);
    if (previous) {
      if (previous.fingerprint !== requestFingerprint) throw new HttpError('幂等键已用于不同的预占请求', 409, 'idempotency_conflict');
      return structuredClone(previous.value as InventoryReservation);
    }
    const { offer, sku } = this.catalog.sku(input.skuId);
    if (offer.purchaseMode === 'quote' || offer.availability.level === 'quote') throw new HttpError('该商品需人工核验库存', 409, 'quote_required');
    if (offer.availability.level === 'sold_out') throw new HttpError('当前无库存', 409, 'inventory_sold_out');
    if (input.inventoryRevision !== sku.inventoryRevision) throw new HttpError('库存数据已变化，请刷新后重试', 409, 'inventory_revision_conflict');
    if (!Number.isInteger(input.quantity) || input.quantity < sku.minimumUnits || (sku.maximumUnits !== null && input.quantity > sku.maximumUnits)) throw new HttpError('预占数量超出范围', 400, 'invalid_quantity');
    const now = new Date();
    const reservation: InventoryReservation = {
      id: randomUUID(), tenantId: principal.tenantId, userId: principal.userId, skuId: sku.id, quantity: input.quantity,
      inventoryRevision: sku.inventoryRevision, status: 'active', createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + reservationMinutes * 60_000).toISOString(),
    };
    this.reservations.set(reservation.id, reservation);
    this.mutations.set(key, { fingerprint: requestFingerprint, value: reservation });
    return structuredClone(reservation);
  }

  createOrder(principal: ComputePrincipal, rawInput: CreateComputeOrderInput, idempotencyKey: string): ComputeOrderV2 {
    const input = validateOrderInput(rawInput);
    const key = this.key(principal, 'order', idempotencyKey);
    const requestFingerprint = fingerprint(input);
    const previous = this.mutations.get(key);
    if (previous) {
      if (previous.fingerprint !== requestFingerprint) throw new HttpError('幂等键已用于不同的订单请求', 409, 'idempotency_conflict');
      return structuredClone(previous.value as ComputeOrderV2);
    }
    const { offer, sku } = this.catalog.sku(input.skuId);
    if (offer.status !== 'published' || offer.availability.level === 'sold_out') throw new HttpError('当前无库存', 409, 'inventory_sold_out');
    if (input.inventoryRevision !== sku.inventoryRevision) throw new HttpError('价格或库存已变化，请重新确认', 409, 'inventory_revision_conflict');
    if (input.quantity < sku.minimumUnits || (sku.maximumUnits !== null && input.quantity > sku.maximumUnits)) throw new HttpError('数量超出 SKU 限制', 400, 'invalid_quantity');
    const selectedImage = sku.imageOptions.find((image) => image.id === input.imageId);
    if (!selectedImage) throw new HttpError('镜像不可用', 409, 'image_not_available');
    const subtotal = sku.priceCardHoursMilli === null ? 0 : sku.priceCardHoursMilli * input.quantity * input.availableDurationHours;
    if (!Number.isSafeInteger(subtotal)) throw new HttpError('订单卡时超出系统范围', 400, 'card_hours_overflow');
    const now = new Date().toISOString();
    const quoteOnly = offer.purchaseMode === 'quote' || offer.availability.level === 'quote';
    const initialStatus: ComputeOrderStatus = quoteOnly ? 'pending_quote' : offer.purchaseMode === 'reservation' ? 'reserved' : 'pending_settlement';
    const order: ComputeOrderV2 = {
      id: randomUUID(), tenantId: principal.tenantId, userId: principal.userId, skuId: sku.id,
      skuSnapshot: { offerId: offer.id, offerTitle: offer.title, gpuModel: offer.gpu.model, gpuMemoryGb: offer.gpu.memoryGb, regionLabel: offer.regionLabel, deliveryMode: sku.deliveryMode, period: sku.period, imageLabel: selectedImage.label, unitPriceCardHoursMilli: sku.priceCardHoursMilli, inventoryRevision: sku.inventoryRevision },
      quantity: input.quantity, availableDurationHours: input.availableDurationHours, startsAt: input.startsAt, contact: input.contact,
      subtotalCardHoursMilli: subtotal, discountCardHoursMilli: 0, chargedCardHoursMilli: subtotal,
      status: initialStatus, reservationExpiresAt: initialStatus === 'reserved' ? new Date(Date.now() + reservationMinutes * 60_000).toISOString() : null,
      quote: null, termsVersion: input.acceptedTermsVersion, events: [event(initialStatus, quoteOnly ? '租赁需求已提交' : initialStatus === 'reserved' ? '库存已预占' : '待卡时结算', 'user')],
      revision: 1, createdAt: now, updatedAt: now,
    };
    this.orders.set(order.id, order);
    this.mutations.set(key, { fingerprint: requestFingerprint, value: order });
    return structuredClone(order);
  }

  list(principal: ComputePrincipal, status?: ComputeOrderStatus): ComputeApiPage<ComputeOrderV2> {
    this.expireReservations();
    const items = [...this.orders.values()].filter((order) => this.owns(principal, order) && (!status || order.status === status)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return { items: structuredClone(items), nextCursor: null };
  }

  get(principal: ComputePrincipal, id: string): ComputeOrderV2 {
    const order = this.orders.get(id);
    if (!order || !this.owns(principal, order)) throw new HttpError('订单不存在', 404, 'compute_order_not_found');
    return structuredClone(order);
  }

  decideQuote(principal: ComputePrincipal, id: string, decision: 'accept' | 'reject', idempotencyKey: string): ComputeOrderV2 {
    const order = this.getMutable(principal, id);
    if (order.status !== 'quoted' || !order.quote || new Date(order.quote.validUntil).getTime() <= Date.now()) throw new HttpError('报价已过期或不可处理', 409, 'quote_not_actionable');
    const key = this.key(principal, 'quote-decision', idempotencyKey);
    const requestFingerprint = fingerprint({ id, decision, quoteCreatedAt: order.quote.createdAt });
    const previous = this.mutations.get(key);
    if (previous) {
      if (previous.fingerprint !== requestFingerprint) throw new HttpError('幂等键已用于其他报价操作', 409, 'idempotency_conflict');
      return structuredClone(previous.value as ComputeOrderV2);
    }
    const next: ComputeOrderStatus = decision === 'accept' ? 'pending_settlement' : 'cancelled';
    this.transition(order, next, decision === 'accept' ? '用户已接受报价' : '用户已拒绝报价', 'user');
    this.mutations.set(key, { fingerprint: requestFingerprint, value: order });
    return structuredClone(order);
  }

  quote(principal: ComputePrincipal, id: string, input: { subtotalCardHoursMilli: number; discountCardHoursMilli: number; validUntil: string; termsVersion: string; terms: string; expectedRevision: number }, idempotencyKey: string): ComputeOrderV2 {
    const order = this.orders.get(id);
    if (!order || (principal.role !== 'super_admin' && order.tenantId !== principal.tenantId)) throw new HttpError('订单不存在', 404, 'compute_order_not_found');
    if (order.status !== 'pending_quote') throw new HttpError('订单当前不可报价', 409, 'order_not_quotable');
    if (order.revision !== input.expectedRevision) throw new HttpError('订单已被更新', 409, 'revision_conflict');
    if (!Number.isSafeInteger(input.subtotalCardHoursMilli) || input.subtotalCardHoursMilli < 1 || !Number.isSafeInteger(input.discountCardHoursMilli) || input.discountCardHoursMilli < 0 || input.discountCardHoursMilli > input.subtotalCardHoursMilli) throw new HttpError('报价卡时无效', 400, 'invalid_quote_amount');
    const validUntil = new Date(input.validUntil);
    if (Number.isNaN(validUntil.getTime()) || validUntil.getTime() <= Date.now() || validUntil.getTime() > Date.now() + 30 * 86400_000) throw new HttpError('报价有效期无效', 400, 'invalid_quote_expiry');
    if (!input.termsVersion?.trim() || input.terms?.trim().length < 5 || input.terms.length > 5000) throw new HttpError('报价条款无效', 400, 'invalid_quote_terms');
    const key = this.key(principal, 'admin-quote', idempotencyKey); const requestFingerprint = fingerprint({ id, input }); const previous = this.mutations.get(key);
    if (previous) { if (previous.fingerprint !== requestFingerprint) throw new HttpError('幂等键已用于其他报价', 409, 'idempotency_conflict'); return structuredClone(previous.value as ComputeOrderV2); }
    order.subtotalCardHoursMilli = input.subtotalCardHoursMilli; order.discountCardHoursMilli = input.discountCardHoursMilli; order.chargedCardHoursMilli = input.subtotalCardHoursMilli - input.discountCardHoursMilli;
    order.quote = { subtotalCardHoursMilli: input.subtotalCardHoursMilli, discountCardHoursMilli: input.discountCardHoursMilli, chargedCardHoursMilli: order.chargedCardHoursMilli, validUntil: validUntil.toISOString(), termsVersion: input.termsVersion.trim(), terms: input.terms.trim(), createdAt: new Date().toISOString() };
    this.transition(order, 'quoted', '运营已提交报价，等待用户确认', 'operator'); this.mutations.set(key, { fingerprint: requestFingerprint, value: order }); return structuredClone(order);
  }

  settle(principal: ComputePrincipal, id: string, idempotencyKey: string): ComputeOrderV2 {
    const order = this.getMutable(principal, id);
    if (order.status !== 'pending_settlement') throw new HttpError('订单当前不可结算', 409, 'order_not_settleable');
    this.ledger.charge(principal, order.chargedCardHoursMilli, idempotencyKey, `compute-order:${order.id}`);
    this.transition(order, 'settled', '卡时结算完成', 'system');
    return structuredClone(order);
  }

  cancel(principal: ComputePrincipal, id: string, idempotencyKey: string): ComputeOrderV2 {
    const order = this.getMutable(principal, id);
    const key = this.key(principal, 'cancel', idempotencyKey);
    const previous = this.mutations.get(key);
    if (previous) return structuredClone(previous.value as ComputeOrderV2);
    if (!['draft', 'reserved', 'pending_quote', 'quoted', 'pending_settlement'].includes(order.status)) throw new HttpError('订单当前不可取消', 409, 'order_not_cancellable');
    this.transition(order, 'cancelled', '订单已取消', 'user');
    this.mutations.set(key, { fingerprint: id, value: order });
    return structuredClone(order);
  }

  adminTransition(principal: ComputePrincipal, id: string, status: ComputeOrderStatus, expectedRevision: number, note: string): ComputeOrderV2 {
    const order = this.orders.get(id);
    if (!order || (principal.role !== 'super_admin' && order.tenantId !== principal.tenantId)) throw new HttpError('订单不存在', 404, 'compute_order_not_found');
    if (status === 'pending_settlement' && order.status === 'quoted') throw new HttpError('管理员不能代用户接受报价', 403, 'admin_quote_acceptance_forbidden');
    if (order.revision !== expectedRevision) throw new HttpError('订单已被更新', 409, 'revision_conflict');
    this.transition(order, status, note, 'operator');
    return structuredClone(order);
  }

  allForAdmin(principal: ComputePrincipal): ComputeOrderV2[] {
    return structuredClone([...this.orders.values()].filter((order) => principal.role === 'super_admin' || order.tenantId === principal.tenantId).map((order) => ({ ...order, contact: { name: maskName(order.contact.name), phone: maskPhone(order.contact.phone) } })));
  }

  private getMutable(principal: ComputePrincipal, id: string): ComputeOrderV2 {
    const order = this.orders.get(id);
    if (!order || !this.owns(principal, order)) throw new HttpError('订单不存在', 404, 'compute_order_not_found');
    return order;
  }

  private transition(order: ComputeOrderV2, status: ComputeOrderStatus, label: string, actor: ComputeStatusEvent['actor'], note: string | null = null): void {
    assertOrderTransition(order.status, status);
    order.status = status; order.revision += 1; order.updatedAt = new Date().toISOString(); order.events.push(event(status, label, actor, note));
  }

  private owns(principal: ComputePrincipal, order: ComputeOrderV2): boolean { return order.tenantId === principal.tenantId && order.userId === principal.userId; }
  private key(principal: ComputePrincipal, operation: string, idempotencyKey: string): string { return `${principal.tenantId}:${principal.userId}:${operation}:${idempotencyKey}`; }
  private expireReservations(): void { for (const reservation of this.reservations.values()) if (reservation.status === 'active' && new Date(reservation.expiresAt).getTime() <= Date.now()) reservation.status = 'expired'; }
}

function maskName(value: string): string { return value.length <= 1 ? '*' : `${value[0]}${'*'.repeat(Math.min(3, value.length - 1))}`; }
function maskPhone(value: string): string { return value.replace(/(\d{3})\d+(\d{2})/, '$1****$2'); }
