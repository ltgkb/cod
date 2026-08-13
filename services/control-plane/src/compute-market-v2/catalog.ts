import type {
  ComputeCapabilities,
  ComputeHomePayload,
  ComputeAdminOfferRecord,
  ComputeContentRecord,
  ComputeNewsEntry,
  ComputeOfferFilters,
  ComputeOfferV2,
  ComputeApiPage,
} from '@cod/contracts/compute-market-v2';
import { HttpError } from '../errors.js';
import { validateOffer } from './validation.js';

export const defaultComputeCapabilities: ComputeCapabilities = {
  enabled: false, instantPurchase: false, reservationPurchase: false, hosting: false, devices: false, assets: false,
  cardHourTrades: false, referrals: false, news: false, rankings: false, hostedSettlements: false, admin: false,
  services: { verification: false, procurement: false, coupons: false, addresses: false, onlineSupport: false, humanSupport: false },
};

function priceOf(offer: ComputeOfferV2): number {
  return Math.min(...offer.skus.map((sku) => sku.priceCardHoursMilli ?? Number.MAX_SAFE_INTEGER));
}

export class ComputeCatalogService {
  private readonly offers = new Map<string, ComputeOfferV2>();
  private readonly newsEntries = new Map<string, ComputeNewsEntry>();
  private readonly offerRevisions = new Map<string, number>();
  private readonly contentRecords = new Map<string, ComputeContentRecord>();

  constructor(private readonly capabilities: ComputeCapabilities = defaultComputeCapabilities, offers: ComputeOfferV2[] = [], news: ComputeNewsEntry[] = []) {
    for (const offer of offers) { this.offers.set(offer.id, structuredClone(validateOffer(offer))); this.offerRevisions.set(offer.id, 1); }
    for (const entry of news) { this.newsEntries.set(entry.id, structuredClone(entry)); this.contentRecords.set(entry.id, { entry: structuredClone(entry), status: 'published', scheduledAt: null, revision: 1 }); }
  }

  getCapabilities(isAdmin = false): ComputeCapabilities {
    return { ...structuredClone(this.capabilities), admin: isAdmin && this.capabilities.admin };
  }

  home(banner: ComputeHomePayload['banner'] = null): ComputeHomePayload {
    const purchasing = this.capabilities.instantPurchase || this.capabilities.reservationPurchase;
    return {
      banner,
      quickActions: [
        'offers',
        ...(this.capabilities.hosting ? ['hosting' as const] : []),
        ...(purchasing ? ['orders' as const] : []),
        ...(this.capabilities.services.onlineSupport ? ['support' as const] : []),
      ],
      featuredOffers: this.listOffers({ sort: 'popular' }).items.slice(0, 8),
      news: this.capabilities.news ? this.listNews().items.slice(0, 3) : [],
    };
  }

  listOffers(filters: ComputeOfferFilters): ComputeApiPage<ComputeOfferV2> {
    let items = [...this.offers.values()].filter((offer) => offer.status === 'published' || offer.status === 'sold_out');
    const textMatches = (value: string, query?: string): boolean => !query || value.toLowerCase().includes(query.toLowerCase());
    if (filters.gpuSeries) items = items.filter((offer) => textMatches(offer.gpu.model, filters.gpuSeries));
    if (filters.gpuModel) items = items.filter((offer) => textMatches(offer.gpu.model, filters.gpuModel));
    if (filters.memoryGb) items = items.filter((offer) => offer.gpu.memoryGb >= Number(filters.memoryGb));
    if (filters.useCase) items = items.filter((offer) => offer.tags.some((tag) => textMatches(tag, filters.useCase)));
    if (filters.deliveryMode) items = items.filter((offer) => offer.skus.some((sku) => sku.deliveryMode === filters.deliveryMode));
    if (filters.region) items = items.filter((offer) => textMatches(offer.regionLabel, filters.region));
    if (filters.cuda) items = items.filter((offer) => textMatches(offer.specs.cudaVersion, filters.cuda));
    if (filters.period) items = items.filter((offer) => offer.skus.some((sku) => sku.period === filters.period));
    if (filters.availability) items = items.filter((offer) => offer.availability.level === filters.availability);
    if (filters.sort === 'price_asc') items.sort((a, b) => priceOf(a) - priceOf(b));
    else if (filters.sort === 'price_desc') items.sort((a, b) => priceOf(b) - priceOf(a));
    else if (filters.sort === 'memory') items.sort((a, b) => b.gpu.memoryGb - a.gpu.memoryGb);
    else items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return { items: structuredClone(items), nextCursor: null };
  }

