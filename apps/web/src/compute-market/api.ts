import type {
  CardHourLedgerEntry, ComputeAdminDashboard, ComputeAdminOfferRecord, ComputeApiPage, ComputeAssetsSummary, ComputeAuditEvent, ComputeCapabilities, ComputeContentRecord, ComputeHomePayload, ComputeInventoryPool,
  ComputeNewsEntry, ComputeOfferFilters, ComputeOfferV2, ComputeOrderV2, ComputePeriod, ComputeReferralPayload,
  ComputeRankingsPayload, ComputeTicket, CreateComputeOrderInput, HostedDeviceStatus, HostedDeviceV2,
  HostingApplicationDraft, HostingApplicationV2,
} from '@cod/contracts/compute-market-v2';

export class ComputeApiError extends Error {
  constructor(message: string, readonly status: number, readonly code: string, readonly fieldErrors?: Record<string, string>) { super(message); }
}

export interface ComputeApiClientOptions {
  baseUrl?: string;
  token?: string;
  fetcher?: typeof fetch;
}

function clientId(): string {
  return typeof globalThis.crypto?.randomUUID === 'function' ? globalThis.crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function formatCardHours(milli: number | null | undefined): string {
  if (milli === null || milli === undefined) return '询价';
  return new Intl.NumberFormat('zh-CN', { minimumFractionDigits: milli % 1000 === 0 ? 0 : 2, maximumFractionDigits: 3 }).format(milli / 1000);
}

export function periodLabel(period: ComputePeriod): string { return { hour: '小时' }[period]; }

export function createComputeApi(options: ComputeApiClientOptions = {}) {
  const baseUrl = (options.baseUrl ?? '').replace(/\/$/, '');
  const fetcher = options.fetcher ?? fetch;

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    let response: Response;
    try {
      response = await fetcher(`${baseUrl}${path}`, {
        ...init,
        headers: { 'content-type': 'application/json', ...(options.token ? { authorization: `Bearer ${options.token}` } : {}), ...init.headers },
      });
    } catch {
      throw new ComputeApiError('网络连接不可用，请稍后重试', 0, 'offline');
    }
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { error?: string; code?: string; message?: string; fieldErrors?: Record<string, string> };
      throw new ComputeApiError(body.message ?? mapComputeError(body.code ?? body.error, response.status), response.status, body.code ?? body.error ?? 'request_failed', body.fieldErrors);
    }
    return response.json() as Promise<T>;
  }

  const queryString = (filters: ComputeOfferFilters): string => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) if (value !== undefined && value !== '') query.set(key, String(value));
    return query.size ? `?${query}` : '';
  };

  return {
    capabilities: (signal?: AbortSignal) => request<ComputeCapabilities>('/api/compute/v2/capabilities', { signal }),
    home: (signal?: AbortSignal) => request<ComputeHomePayload>('/api/compute/v2/home', { signal }),
    offers: (filters: ComputeOfferFilters = {}, signal?: AbortSignal) => request<ComputeApiPage<ComputeOfferV2>>(`/api/compute/v2/offers${queryString(filters)}`, { signal }),
    offer: (id: string, signal?: AbortSignal) => request<ComputeOfferV2>(`/api/compute/v2/offers/${encodeURIComponent(id)}`, { signal }),
    createOrder: (input: CreateComputeOrderInput, idempotencyKey = clientId(), signal?: AbortSignal) => request<ComputeOrderV2>('/api/compute/v2/orders', { method: 'POST', headers: { 'idempotency-key': idempotencyKey }, body: JSON.stringify(input), signal }),
    orders: (status?: string, signal?: AbortSignal) => request<ComputeApiPage<ComputeOrderV2>>(`/api/compute/v2/orders${status ? `?status=${encodeURIComponent(status)}` : ''}`, { signal }),
    order: (id: string, signal?: AbortSignal) => request<ComputeOrderV2>(`/api/compute/v2/orders/${encodeURIComponent(id)}`, { signal }),
    cancelOrder: (id: string, idempotencyKey = clientId(), signal?: AbortSignal) => request<ComputeOrderV2>(`/api/compute/v2/orders/${encodeURIComponent(id)}/cancel`, { method: 'POST', headers: { 'idempotency-key': idempotencyKey }, signal }),
    hostingApplications: (signal?: AbortSignal) => request<ComputeApiPage<HostingApplicationV2>>('/api/compute/v2/hosting/applications', { signal }),
    createHostingApplication: (draft: HostingApplicationDraft, submit: boolean, idempotencyKey = clientId(), signal?: AbortSignal) => request<HostingApplicationV2>('/api/compute/v2/hosting/applications', { method: 'POST', headers: { 'idempotency-key': idempotencyKey }, body: JSON.stringify({ ...draft, submit }), signal }),
    updateHostingApplication: (id: string, draft: HostingApplicationDraft, expectedRevision: number, submit: boolean, signal?: AbortSignal) => request<HostingApplicationV2>(`/api/compute/v2/hosting/applications/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ ...draft, expectedRevision, submit }), signal }),
    devices: (status?: HostedDeviceStatus, signal?: AbortSignal) => request<ComputeApiPage<HostedDeviceV2>>(`/api/compute/v2/devices${status ? `?status=${status}` : ''}`, { signal }),
    device: (id: string, signal?: AbortSignal) => request<HostedDeviceV2>(`/api/compute/v2/devices/${encodeURIComponent(id)}`, { signal }),
    createTicket: (deviceId: string, input: Pick<ComputeTicket, 'category' | 'subject' | 'description'>, idempotencyKey = clientId(), signal?: AbortSignal) => request<ComputeTicket>(`/api/compute/v2/devices/${encodeURIComponent(deviceId)}/tickets`, { method: 'POST', headers: { 'idempotency-key': idempotencyKey }, body: JSON.stringify(input), signal }),
    assets: (signal?: AbortSignal) => request<ComputeAssetsSummary>('/api/compute/v2/assets/summary', { signal }),
    ledger: (signal?: AbortSignal) => request<ComputeApiPage<CardHourLedgerEntry>>('/api/compute/v2/assets/ledger', { signal }),
    referrals: (signal?: AbortSignal) => request<ComputeReferralPayload>('/api/compute/v2/referrals', { signal }),
    news: (signal?: AbortSignal) => request<ComputeApiPage<ComputeNewsEntry>>('/api/compute/v2/news', { signal }),
    newsEntry: (slug: string, signal?: AbortSignal) => request<ComputeNewsEntry>(`/api/compute/v2/news/${encodeURIComponent(slug)}`, { signal }),
    rankings: (signal?: AbortSignal) => request<ComputeRankingsPayload>('/api/compute/v2/rankings', { signal }),
    admin: {
      dashboard: (signal?: AbortSignal) => request<ComputeAdminDashboard>('/api/admin/compute/v2/dashboard', { signal }),
      catalog: (signal?: AbortSignal) => request<ComputeApiPage<ComputeAdminOfferRecord>>('/api/admin/compute/v2/catalog', { signal }),
      saveOffer: (record: ComputeAdminOfferRecord, reason: string, idempotencyKey = clientId(), signal?: AbortSignal) => request<ComputeAdminOfferRecord>('/api/admin/compute/v2/catalog', { method: record.revision ? 'PATCH' : 'POST', headers: { 'idempotency-key': idempotencyKey }, body: JSON.stringify({ offer: record.offer, expectedRevision: record.revision || null, reason }), signal }),
      inventory: (signal?: AbortSignal) => request<ComputeApiPage<ComputeInventoryPool>>('/api/admin/compute/v2/inventory', { signal }),
      saveInventory: (pool: ComputeInventoryPool, reason: string, idempotencyKey = clientId(), signal?: AbortSignal) => request<ComputeInventoryPool>('/api/admin/compute/v2/inventory', { method: pool.revision ? 'PATCH' : 'POST', headers: { 'idempotency-key': idempotencyKey }, body: JSON.stringify({ pool: { id: pool.id, skuId: pool.skuId, nodeLabel: pool.nodeLabel, facilityLabel: pool.facilityLabel, availableUnits: pool.availableUnits, reservedUnits: pool.reservedUnits, allocatedUnits: pool.allocatedUnits, maintenanceUnits: pool.maintenanceUnits }, expectedRevision: pool.revision || null, reason }), signal }),
      orders: (signal?: AbortSignal) => request<ComputeApiPage<ComputeOrderV2>>('/api/admin/compute/v2/orders', { signal }),
      transitionOrder: (order: ComputeOrderV2, status: ComputeOrderV2['status'], reason: string, idempotencyKey = clientId(), signal?: AbortSignal) => request<ComputeOrderV2>(`/api/admin/compute/v2/orders/${encodeURIComponent(order.id)}`, { method: 'PATCH', headers: { 'idempotency-key': idempotencyKey }, body: JSON.stringify({ status, expectedRevision: order.revision, reason }), signal }),
      hosting: (signal?: AbortSignal) => request<ComputeApiPage<HostingApplicationV2>>('/api/admin/compute/v2/hosting-applications', { signal }),
      transitionHosting: (application: HostingApplicationV2, status: HostingApplicationV2['status'], reason: string, nextAction: string, responsibleParty: HostingApplicationV2['responsibleParty'], idempotencyKey = clientId(), signal?: AbortSignal) => request<HostingApplicationV2>(`/api/admin/compute/v2/hosting-applications/${encodeURIComponent(application.id)}`, { method: 'PATCH', headers: { 'idempotency-key': idempotencyKey }, body: JSON.stringify({ status, expectedRevision: application.revision, reason, nextAction, responsibleParty }), signal }),
      devices: (signal?: AbortSignal) => request<ComputeApiPage<HostedDeviceV2>>('/api/admin/compute/v2/devices', { signal }),
      transitionDevice: (device: HostedDeviceV2, status: HostedDeviceV2['status'], reason: string, actionRequired: string | null, idempotencyKey = clientId(), signal?: AbortSignal) => request<HostedDeviceV2>(`/api/admin/compute/v2/devices/${encodeURIComponent(device.id)}`, { method: 'PATCH', headers: { 'idempotency-key': idempotencyKey }, body: JSON.stringify({ status, expectedRevision: device.revision, reason, actionRequired }), signal }),
      tickets: (signal?: AbortSignal) => request<ComputeApiPage<ComputeTicket>>('/api/admin/compute/v2/tickets', { signal }),
      content: (signal?: AbortSignal) => request<ComputeApiPage<ComputeContentRecord>>('/api/admin/compute/v2/content', { signal }),
      saveContent: (record: ComputeContentRecord, reason: string, idempotencyKey = clientId(), signal?: AbortSignal) => request<ComputeContentRecord>('/api/admin/compute/v2/content', { method: record.revision ? 'PATCH' : 'POST', headers: { 'idempotency-key': idempotencyKey }, body: JSON.stringify({ record, expectedRevision: record.revision || null, reason }), signal }),
      audit: (signal?: AbortSignal) => request<ComputeApiPage<ComputeAuditEvent>>('/api/admin/compute/v2/audit', { signal }),
    },
  };
}

function mapComputeError(code: string | undefined, status: number): string {
  const messages: Record<string, string> = {
    authentication_required: '请先登录后继续', insufficient_card_hours: '可用卡时不足', inventory_revision_conflict: '价格或库存已变化，请重新确认',
    inventory_sold_out: '当前无库存', quote_required: '该商品需要人工核验库存', idempotency_conflict: '请求内容已变化，请刷新后重试',
    revision_conflict: '数据已被更新，请重新加载', compute_order_not_found: '订单不存在或无权查看', hosting_application_not_found: '托管申请不存在或无权查看',
  };
  return messages[code ?? ''] ?? (status === 403 ? '无权执行此操作' : status === 404 ? '内容不存在' : status === 409 ? '数据已变化，请刷新后重试' : '请求失败，请稍后重试');
}
