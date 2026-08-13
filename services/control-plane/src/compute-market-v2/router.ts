import type { IncomingMessage } from 'node:http';
import type {
  ComputeAdminOfferRecord, ComputeContentRecord, ComputeInventoryPool, ComputeOfferFilters,
  ComputeOfferV2, ComputeOrderStatus, ComputePrincipal, CreateComputeOrderInput,
  HostedDeviceStatus, HostingApplicationDraft, HostingApplicationStatus,
} from '@cod/contracts/compute-market-v2';
import { HttpError } from '../errors.js';
import { ComputeAdminService } from './admin.js';
import { ComputeCatalogService } from './catalog.js';
import { ComputeDeviceService } from './devices.js';
import { ComputeHostingService } from './hosting.js';
import { ComputeOrderService } from './orders.js';
import { InMemoryCardHourLedger } from './settlements.js';
import { requireAdmin, requireExpectedRevision, requireIdempotencyKey, requirePrincipal, requireReason } from './validation.js';

export interface ComputeRouteRequest {
  method: string;
  pathname: string;
  searchParams?: URLSearchParams;
  headers?: Record<string, string | undefined>;
  body?: unknown;
  principal?: ComputePrincipal | null;
}

export interface ComputeRouteResponse { status: number; body: unknown }

export function createComputeMarketV2Router(options: { catalog?: ComputeCatalogService; ledger?: InMemoryCardHourLedger } = {}) {
  const catalog = options.catalog ?? new ComputeCatalogService();
  const ledger = options.ledger ?? new InMemoryCardHourLedger();
  const orders = new ComputeOrderService(catalog, ledger);
  const hosting = new ComputeHostingService();
  const devices = new ComputeDeviceService();
  const adminService = new ComputeAdminService();

  async function route(request: ComputeRouteRequest): Promise<ComputeRouteResponse | null> {
    const { method, pathname } = request;
    if (!pathname.startsWith('/api/compute/v2') && !pathname.startsWith('/api/admin/compute/v2')) return null;
    const query = request.searchParams ?? new URLSearchParams();
    const idempotencyKey = (): string => requireIdempotencyKey(request.headers?.['idempotency-key']);

    if (method === 'GET' && pathname === '/api/compute/v2/capabilities') return ok(catalog.getCapabilities(Boolean(request.principal && ['compute_operator', 'super_admin'].includes(request.principal.role))));
    if (method === 'GET' && pathname === '/api/compute/v2/home') return ok(catalog.home(request.principal ? { availableCardHoursMilli: ledger.summary(request.principal).availableCardHoursMilli, activeOrderCount: orders.list(request.principal).items.filter((order) => !['completed', 'cancelled', 'refunded'].includes(order.status)).length, actionRequiredDeviceCount: devices.list(request.principal, 'action_required').items.length } : null));
    if (method === 'GET' && pathname === '/api/compute/v2/offers') return ok(catalog.listOffers(offerFilters(query)));
    if (method === 'GET' && match(pathname, '/api/compute/v2/offers/:id')) return ok(catalog.offer(segment(pathname)));
    if (method === 'GET' && pathname === '/api/compute/v2/news') return ok(catalog.listNews());
    if (method === 'GET' && match(pathname, '/api/compute/v2/news/:slug')) return ok(catalog.news(segment(pathname)));
    if (method === 'GET' && pathname === '/api/compute/v2/rankings') return ok({ enabled: false, metric: 'availability', periodLabel: '', updatedAt: new Date().toISOString(), anonymous: true, entries: [] });

    if (method === 'POST' && pathname === '/api/compute/v2/reservations') return created(orders.createReservation(requirePrincipal(request.principal ?? null), request.body as { skuId: string; quantity: number; inventoryRevision: number }, idempotencyKey()));
    if (method === 'POST' && pathname === '/api/compute/v2/orders') return created(orders.createOrder(requirePrincipal(request.principal ?? null), request.body as CreateComputeOrderInput, idempotencyKey()));
    if (method === 'GET' && pathname === '/api/compute/v2/orders') return ok(orders.list(requirePrincipal(request.principal ?? null), query.get('status') as ComputeOrderStatus | undefined));
    if (method === 'GET' && match(pathname, '/api/compute/v2/orders/:id')) return ok(orders.get(requirePrincipal(request.principal ?? null), segment(pathname)));
    if (method === 'PATCH' && pathname.endsWith('/quote-decision')) return ok(orders.decideQuote(requirePrincipal(request.principal ?? null), parentSegment(pathname), decision(request.body), idempotencyKey()));
    if (method === 'POST' && pathname.endsWith('/cancel') && pathname.startsWith('/api/compute/v2/orders/')) return ok(orders.cancel(requirePrincipal(request.principal ?? null), parentSegment(pathname), idempotencyKey()));
    if (method === 'POST' && pathname.endsWith('/settle') && pathname.startsWith('/api/compute/v2/orders/')) return ok(orders.settle(requirePrincipal(request.principal ?? null), parentSegment(pathname), idempotencyKey()));

    if (method === 'GET' && pathname === '/api/compute/v2/hosting/applications') return ok(hosting.list(requirePrincipal(request.principal ?? null)));
    if (method === 'POST' && pathname === '/api/compute/v2/hosting/applications') {
      const body = request.body as HostingApplicationDraft & { submit?: boolean }; return created(hosting.create(requirePrincipal(request.principal ?? null), body, Boolean(body.submit), idempotencyKey()));
    }
    if (method === 'GET' && match(pathname, '/api/compute/v2/hosting/applications/:id')) return ok(hosting.get(requirePrincipal(request.principal ?? null), segment(pathname)));
    if (method === 'PATCH' && match(pathname, '/api/compute/v2/hosting/applications/:id')) {
      const body = request.body as HostingApplicationDraft & { expectedRevision?: number; submit?: boolean };
      return ok(hosting.updateDraft(requirePrincipal(request.principal ?? null), segment(pathname), body, requireExpectedRevision(body.expectedRevision), Boolean(body.submit)));
    }

    if (method === 'GET' && pathname === '/api/compute/v2/devices') return ok(devices.list(requirePrincipal(request.principal ?? null), query.get('status') as HostedDeviceStatus | undefined));
    if (method === 'GET' && match(pathname, '/api/compute/v2/devices/:id')) return ok(devices.get(requirePrincipal(request.principal ?? null), segment(pathname)));
    if (method === 'POST' && pathname.endsWith('/tickets') && pathname.startsWith('/api/compute/v2/devices/')) return created(devices.createTicket(requirePrincipal(request.principal ?? null), parentSegment(pathname), request.body as never, idempotencyKey()));
    if (method === 'GET' && pathname === '/api/compute/v2/assets/summary') return ok(ledger.summary(requirePrincipal(request.principal ?? null)));
    if (method === 'GET' && pathname === '/api/compute/v2/assets/ledger') return ok({ items: ledger.entries(requirePrincipal(request.principal ?? null)), nextCursor: null });
    if (method === 'GET' && pathname === '/api/compute/v2/referrals') return ok({ inviteCode: `COD-${requirePrincipal(request.principal ?? null).userId.slice(-6).toUpperCase()}`, inviteUrl: 'https://cod.kai.com/invite', rule: '奖励在被邀请人满足真实条件后由服务端入账。', records: [] });

    const admin = pathname.startsWith('/api/admin/compute/v2') ? requireAdmin(request.principal ?? null) : null;
    if (admin && method === 'GET' && pathname === '/api/admin/compute/v2/dashboard') {
      const adminOrders = orders.allForAdmin(admin); const adminDevices = devices.allForAdmin(admin); const adminTickets = devices.allTicketsForAdmin(admin);
      return ok({ newOrders: adminOrders.length, pendingQuotes: adminOrders.filter((order) => order.status === 'pending_quote').length, pendingDeployments: adminOrders.filter((order) => order.status === 'provisioning').length, runningInstances: adminOrders.filter((order) => order.status === 'running').length, actionRequiredDevices: adminDevices.filter((device) => device.status === 'action_required').length, expiringReservations: adminOrders.filter((order) => order.status === 'reserved').length, openTickets: adminTickets.filter((ticket) => !['resolved', 'closed'].includes(ticket.status)).length });
    }
    if (admin && method === 'GET' && pathname === '/api/admin/compute/v2/orders') return ok({ items: orders.allForAdmin(admin), nextCursor: null });
    if (admin && method === 'POST' && pathname.endsWith('/quote') && pathname.startsWith('/api/admin/compute/v2/orders/')) {
      const body = request.body as { subtotalCardHoursMilli: number; discountCardHoursMilli: number; validUntil: string; termsVersion: string; terms: string; expectedRevision: number };
      const key = idempotencyKey();
      return ok(adminService.idempotent(admin, key, JSON.stringify({ pathname, body }), () => { const value = orders.quote(admin, parentSegment(pathname), body, key); adminService.audit(admin, 'compute.order.quoted', 'order', value.id, { chargedCardHoursMilli: value.chargedCardHoursMilli, revision: value.revision }); return value; }));
    }
    if (admin && method === 'PATCH' && pathname.startsWith('/api/admin/compute/v2/orders/')) {
      const body = request.body as { status?: ComputeOrderStatus; expectedRevision?: number; reason?: string };
      const reason = requireReason(body.reason); const key = idempotencyKey();
      return ok(adminService.idempotent(admin, key, JSON.stringify({ pathname, body }), () => { const value = orders.adminTransition(admin, segment(pathname), body.status as ComputeOrderStatus, requireExpectedRevision(body.expectedRevision), reason); adminService.audit(admin, 'compute.order.status_changed', 'order', value.id, { status: value.status, revision: value.revision, reason }); return value; }));
    }
    if (admin && method === 'GET' && pathname === '/api/admin/compute/v2/hosting-applications') return ok({ items: hosting.allForAdmin(admin), nextCursor: null });
    if (admin && method === 'PATCH' && pathname.startsWith('/api/admin/compute/v2/hosting-applications/')) {
      const body = request.body as { status?: HostingApplicationStatus; expectedRevision?: number; reason?: string; nextAction?: string | null; responsibleParty?: 'user' | 'cod' | 'partner' | null };
      const reason = requireReason(body.reason); const key = idempotencyKey();
      return ok(adminService.idempotent(admin, key, JSON.stringify({ pathname, body }), () => { const updated = hosting.adminTransition(admin, segment(pathname), body.status as HostingApplicationStatus, requireExpectedRevision(body.expectedRevision), reason, body.nextAction ?? null, body.responsibleParty ?? null); if (updated.status === 'deploying') devices.createFromAcceptedApplication(updated, admin); adminService.audit(admin, 'compute.hosting.status_changed', 'hosting_application', updated.id, { status: updated.status, revision: updated.revision, reason }); return updated; }));
    }
    if (admin && method === 'GET' && pathname === '/api/admin/compute/v2/devices') return ok({ items: devices.allForAdmin(admin), nextCursor: null });
    if (admin && method === 'PATCH' && pathname.startsWith('/api/admin/compute/v2/devices/')) {
      const body = request.body as { status?: HostedDeviceStatus; expectedRevision?: number; reason?: string; actionRequired?: string | null };
      const reason = requireReason(body.reason); const key = idempotencyKey();
      return ok(adminService.idempotent(admin, key, JSON.stringify({ pathname, body }), () => { const value = devices.adminTransition(admin, segment(pathname), body.status as HostedDeviceStatus, requireExpectedRevision(body.expectedRevision), reason, body.actionRequired ?? null); adminService.audit(admin, 'compute.device.status_changed', 'device', value.id, { status: value.status, revision: value.revision, reason }); return value; }));
    }
    if (admin && method === 'GET' && pathname === '/api/admin/compute/v2/tickets') return ok({ items: devices.allTicketsForAdmin(admin), nextCursor: null });
    if (admin && method === 'GET' && pathname === '/api/admin/compute/v2/catalog') return ok(catalog.adminOffers());
    if (admin && (method === 'POST' || method === 'PATCH') && pathname === '/api/admin/compute/v2/catalog') {
      const body = request.body as { offer?: ComputeOfferV2; expectedRevision?: number | null; reason?: string }; const reason = requireReason(body.reason); const key = idempotencyKey();
      return created(adminService.idempotent<ComputeAdminOfferRecord>(admin, key, JSON.stringify(body), () => { const value = catalog.saveOffer(body.offer as ComputeOfferV2, body.expectedRevision ?? null); adminService.audit(admin, 'compute.catalog.saved', 'offer', value.offer.id, { revision: value.revision, status: value.offer.status, reason }); return value; }));
    }
    if (admin && method === 'GET' && pathname === '/api/admin/compute/v2/inventory') return ok({ items: adminService.listInventory(admin), nextCursor: null });
    if (admin && (method === 'POST' || method === 'PATCH') && pathname === '/api/admin/compute/v2/inventory') {
      const body = request.body as { pool?: Omit<ComputeInventoryPool, 'revision' | 'updatedAt'>; expectedRevision?: number | null; reason?: string }; const reason = requireReason(body.reason); const key = idempotencyKey();
      return created(adminService.idempotent(admin, key, JSON.stringify(body), () => adminService.saveInventory(admin, body.pool as Omit<ComputeInventoryPool, 'revision' | 'updatedAt'>, body.expectedRevision ?? null, reason)));
    }
    if (admin && method === 'GET' && pathname === '/api/admin/compute/v2/content') return ok(catalog.adminContent());
    if (admin && (method === 'POST' || method === 'PATCH') && pathname === '/api/admin/compute/v2/content') {
      const body = request.body as { record?: ComputeContentRecord; expectedRevision?: number | null; reason?: string }; const reason = requireReason(body.reason); const key = idempotencyKey();
      return created(adminService.idempotent(admin, key, JSON.stringify(body), () => { const value = catalog.saveContent(body.record as ComputeContentRecord, body.expectedRevision ?? null); adminService.audit(admin, 'compute.content.saved', 'content', value.entry.id, { revision: value.revision, status: value.status, reason }); return value; }));
    }
    if (admin && method === 'GET' && pathname === '/api/admin/compute/v2/audit') return ok({ items: adminService.listAudit(admin), nextCursor: null });
    throw new HttpError('接口不存在', 404, 'compute_route_not_found');
  }

  return { route, services: { catalog, ledger, orders, hosting, devices, admin: adminService } };
}