  offer(idOrSlug: string): ComputeOfferV2 {
    const offer = this.offers.get(idOrSlug) ?? [...this.offers.values()].find((entry) => entry.slug === idOrSlug);
    if (!offer || (offer.status !== 'published' && offer.status !== 'sold_out')) throw new HttpError('商品不存在或已下架', 404, 'compute_offer_not_found');
    return structuredClone(offer);
  }

  sku(skuId: string) {
    for (const offer of this.offers.values()) {
      const sku = offer.skus.find((entry) => entry.id === skuId);
      if (sku) return { offer: structuredClone(offer), sku: structuredClone(sku) };
    }
    throw new HttpError('SKU 不存在', 404, 'compute_sku_not_found');
  }

  listNews(): ComputeApiPage<ComputeNewsEntry> {
    if (!this.capabilities.news) return { items: [], nextCursor: null };
    return { items: structuredClone([...this.newsEntries.values()].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))), nextCursor: null };
  }

  news(slug: string): ComputeNewsEntry {
    const entry = [...this.newsEntries.values()].find((item) => item.slug === slug);
    if (!entry || !this.capabilities.news) throw new HttpError('资讯不存在', 404, 'compute_news_not_found');
    return structuredClone(entry);
  }

  adminOffers(): ComputeApiPage<ComputeAdminOfferRecord> {
    return { items: structuredClone([...this.offers.values()].map((offer) => ({ offer, revision: this.offerRevisions.get(offer.id) ?? 1 }))), nextCursor: null };
  }

  saveOffer(offer: ComputeOfferV2, expectedRevision: number | null): ComputeAdminOfferRecord {
    const validated = structuredClone(validateOffer(offer)); const current = this.offers.get(offer.id); const revision = this.offerRevisions.get(offer.id) ?? 0;
    if (current && expectedRevision !== revision) throw new HttpError('商品已被更新', 409, 'revision_conflict');
    if (!current && expectedRevision !== null) throw new HttpError('新商品不能携带数据版本', 400, 'unexpected_revision');
    validated.updatedAt = new Date().toISOString(); this.offers.set(validated.id, validated); this.offerRevisions.set(validated.id, revision + 1);
    return { offer: structuredClone(validated), revision: revision + 1 };
  }

  adminContent(): ComputeApiPage<ComputeContentRecord> { return { items: structuredClone([...this.contentRecords.values()]), nextCursor: null }; }

  saveContent(record: ComputeContentRecord, expectedRevision: number | null): ComputeContentRecord {
    const current = this.contentRecords.get(record.entry.id); const revision = current?.revision ?? 0;
    if (current && expectedRevision !== revision) throw new HttpError('内容已被更新', 409, 'revision_conflict');
    if (!current && expectedRevision !== null) throw new HttpError('新内容不能携带数据版本', 400, 'unexpected_revision');
    if (!record.entry.title?.trim() || !record.entry.slug?.trim() || !record.entry.summary?.trim()) throw new HttpError('请完善内容标题、路径与摘要', 400, 'invalid_content');
    const entry = { ...record.entry, sanitizedHtml: `<p>${escapeHtml(record.entry.sanitizedHtml || record.entry.summary)}</p>` };
    const saved = { entry, status: record.status, scheduledAt: record.scheduledAt, revision: revision + 1 } satisfies ComputeContentRecord;
    this.contentRecords.set(entry.id, saved);
    if (saved.status === 'published') this.newsEntries.set(entry.id, entry); else this.newsEntries.delete(entry.id);
    return structuredClone(saved);
  }
}

function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!); }
