import type {
  CreateComputeOrderInput,
  HostingApplicationDraft,
  HostingApplicationStatus,
  HostedDeviceStatus,
  ComputeOfferV2,
  ComputeOrderStatus,
  ComputePrincipal,
} from '@cod/contracts/compute-market-v2';
import { HttpError } from '../errors.js';

const phonePattern = /^[+\d][\d\s-]{5,24}$/;
const identifierPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;

export function requirePrincipal(principal: ComputePrincipal | null): ComputePrincipal {
  if (!principal) throw new HttpError('请先登录后继续', 401, 'authentication_required');
  return principal;
}

export function requireAdmin(principal: ComputePrincipal | null): ComputePrincipal {
  const authenticated = requirePrincipal(principal);
  if (authenticated.role !== 'compute_operator' && authenticated.role !== 'super_admin') {
    throw new HttpError('无算力市场运营权限', 403, 'compute_admin_forbidden');
  }
  return authenticated;
}

export function requireIdempotencyKey(value: string | null | undefined): string {
  const key = value?.trim() ?? '';
  if (!key || key.length > 200 || !identifierPattern.test(key)) {
    throw new HttpError('幂等键无效', 400, 'invalid_idempotency_key');
  }
  return key;
}

export function requireExpectedRevision(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 1) {
    throw new HttpError('缺少有效的数据版本', 400, 'invalid_expected_revision');
  }
  return Number(value);
}

export function requireReason(value: unknown): string {
  const reason = typeof value === 'string' ? value.trim() : '';
  if (reason.length < 4 || reason.length > 500) {
    throw new HttpError('请填写 4–500 字的操作原因', 400, 'invalid_operation_reason');
  }
  return reason;
}

export function validateOrderInput(input: CreateComputeOrderInput): CreateComputeOrderInput {
  if (!input || typeof input !== 'object') throw new HttpError('订单参数无效', 400, 'invalid_order');
  if (!identifierPattern.test(input.skuId ?? '') || !identifierPattern.test(input.imageId ?? '')) {
    throw new HttpError('SKU 或镜像无效', 400, 'invalid_order_selection');
  }
  if (!Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > 128) {
    throw new HttpError('数量无效', 400, 'invalid_quantity');
  }
  if (!Number.isInteger(input.availableDurationHours) || input.availableDurationHours < 1 || input.availableDurationHours > 36_500) {
    throw new HttpError('可用时长（小时）无效', 400, 'invalid_duration');
  }
  requireExpectedRevision(input.inventoryRevision);
  const contactName = input.contact?.name?.trim() ?? '';
  const contactPhone = input.contact?.phone?.trim() ?? '';
  if (contactName.length < 2 || contactName.length > 80) throw new HttpError('联系人无效', 400, 'invalid_contact_name');
  if (!phonePattern.test(contactPhone)) throw new HttpError('联系电话无效', 400, 'invalid_contact_phone');
  if (input.startsAt !== null && Number.isNaN(new Date(input.startsAt).getTime())) throw new HttpError('开始时间无效', 400, 'invalid_starts_at');
  if (!input.acceptedTermsVersion?.trim()) throw new HttpError('请确认服务条款', 400, 'terms_not_accepted');
  return {
    ...input,
    skuId: input.skuId.trim(),
    imageId: input.imageId.trim(),
    contact: { name: contactName, phone: contactPhone },
    acceptedTermsVersion: input.acceptedTermsVersion.trim(),
  };
}

export function validateHostingDraft(input: HostingApplicationDraft, submitting = false): HostingApplicationDraft {
  if (!input || typeof input !== 'object') throw new HttpError('托管申请无效', 400, 'invalid_hosting_application');
  const normalized: HostingApplicationDraft = {
    ...input,
    contactName: input.contactName?.trim() ?? '',
    contactPhone: input.contactPhone?.trim() ?? '',
    city: input.city?.trim() ?? '',
    networkRequirement: input.networkRequirement?.trim() ?? '',
    slaRequirement: input.slaRequirement?.trim() ?? '',
    settlementPreference: input.settlementPreference?.trim() ?? '',
    devices: Array.isArray(input.devices) ? input.devices.map((device) => ({
      ...device,
      brand: device.brand?.trim() ?? '',
      model: device.model?.trim() ?? '',
      gpuModel: device.gpuModel?.trim() ?? '',
      serialLastFour: device.serialLastFour?.trim().toUpperCase() ?? '',
      machineSpecs: device.machineSpecs?.trim() ?? '',
    })) : [],
  };
  if (normalized.contactName && (normalized.contactName.length < 2 || normalized.contactName.length > 80)) throw new HttpError('联系人无效', 400, 'invalid_contact_name');
  if (normalized.contactPhone && !phonePattern.test(normalized.contactPhone)) throw new HttpError('联系电话无效', 400, 'invalid_contact_phone');
  if (normalized.devices.length > 100) throw new HttpError('单次最多登记 100 台设备', 400, 'too_many_devices');
  for (const device of normalized.devices) {
    if (!Number.isInteger(device.gpuCount) || device.gpuCount < 1 || device.gpuCount > 64) throw new HttpError('GPU 数量无效', 400, 'invalid_gpu_count');
    if (device.serialLastFour && !/^[A-Z0-9]{4}$/.test(device.serialLastFour)) throw new HttpError('序列号后四位无效', 400, 'invalid_serial_suffix');
  }
  if (submitting) {
    if (!normalized.contactName || !normalized.contactPhone || !normalized.city) throw new HttpError('请完善主体与联系方式', 400, 'hosting_contact_incomplete');
    if (!normalized.devices.length || normalized.devices.some((device) => !device.brand || !device.model || !device.gpuModel || !device.serialLastFour || !device.machineSpecs)) throw new HttpError('请完善设备清单', 400, 'hosting_devices_incomplete');
    if (!normalized.rackUnits || !normalized.powerWatts || !normalized.hostingMonths || !normalized.availableFrom) throw new HttpError('请完善机房需求', 400, 'hosting_requirements_incomplete');
    if (!normalized.responsibilityAccepted || !normalized.privacyAccepted) throw new HttpError('请确认责任边界与隐私说明', 400, 'hosting_consents_required');
  }
  return normalized;
}