function ok(body: unknown): ComputeRouteResponse { return { status: 200, body }; }
function created(body: unknown): ComputeRouteResponse { return { status: 201, body }; }
function match(path: string, pattern: string): boolean { const prefix = pattern.slice(0, pattern.indexOf(':')); return path.startsWith(prefix) && path.slice(prefix.length).length > 0 && !path.slice(prefix.length).includes('/'); }
function segment(path: string): string { return decodeURIComponent(path.split('/').filter(Boolean).at(-1) ?? ''); }
function parentSegment(path: string): string { return decodeURIComponent(path.split('/').filter(Boolean).at(-2) ?? ''); }
function decision(body: unknown): 'accept' | 'reject' { const value = (body as { decision?: unknown })?.decision; if (value !== 'accept' && value !== 'reject') throw new HttpError('报价决定无效', 400, 'invalid_quote_decision'); return value; }
function offerFilters(query: URLSearchParams): ComputeOfferFilters {
  const values = Object.fromEntries(query);
  if (values.period && values.period !== 'hour') throw new HttpError('租赁仅支持按小时筛选', 400, 'invalid_compute_period');
  return values as ComputeOfferFilters;
}

export async function computeRequestFromNode(request: IncomingMessage, principal: ComputePrincipal | null, body: unknown): Promise<ComputeRouteRequest> {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const headers: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(request.headers)) headers[key] = Array.isArray(value) ? value[0] : value;
  return { method: request.method ?? 'GET', pathname: url.pathname, searchParams: url.searchParams, headers, body, principal };
}
