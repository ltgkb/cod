import type { ComputeOffer, ComputeQuoteInput, ComputeRequestInput } from '@cod/contracts';
import { HttpError } from './errors.js';

export type { ComputeRequest, ComputeRequestInput, ComputeRequestKind } from '@cod/contracts';

export type { ComputeOffer } from '@cod/contracts';

const pytorchImage = { id: 'pytorch-2-9', name: 'PyTorch', frameworkVersion: '2.9.0', pythonVersion: '3.12', cudaVersion: '12.8' } as const;
const tensorflowImage = { id: 'tensorflow-2-17', name: 'TensorFlow', frameworkVersion: '2.17.0', pythonVersion: '3.11', cudaVersion: '12.3' } as const;

export const computeOfferCatalog: readonly ComputeOffer[] = [
  {
    id: 'cod-h100-pcie-card-hour', title: 'H100 80GB 单卡算力', gpuModel: 'NVIDIA H100 PCIe 80GB', gpuMemoryGb: 80, gpuCount: 1,
    region: '国内合规机房 · 成交前确认', provider: 'COD 机房直供', priceCents: 1880, priceUnit: 'card-hour', minimumUnits: 10,
    delivery: '人工确认后开通 SSH / 容器', network: '公网带宽与存储按需报价', availability: 'ready', verified: true,
    inventoryCards: 12, tags: ['训练', '微调', '推理', '按卡时'],
    specs: { cpuModel: 'Intel Xeon Gold', cpuCores: 24, memoryGb: 120, systemDiskGb: 50, dataDiskGb: 100, expandableDataDiskGb: 2_000, driverVersion: '≥ 570', cudaMaxVersion: '≤ 12.8' },
    images: [pytorchImage, tensorflowImage], supportedPeriods: ['hour', 'day', 'month'], fulfillmentMode: 'manual-confirmation',
  },
  {
    id: 'cod-h100-sxm-server-hour', title: 'H100 SXM 8 卡整机', gpuModel: 'NVIDIA H100 SXM 80GB', gpuMemoryGb: 80, gpuCount: 8,
    region: '国内合规机房 · 成交前确认', provider: 'COD 机房直供', priceCents: 13800, priceUnit: 'server-hour', minimumUnits: 4,
    delivery: '裸金属整机 · 专属环境', network: '高速互联配置成交前确认', availability: 'limited', verified: true,
    inventoryCards: 8, tags: ['8 卡整机', '大模型训练', '裸金属'],
    specs: { cpuModel: 'Dual Intel Xeon Platinum', cpuCores: 96, memoryGb: 1_024, systemDiskGb: 200, dataDiskGb: 3_840, expandableDataDiskGb: 15_360, driverVersion: '≥ 570', cudaMaxVersion: '≤ 12.8' },
    images: [pytorchImage], supportedPeriods: ['hour', 'day', 'month'], fulfillmentMode: 'manual-confirmation',
  },
  {
    id: 'cod-h100-monthly', title: 'H100 长租 / 包月', gpuModel: 'NVIDIA H100 80GB', gpuMemoryGb: 80, gpuCount: 1,
    region: 'COD 合作机房', provider: 'COD 企业算力', priceCents: null, priceUnit: 'quote', minimumUnits: 1,
    delivery: '月租、季度与年度框架协议', network: '支持专线、固定公网 IP 与独立存储', availability: 'quote', verified: true,
    inventoryCards: null, tags: ['包月', '长期锁卡', '企业 SLA'],
    specs: { cpuModel: '成交前确认', cpuCores: 0, memoryGb: 0, systemDiskGb: 0, dataDiskGb: 0, expandableDataDiskGb: 0, driverVersion: '成交前确认', cudaMaxVersion: '成交前确认' },
    images: [pytorchImage, tensorflowImage], supportedPeriods: ['month'], fulfillmentMode: 'manual-confirmation',
  },
] as const;

const clean = (value: unknown, max: number) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const optionalClean = (value: unknown, max: number) => clean(value, max) || null;
const optionalNumber = (value: unknown): number | null => value === null || value === undefined || value === '' ? null : typeof value === 'number' ? value : Number.NaN;
const contactPattern = /^(?:[0-9+()\-\s]{6,40}|[A-Za-z][A-Za-z0-9_-]{5,39})$/;

