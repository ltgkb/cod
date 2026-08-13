import { describe, expect, it } from 'vitest';
import type { ComputeOfferV2, ComputePrincipal, CreateComputeOrderInput, HostingApplicationDraft } from '@cod/contracts/compute-market-v2';
import { ComputeCatalogService, defaultComputeCapabilities } from './catalog.js';
import { ComputeDeviceService } from './devices.js';
import { ComputeHostingService } from './hosting.js';
import { ComputeOrderService } from './orders.js';
import { createComputeMarketV2Router } from './router.js';
import { InMemoryCardHourLedger } from './settlements.js';
import { assertDeviceTransition, assertHostingTransition, assertOrderTransition } from './validation.js';

const user: ComputePrincipal = { userId: 'user-a', tenantId: 'tenant-a', email: 'a@example.com', role: 'member' };
const other: ComputePrincipal = { userId: 'user-b', tenantId: 'tenant-b', email: 'b@example.com', role: 'member' };
const admin: ComputePrincipal = { userId: 'operator-a', tenantId: 'tenant-a', email: 'ops@example.com', role: 'compute_operator' };
const catalogOffer: ComputeOfferV2 = {
  id: 'offer-rtx-5090-32g', slug: 'rtx-5090-32g', title: 'RTX 5090 / 32 GB', status: 'published', purchaseMode: 'quote', providerName: 'test provider', regionLabel: 'test region', gpu: { model: 'RTX 5090', memoryGb: 32, countPerUnit: 1 },
  specs: { cpuModel: 'EPYC', cpuCores: 16, ramGb: 128, systemDiskGb: 100, dataDiskGb: 500, driverVersion: '570', cudaVersion: '12.8', networkLabel: 'test network' }, tags: ['test'], media: [{ id: 'media', url: '/test.webp', alt: 'test gpu' }],
  skus: [{ id: 'sku-rtx5090-hour-container', offerId: 'offer-rtx-5090-32g', deliveryMode: 'container', period: 'hour', minimumUnits: 1, maximumUnits: 8, priceCardHoursMilli: 64_600, compareAtPriceCardHoursMilli: 68_000, inventoryRevision: 1, imageOptions: [{ id: 'img-pytorch-241', label: 'PyTorch', framework: 'PyTorch', frameworkVersion: '2.4', pythonVersion: '3.11', cudaVersion: '12.8' }] }],
  availability: { level: 'quote', label: '询价' }, updatedAt: '2026-08-13T00:00:00.000Z',
};
const testCatalog = () => new ComputeCatalogService(defaultComputeCapabilities, [catalogOffer]);

function orderInput(): CreateComputeOrderInput {
  return { skuId: 'sku-rtx5090-hour-container', imageId: 'img-pytorch-241', quantity: 1, availableDurationHours: 2, startsAt: null, inventoryRevision: 1, contact: { name: '测试用户', phone: '13800001111' }, acceptedTermsVersion: 'terms-v1' };
}

function hostingDraft(): HostingApplicationDraft {
  return { subjectType: 'enterprise', verificationStatus: 'verified', contactName: '设备负责人', contactPhone: '13800001111', city: '上海', devices: [{ brand: '自有品牌', model: '节点 A', gpuModel: 'H100', gpuCount: 8, serialLastFour: 'A123', machineSpecs: '双路服务器，冗余电源', ownershipProofStatus: 'ready' }], rackUnits: 4, powerWatts: 4000, networkRequirement: '100G', hostingMonths: 12, availableFrom: '2026-09-01', slaRequirement: '99.9%', settlementPreference: 'COD 卡时', responsibilityAccepted: true, privacyAccepted: true };
}

