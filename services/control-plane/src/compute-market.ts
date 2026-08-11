import { HttpError } from './errors.js';

export type ComputeRequestKind = 'rental' | 'supply' | 'installment';

export interface ComputeOffer {
  id: string;
  title: string;
  gpuModel: string;
  gpuMemoryGb: number;
  gpuCount: number;
  region: string;
  provider: string;
  priceCents: number | null;
  priceUnit: 'card-hour' | 'server-hour' | 'month' | 'quote';
  minimumUnits: number;
  delivery: string;
  network: string;
  availability: 'ready' | 'limited' | 'quote';
  verified: boolean;
  tags: string[];
}

export interface ComputeRequestInput {
  kind: ComputeRequestKind;
  offerId?: string | null;
  company: string;
  contactName: string;
  contactPhone: string;
  city: string;
  gpuModel: string;
  quantity: number;
  durationHours?: number | null;
  termMonths?: number | null;
  requirements: string;
}

export interface ComputeRequest extends ComputeRequestInput {
  id: string;
  email: string;
  offerId: string | null;
  durationHours: number | null;
  termMonths: number | null;
  status: 'submitted' | 'contacting' | 'quoted' | 'closed';
  createdAt: string;
  updatedAt: string;
}

export const computeOfferCatalog: readonly ComputeOffer[] = [
  {
    id: 'cod-h100-pcie-card-hour', title: 'H100 80GB 单卡算力', gpuModel: 'NVIDIA H100 PCIe 80GB', gpuMemoryGb: 80, gpuCount: 1,
    region: '国内合规机房 · 成交前确认', provider: 'COD 机房直供', priceCents: 1880, priceUnit: 'card-hour', minimumUnits: 10,
    delivery: '人工确认后开通 SSH / 容器', network: '公网带宽与存储按需报价', availability: 'ready', verified: true,
    tags: ['训练', '微调', '推理', '按卡时'],
  },
  {
    id: 'cod-h100-sxm-server-hour', title: 'H100 SXM 8 卡整机', gpuModel: 'NVIDIA H100 SXM 80GB', gpuMemoryGb: 80, gpuCount: 8,
    region: '国内合规机房 · 成交前确认', provider: 'COD 机房直供', priceCents: 13800, priceUnit: 'server-hour', minimumUnits: 4,
    delivery: '裸金属整机 · 专属环境', network: '高速互联配置成交前确认', availability: 'limited', verified: true,
    tags: ['8 卡整机', '大模型训练', '裸金属'],
  },
  {
    id: 'cod-h100-monthly', title: 'H100 长租 / 包月', gpuModel: 'NVIDIA H100 80GB', gpuMemoryGb: 80, gpuCount: 1,
    region: 'COD 合作机房', provider: 'COD 企业算力', priceCents: null, priceUnit: 'quote', minimumUnits: 1,
    delivery: '月租、季度与年度框架协议', network: '支持专线、固定公网 IP 与独立存储', availability: 'quote', verified: true,
    tags: ['包月', '长期锁卡', '企业 SLA'],
  },
] as const;

const clean = (value: unknown, max: number) => String(value ?? '').trim().slice(0, max);
const contactPattern = /^(?:[0-9+()\-\s]{6,40}|[A-Za-z][A-Za-z0-9_-]{5,39})$/;

export function validateComputeRequest(raw: unknown): ComputeRequestInput {
  if (!raw || typeof raw !== 'object') throw new HttpError('Compute request is invalid', 400, 'invalid_compute_request');
  const value = raw as Record<string, unknown>;
  const kind = value.kind;
  if (kind !== 'rental' && kind !== 'supply' && kind !== 'installment') throw new HttpError('Compute request kind is invalid', 400, 'invalid_compute_request_kind');
  const offerId = clean(value.offerId, 100) || null;
  if (kind === 'rental' && (!offerId || !computeOfferCatalog.some((offer) => offer.id === offerId))) throw new HttpError('Compute offer is invalid', 400, 'invalid_compute_offer');
  const company = clean(value.company, 120);
  const contactName = clean(value.contactName, 60);
  const contactPhone = clean(value.contactPhone, 40);
  const city = clean(value.city, 80);
  const gpuModel = clean(value.gpuModel, 100);
  const requirements = clean(value.requirements, 2000);
  const quantity = Number(value.quantity);
  const durationHours = value.durationHours === null || value.durationHours === undefined || value.durationHours === '' ? null : Number(value.durationHours);
  const termMonths = value.termMonths === null || value.termMonths === undefined || value.termMonths === '' ? null : Number(value.termMonths);
  if (company.length < 2 || !contactName || !contactPattern.test(contactPhone) || !city || !gpuModel) throw new HttpError('Company and contact details are incomplete', 400, 'invalid_compute_contact');
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 4096) throw new HttpError('GPU quantity is invalid', 400, 'invalid_compute_quantity');
  if (kind === 'rental' && (!Number.isInteger(durationHours) || Number(durationHours) < 1 || Number(durationHours) > 1_000_000)) throw new HttpError('Rental duration is invalid', 400, 'invalid_compute_duration');
  if (kind === 'installment' && ![12, 24, 36].includes(Number(termMonths))) throw new HttpError('Installment term is invalid', 400, 'invalid_compute_term');
  return { kind, offerId, company, contactName, contactPhone, city, gpuModel, quantity, durationHours, termMonths, requirements };
}