export function validateOffer(offer: ComputeOfferV2): ComputeOfferV2 {
  if (!identifierPattern.test(offer.id) || !offer.slug?.trim() || !offer.title?.trim()) throw new HttpError('商品标识或标题无效', 400, 'invalid_offer');
  if (!offer.media.length || offer.media.some((media) => !media.url || !media.alt)) throw new HttpError('商品素材及替代文本不能为空', 400, 'offer_media_required');
  if (!offer.skus.length) throw new HttpError('商品至少需要一个 SKU', 400, 'offer_sku_required');
  for (const sku of offer.skus) {
    if (sku.offerId !== offer.id || !Number.isInteger(sku.minimumUnits) || sku.minimumUnits < 1 || (sku.maximumUnits !== null && sku.maximumUnits < sku.minimumUnits)) throw new HttpError('SKU 约束无效', 400, 'invalid_sku');
    if ((sku as { period?: unknown }).period !== 'hour') throw new HttpError('租赁 SKU 仅支持按小时计价', 400, 'sku_period_must_be_hour');
    if (offer.purchaseMode !== 'quote' && (!Number.isInteger(sku.priceCardHoursMilli) || Number(sku.priceCardHoursMilli) < 1)) throw new HttpError('可购买商品必须配置卡时价格', 400, 'sku_price_required');
    if (!sku.imageOptions.length) throw new HttpError('SKU 至少需要一个镜像', 400, 'sku_image_required');
  }
  return offer;
}

const orderTransitions: Record<ComputeOrderStatus, readonly ComputeOrderStatus[]> = {
  draft: ['reserved', 'pending_quote', 'cancelled'],
  reserved: ['pending_settlement', 'cancelled'],
  pending_quote: ['quoted', 'cancelled'],
  quoted: ['pending_settlement', 'cancelled'],
  pending_settlement: ['settled', 'cancelled'],
  settled: ['provisioning', 'action_required', 'refund_pending'],
  provisioning: ['running', 'action_required', 'refund_pending'],
  running: ['completed', 'action_required'],
  action_required: ['settled', 'provisioning', 'running', 'cancelled', 'refund_pending'],
  completed: [],
  cancelled: [],
  refund_pending: ['refunded'],
  refunded: [],
};

const hostingTransitions: Record<HostingApplicationStatus, readonly HostingApplicationStatus[]> = {
  draft: ['submitted', 'cancelled'],
  submitted: ['reviewing', 'cancelled'],
  reviewing: ['site_survey', 'rejected', 'cancelled'],
  site_survey: ['quoted', 'rejected', 'cancelled'],
  quoted: ['contract_pending', 'rejected', 'cancelled'],
  contract_pending: ['inbound_pending', 'cancelled'],
  inbound_pending: ['deploying', 'cancelled'],
  deploying: ['running', 'action_required'],
  running: ['action_required', 'offboarding'],
  action_required: ['running', 'offboarding'],
  offboarding: ['completed'],
  completed: [],
  rejected: [],
  cancelled: [],
};

const deviceTransitions: Record<HostedDeviceStatus, readonly HostedDeviceStatus[]> = {
  pending_review: ['deploying', 'retired'],
  deploying: ['running', 'action_required', 'maintenance'],
  running: ['action_required', 'maintenance', 'offline', 'retired'],
  action_required: ['running', 'maintenance', 'offline', 'retired'],
  maintenance: ['running', 'offline', 'retired'],
  offline: ['running', 'maintenance', 'retired'],
  retired: [],
};

function assertTransition<T extends string>(from: T, to: T, transitions: Record<T, readonly T[]>, code: string): void {
  if (from === to || !transitions[from]?.includes(to)) throw new HttpError(`不允许从 ${from} 变更为 ${to}`, 409, code);
}

export const assertOrderTransition = (from: ComputeOrderStatus, to: ComputeOrderStatus): void => assertTransition(from, to, orderTransitions, 'invalid_order_transition');
export const assertHostingTransition = (from: HostingApplicationStatus, to: HostingApplicationStatus): void => assertTransition(from, to, hostingTransitions, 'invalid_hosting_transition');
export const assertDeviceTransition = (from: HostedDeviceStatus, to: HostedDeviceStatus): void => assertTransition(from, to, deviceTransitions, 'invalid_device_transition');