describe('compute market v2 domain', () => {
  it('migrates the original numeric price one-to-one and keeps incomplete purchase capabilities off', () => {
    const catalog = testCatalog();
    const offer = catalog.offer('offer-rtx-5090-32g');
    expect(offer.skus[0].priceCardHoursMilli).toBe(64_600);
    expect(offer.purchaseMode).toBe('quote');
    expect(offer.skus[0].period).toBe('hour');
    expect(defaultComputeCapabilities).toMatchObject({ enabled: false, instantPurchase: false, reservationPurchase: false, rankings: false, hostedSettlements: false });
  });

  it('creates an idempotent quote order and rejects a changed payload for the same key', () => {
    const orders = new ComputeOrderService(testCatalog(), new InMemoryCardHourLedger());
    const first = orders.createOrder(user, orderInput(), 'order-key');
    expect(first).toMatchObject({ status: 'pending_quote', availableDurationHours: 2, subtotalCardHoursMilli: 129_200, chargedCardHoursMilli: 129_200 });
    expect(first).not.toHaveProperty('resourceCardHoursMilli');
    expect(orders.createOrder(user, orderInput(), 'order-key').id).toBe(first.id);
    expect(() => orders.createOrder(user, { ...orderInput(), availableDurationHours: 3 }, 'order-key')).toThrowError(/幂等键/);
  });

  it('isolates orders by tenant and owner', () => {
    const orders = new ComputeOrderService(testCatalog(), new InMemoryCardHourLedger());
    const created = orders.createOrder(user, orderInput(), 'owner-key');
    expect(orders.get(user, created.id).id).toBe(created.id);
    expect(() => orders.get(other, created.id)).toThrowError(/订单不存在/);
    expect(orders.list(other).items).toHaveLength(0);
  });

  it('requires the user to accept an unexpired operator quote and settles exact card hours', () => {
    const ledger = new InMemoryCardHourLedger(); const orders = new ComputeOrderService(testCatalog(), ledger);
    ledger.grant(user, 1_000_000, 'seed', 'test grant');
    const created = orders.createOrder(user, orderInput(), 'quote-order');
    const quoted = orders.quote(admin, created.id, { subtotalCardHoursMilli: 140_000, discountCardHoursMilli: 10_000, validUntil: new Date(Date.now() + 86400_000).toISOString(), termsVersion: 'quote-v1', terms: '人工核验库存后五个工作日内交付。', expectedRevision: created.revision }, 'quote-key');
    expect(quoted).toMatchObject({ status: 'quoted', chargedCardHoursMilli: 130_000 });
    expect(() => orders.adminTransition(admin, quoted.id, 'pending_settlement', quoted.revision, '尝试代用户接受')).toThrowError(/不能代用户/);
    const accepted = orders.decideQuote(user, quoted.id, 'accept', 'accept-key');
    const settled = orders.settle(user, accepted.id, 'settle-key');
    expect(settled.status).toBe('settled');
    expect(ledger.summary(user)).toMatchObject({ availableCardHoursMilli: 870_000, lockedCardHoursMilli: 0 });
    expect(ledger.entries(user).filter((entry) => entry.type === 'rental_charge')).toHaveLength(1);
  });

  it('keeps card-hour transfers conserved through lock and release', () => {
    const ledger = new InMemoryCardHourLedger(); ledger.grant(user, 500_000, 'grant', 'seed');
    ledger.lock(user, 125_000, 'trade-lock', 'trade:1');
    expect(ledger.summary(user)).toMatchObject({ availableCardHoursMilli: 375_000, lockedCardHoursMilli: 125_000 });
    ledger.release(user, 125_000, 'trade-release', 'trade:1');
    expect(ledger.summary(user)).toMatchObject({ availableCardHoursMilli: 500_000, lockedCardHoursMilli: 0 });
  });

  it('does not create a device until the accepted application enters deployment', () => {
    const hosting = new ComputeHostingService(); const devices = new ComputeDeviceService();
    let application = hosting.create(user, hostingDraft(), true, 'hosting-key');
    expect(devices.list(user).items).toHaveLength(0);
    for (const status of ['reviewing', 'site_survey', 'quoted', 'contract_pending', 'inbound_pending', 'deploying'] as const) application = hosting.adminTransition(admin, application.id, status, application.revision, '完成对应阶段核验', '推进下一阶段', status === 'deploying' ? 'cod' : 'user');
    const created = devices.createFromAcceptedApplication(application, admin);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ userId: user.userId, tenantId: user.tenantId, status: 'deploying' });
    expect(devices.list(other).items).toHaveLength(0);
  });

  it('enforces explicit order, hosting and device state machines', () => {
    expect(() => assertOrderTransition('pending_quote', 'running')).toThrowError(/不允许/);
    expect(() => assertHostingTransition('draft', 'running')).toThrowError(/不允许/);
    expect(() => assertDeviceTransition('pending_review', 'running')).toThrowError(/不允许/);
  });
});