export function validateComputeRequest(raw: unknown): ComputeRequestInput {
  if (!raw || typeof raw !== 'object') throw new HttpError('Compute request is invalid', 400, 'invalid_compute_request');
  const value = raw as Record<string, unknown>;
  const kind = value.kind;
  if (kind !== 'rental' && kind !== 'supply' && kind !== 'installment' && kind !== 'hosting') throw new HttpError('Compute request kind is invalid', 400, 'invalid_compute_request_kind');
  const offerId = clean(value.offerId, 100) || null;
  const offer=offerId?computeOfferCatalog.find((item)=>item.id===offerId):undefined;
  if (kind === 'rental' && !offer) throw new HttpError('Compute offer is invalid', 400, 'invalid_compute_offer');
  const imageId=clean(value.imageId,100)||offer?.images[0]?.id||null;
  if(kind==='rental'&&(!imageId||!offer?.images.some((image)=>image.id===imageId)))throw new HttpError('Compute image is invalid',400,'invalid_compute_image');
  const company = clean(value.company, 120);
  const contactName = clean(value.contactName, 60);
  const contactPhone = clean(value.contactPhone, 40);
  const city = clean(value.city, 80);
  const gpuModel = clean(value.gpuModel, 100);
  const requirements = clean(value.requirements, 2000);
  const quantity = typeof value.quantity === 'number' ? value.quantity : Number.NaN;
  const durationHours = optionalNumber(value.durationHours);
  const termMonths = optionalNumber(value.termMonths);
  const hostingPeriodMonths = optionalNumber(value.hostingPeriodMonths);
  const rackUnits = optionalNumber(value.rackUnits);
  const powerKilowatts = optionalNumber(value.powerKilowatts);
  const networkMbps = optionalNumber(value.networkMbps);
  const availabilityNotes = optionalClean(value.availabilityNotes, 1000);
  const settlementPreference = optionalClean(value.settlementPreference, 500);
  const hostingRequirements = optionalClean(value.hostingRequirements, 2000);
  if (company.length < 2 || !contactName || !contactPattern.test(contactPhone) || !city || !gpuModel) throw new HttpError('Company and contact details are incomplete', 400, 'invalid_compute_contact');
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 4096) throw new HttpError('GPU quantity is invalid', 400, 'invalid_compute_quantity');
  if (kind === 'rental' && (!Number.isInteger(durationHours) || Number(durationHours) < 1 || Number(durationHours) > 1_000_000)) throw new HttpError('Rental duration is invalid', 400, 'invalid_compute_duration');
  if (kind === 'installment' && ![12, 24, 36].includes(Number(termMonths))) throw new HttpError('Installment term is invalid', 400, 'invalid_compute_term');
  if (kind === 'hosting') {
    if (!Number.isInteger(hostingPeriodMonths) || Number(hostingPeriodMonths) < 1 || Number(hostingPeriodMonths) > 120) throw new HttpError('Hosting period is invalid', 400, 'invalid_compute_hosting_period');
    if (rackUnits !== null && (!Number.isInteger(rackUnits) || rackUnits < 1 || rackUnits > 256)) throw new HttpError('Rack requirement is invalid', 400, 'invalid_compute_rack_units');
    if (powerKilowatts !== null && (!Number.isFinite(powerKilowatts) || powerKilowatts <= 0 || powerKilowatts > 1000)) throw new HttpError('Power requirement is invalid', 400, 'invalid_compute_power');
    if (networkMbps !== null && (!Number.isInteger(networkMbps) || networkMbps < 1 || networkMbps > 1_000_000)) throw new HttpError('Network requirement is invalid', 400, 'invalid_compute_network');
    if (rackUnits === null && powerKilowatts === null && networkMbps === null && !availabilityNotes) throw new HttpError('Hosting capacity or availability details are required', 400, 'invalid_compute_hosting_capacity');
    if (!settlementPreference || !hostingRequirements) throw new HttpError('Hosting settlement and service requirements are required', 400, 'invalid_compute_hosting_terms');
  }
  return {
    kind, company, contactName, contactPhone, city, gpuModel, quantity, requirements,
    offerId: kind === 'rental' ? offerId : null,
    imageId: kind === 'rental' ? imageId : null,
    durationHours: kind === 'rental' ? durationHours : null,
    termMonths: kind === 'installment' ? termMonths : null,
    hostingPeriodMonths: kind === 'hosting' ? hostingPeriodMonths : null,
    rackUnits: kind === 'hosting' ? rackUnits : null,
    powerKilowatts: kind === 'hosting' ? powerKilowatts : null,
    networkMbps: kind === 'hosting' ? networkMbps : null,
    availabilityNotes: kind === 'hosting' ? availabilityNotes : null,
    settlementPreference: kind === 'hosting' ? settlementPreference : null,
    hostingRequirements: kind === 'hosting' ? hostingRequirements : null,
  };
}

export function validateComputeQuote(raw: unknown, now = new Date()): ComputeQuoteInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new HttpError('Compute quote is invalid', 400, 'invalid_compute_quote');
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).some((key) => !['amountCents', 'cardHoursMilli', 'validUntil', 'terms'].includes(key))) throw new HttpError('Compute quote is invalid', 400, 'invalid_compute_quote');
  const amountCents = value.amountCents;
  const cardHoursMilli = value.cardHoursMilli === undefined || value.cardHoursMilli === null ? null : value.cardHoursMilli;
  const validUntil = typeof value.validUntil === 'string' ? value.validUntil : '';
  const terms = clean(value.terms, 2000);
  const validUntilDate = new Date(validUntil);
  if (!Number.isSafeInteger(amountCents) || Number(amountCents) < 100 || Number(amountCents) > 1_000_000_000) throw new HttpError('Quote amount is invalid', 400, 'invalid_compute_quote_amount');
  if (cardHoursMilli !== null && (!Number.isSafeInteger(cardHoursMilli) || Number(cardHoursMilli) < 1 || Number(cardHoursMilli) > 1_000_000_000_000)) throw new HttpError('Quote card-hours are invalid', 400, 'invalid_compute_quote_card_hours');
  if (!validUntil || Number.isNaN(validUntilDate.getTime()) || validUntilDate.toISOString() !== validUntil || validUntilDate.getTime() <= now.getTime()) throw new HttpError('Quote expiry is invalid', 400, 'invalid_compute_quote_expiry');
  if (terms.length < 2) throw new HttpError('Quote terms are required', 400, 'invalid_compute_quote_terms');
  return { amountCents: Number(amountCents), cardHoursMilli: cardHoursMilli === null ? null : Number(cardHoursMilli), validUntil, terms };
}