describe('compute market v2 router', () => {
  it('serves public catalog and requires auth for private routes', async () => {
    const router = createComputeMarketV2Router();
    const publicResponse = await router.route({ method: 'GET', pathname: '/api/compute/v2/offers' });
    expect(publicResponse?.status).toBe(200);
    await expect(router.route({ method: 'GET', pathname: '/api/compute/v2/orders', principal: null })).rejects.toMatchObject({ status: 401, code: 'authentication_required' });
  });

  it('exposes admin capability only to operators', async () => {
    const router = createComputeMarketV2Router({ catalog: new ComputeCatalogService({ ...defaultComputeCapabilities, enabled: true, admin: true }) });
    const member = await router.route({ method: 'GET', pathname: '/api/compute/v2/capabilities', principal: user });
    const operator = await router.route({ method: 'GET', pathname: '/api/compute/v2/capabilities', principal: admin });
    expect(member?.body).toMatchObject({ admin: false }); expect(operator?.body).toMatchObject({ admin: true });
  });

  it('rejects legacy day/month rental units at both catalog and query boundaries', async () => {
    const legacyOffer = { ...catalogOffer, skus: [{ ...catalogOffer.skus[0], period: 'day' as never }] };
    expect(() => new ComputeCatalogService(defaultComputeCapabilities, [legacyOffer])).toThrowError(/仅支持按小时/);
    const router = createComputeMarketV2Router();
    await expect(router.route({ method: 'GET', pathname: '/api/compute/v2/offers', searchParams: new URLSearchParams('period=month') })).rejects.toMatchObject({ status: 400, code: 'invalid_compute_period' });
  });

  it('requires admin inventory reasons, versions and idempotency while writing an audit event', async () => {
    const router = createComputeMarketV2Router(); const body = { pool: { id: 'pool-1', skuId: 'sku-1', nodeLabel: 'node-a', facilityLabel: 'facility-a', availableUnits: 8, reservedUnits: 0, allocatedUnits: 0, maintenanceUnits: 0 }, expectedRevision: null, reason: '首次登记真实库存' };
    const first = await router.route({ method: 'POST', pathname: '/api/admin/compute/v2/inventory', principal: admin, headers: { 'idempotency-key': 'inventory-key' }, body });
    const duplicate = await router.route({ method: 'POST', pathname: '/api/admin/compute/v2/inventory', principal: admin, headers: { 'idempotency-key': 'inventory-key' }, body });
    expect(first?.body).toMatchObject({ availableUnits: 8, revision: 1 }); expect(duplicate?.body).toEqual(first?.body);
    await expect(router.route({ method: 'POST', pathname: '/api/admin/compute/v2/inventory', principal: admin, headers: { 'idempotency-key': 'inventory-key' }, body: { ...body, pool: { ...body.pool, availableUnits: 9 } } })).rejects.toMatchObject({ status: 409, code: 'idempotency_conflict' });
    const audit = await router.route({ method: 'GET', pathname: '/api/admin/compute/v2/audit', principal: admin });
    expect((audit?.body as { items: Array<{ action: string }> }).items[0].action).toBe('compute.inventory.created');
  });

  it('escapes content instead of rendering unsanitized admin HTML', () => {
    const catalog = new ComputeCatalogService({ ...defaultComputeCapabilities, enabled: true, news: true });
    const saved = catalog.saveContent({ entry: { id: 'content-1', slug: 'safe-content', title: '安全内容', summary: '摘要', coverUrl: null, category: '指南', sanitizedHtml: '<img src=x onerror=alert(1)>', publishedAt: new Date().toISOString() }, status: 'published', scheduledAt: null, revision: 0 }, null);
    expect(saved.entry.sanitizedHtml).toBe('<p>&lt;img src=x onerror=alert(1)&gt;</p>');
    expect(catalog.news('safe-content').sanitizedHtml).not.toContain('<img');
  });
});
