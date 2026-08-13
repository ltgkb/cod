import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ComputeCapabilities, ComputeOfferV2 } from '@cod/contracts/compute-market-v2';
import { ComputeApp } from '../ComputeApp';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState({}, '', '/'); try { localStorage.clear(); } catch { /* optional */ } });

const capabilities: ComputeCapabilities = {
  enabled: true, instantPurchase: false, reservationPurchase: true, hosting: true, devices: true, assets: true,
  cardHourTrades: false, referrals: true, news: true, rankings: false, hostedSettlements: false, admin: false,
  services: { verification: false, procurement: false, coupons: false, addresses: false, onlineSupport: true, humanSupport: false },
};
const offer: ComputeOfferV2 = {
  id: 'offer-1', slug: 'offer-1', title: 'RTX 5090 / 32 GB', status: 'published', purchaseMode: 'quote', providerName: 'COD 认证算力节点', regionLabel: '华东',
  gpu: { model: 'RTX 5090', memoryGb: 32, countPerUnit: 1 }, specs: { cpuModel: 'AMD EPYC', cpuCores: 16, ramGb: 128, systemDiskGb: 100, dataDiskGb: 500, driverVersion: '570.133', cudaVersion: '12.8', networkLabel: '高可用网络' },
  tags: ['生成式AI', '高性能计算'], media: [{ id: 'media-1', url: '/compute/gpu-accelerator.webp', alt: '无品牌专业 GPU 加速卡商品图' }],
  skus: [{ id: 'sku-1', offerId: 'offer-1', deliveryMode: 'container', period: 'hour', minimumUnits: 1, maximumUnits: 8, priceCardHoursMilli: 64_600, compareAtPriceCardHoursMilli: 68_000, inventoryRevision: 1, imageOptions: [{ id: 'image-1', label: 'PyTorch 2.4.1 · Python 3.11', framework: 'PyTorch', frameworkVersion: '2.4.1', pythonVersion: '3.11', cudaVersion: '12.8' }] }],
  availability: { level: 'quote', label: '询价' }, updatedAt: '2026-08-13T00:00:00.000Z',
};

const json = (value: unknown, status = 200) => Response.json(value, { status });
function mockFetch(extra?: (url: string, init?: RequestInit) => Response | undefined | Promise<Response | undefined>) {
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input); const custom = await extra?.(url, init); if (custom) return custom;
    if (url.endsWith('/api/compute/v2/capabilities')) return json(capabilities);
    if (url.endsWith('/api/compute/v2/home')) return json({ banner: null, quickActions: ['offers', 'hosting', 'orders', 'support'], featuredOffers: [offer], news: [] });
    if (url.includes('/api/compute/v2/offers/')) return json(offer);
    if (url.includes('/api/compute/v2/offers')) return json({ items: [offer], nextCursor: null });
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal('fetch', fetcher); return fetcher;
}

const props = { session: null, initialPath: '/compute', platform: 'web' as const, onRequireLogin: vi.fn(), onExit: vi.fn() };

describe('ComputeApp', () => {
  it('renders the specified home hierarchy and API-backed offer density', async () => {
    mockFetch(); render(<ComputeApp {...props} />);
    expect(await screen.findByText('高性能算力，按需透明匹配')).toBeInTheDocument();
    expect(screen.getByText('热门算力卡')).toBeInTheDocument(); expect(screen.getByText('精选高性能计算资源')).toBeInTheDocument();
    const card = screen.getByRole('link', { name: /查看 RTX 5090/ });
    expect(within(card).getByText('64.60')).toBeInTheDocument(); expect(within(card).getByText('AMD EPYC')).toBeInTheDocument(); expect(within(card).getByText('询价')).toBeInTheDocument();
    expect(within(card).getByText('卡时/小时')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '排行榜' })).not.toBeInTheDocument();
  });

  it('restores URL filters and sends them to the real API client', async () => {
    const fetcher = mockFetch(); render(<ComputeApp {...props} initialPath="/compute/offers?gpuSeries=H100&period=hour" />);
    await screen.findByRole('heading', { name: '全部算力', level: 1 });
    await waitFor(() => expect(fetcher.mock.calls.some(([url]) => String(url).includes('/api/compute/v2/offers?gpuSeries=H100&period=hour'))).toBe(true));
    expect(screen.getAllByRole('button', { name: 'H100' })[0]).toHaveClass('active');
  });

  it('shows quote semantics and preserves the detail URL when login is required', async () => {
    const onRequireLogin = vi.fn(); mockFetch(); render(<ComputeApp {...props} initialPath="/compute/offers/offer-1" onRequireLogin={onRequireLogin} />);
    expect(await screen.findByRole('button', { name: '提交租赁需求' })).toBeInTheDocument();
    expect(screen.getByText('人工核验库存后报价')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '提交租赁需求' }));
    expect(onRequireLogin).toHaveBeenCalledWith(expect.stringMatching(/^\/compute\/checkout\/sku-1\?/));
    expect(screen.queryByText('立即购买')).not.toBeInTheDocument();
  });

  it('uses a four-step hosting form and keeps the draft locally', async () => {
    mockFetch(); const session = { token: 'token', account: { userId: 'user', displayName: '测试用户', balanceCents: 0, currency: 'CNY' as const, plan: 'developer' as const, role: 'member' as const, billingExempt: false } };
    render(<ComputeApp {...props} session={session} initialPath="/compute/hosting/apply" />);
    expect(await screen.findByRole('heading', { name: '主体与联系方式' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('联系人'), { target: { value: '设备负责人' } }); fireEvent.change(screen.getByLabelText('联系电话'), { target: { value: '13800001111' } });
    fireEvent.click(screen.getByRole('button', { name: '下一步' }));
    expect(screen.getByRole('heading', { name: '设备清单' })).toBeInTheDocument();
    await waitFor(() => expect(localStorage.getItem('cod.compute.hosting-draft.v2')).toContain('设备负责人'));
  });

  it('does not render unavailable service shells or withdrawal language', async () => {
    mockFetch((url) => {
      if (url.endsWith('/api/compute/v2/assets/summary')) return json({ availableCardHoursMilli: 0, lockedCardHoursMilli: 0, pendingHostedSettlementCardHoursMilli: null, availableHostedSettlementCardHoursMilli: null, settledHostedCardHoursMilli: null, runningResourceCount: 0 });
      if (url.endsWith('/api/compute/v2/devices')) return json({ items: [], nextCursor: null });
      return undefined;
    });
    const session = { token: 'token', account: { userId: 'user', displayName: '测试用户', balanceCents: 0, currency: 'CNY' as const, plan: 'developer' as const, role: 'member' as const, billingExempt: false } };
    render(<ComputeApp {...props} session={session} initialPath="/compute/me" />);
    expect(await screen.findByText('统一 COD 账户')).toBeInTheDocument(); expect(screen.queryByText('优惠券')).not.toBeInTheDocument(); expect(screen.queryByText('地址管理')).not.toBeInTheDocument(); expect(document.body).not.toHaveTextContent('提现');
  });

  it('opens discovery mode without exposing unconnected account or transaction routes', async () => {
    const discoveryCapabilities: ComputeCapabilities = { ...capabilities, instantPurchase: false, reservationPurchase: false, hosting: false, devices: false, assets: false, referrals: false, news: false, services: { ...capabilities.services, onlineSupport: false } };
    const fetcher = mockFetch((url) => {
      if (url.endsWith('/api/compute/v2/capabilities')) return json(discoveryCapabilities);
      if (url.endsWith('/api/compute/v2/home')) return json({ banner: null, quickActions: ['offers'], featuredOffers: [], news: [] });
      return undefined;
    });
    render(<ComputeApp {...props} initialPath="/compute/orders" />);
    expect(await screen.findByRole('heading', { name: '能力尚未开放' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: '设备托管' }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: '我的资产' }).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: '我的订单' })).not.toBeInTheDocument();
    expect(fetcher.mock.calls.some(([url]) => String(url).includes('/api/compute/v2/orders'))).toBe(false);
  });

  it('keeps hosting and assets available as read-only product showcases', async () => {
    const discoveryCapabilities: ComputeCapabilities = { ...capabilities, instantPurchase: false, reservationPurchase: false, hosting: false, devices: false, assets: false, referrals: false, news: false, services: { ...capabilities.services, onlineSupport: false } };
    const fetcher = mockFetch((url) => {
      if (url.endsWith('/api/compute/v2/capabilities')) return json(discoveryCapabilities);
      if (url.endsWith('/api/compute/v2/home')) return json({ banner: null, quickActions: ['offers'], featuredOffers: [offer], news: [] });
      return undefined;
    });
    render(<ComputeApp {...props} />);
    const quickActions = await screen.findByRole('region', { name: '快捷入口' });
    expect(within(quickActions).getByRole('button', { name: '托管设备' })).toBeInTheDocument();
    expect(within(quickActions).getByRole('button', { name: '我的资产' })).toBeInTheDocument();

    fireEvent.click(within(quickActions).getByRole('button', { name: '托管设备' }));
    expect(await screen.findByRole('heading', { name: '设备托管', level: 1 })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /申请入口待开放/ })).toBeDisabled();
    expect(fetcher.mock.calls.some(([url]) => String(url).includes('/api/compute/v2/devices'))).toBe(false);

    fireEvent.click(screen.getAllByRole('button', { name: '我的资产' })[0]);
    expect(await screen.findByRole('heading', { name: '我的资产', level: 1 })).toBeInTheDocument();
    expect(screen.getByText('待接入')).toBeInTheDocument();
    expect(screen.getByText('真实资产账本正在接入')).toBeInTheDocument();
    expect(fetcher.mock.calls.some(([url]) => String(url).includes('/api/compute/v2/assets'))).toBe(false);
  });

  it('keeps showcase details visible while disabling order creation', async () => {
    const discoveryCapabilities: ComputeCapabilities = { ...capabilities, instantPurchase: false, reservationPurchase: false, hosting: false, devices: false, assets: false, referrals: false, news: false, services: { ...capabilities.services, onlineSupport: false } };
    const showcaseOffer: ComputeOfferV2 = { ...offer, tags: ['方案展示', ...offer.tags], skus: [{ ...offer.skus[0], priceCardHoursMilli: null, compareAtPriceCardHoursMilli: null }], availability: { level: 'quote', label: '方案展示' } };
    mockFetch((url) => {
      if (url.endsWith('/api/compute/v2/capabilities')) return json(discoveryCapabilities);
      if (url.endsWith('/api/compute/v2/offers/offer-1')) return json(showcaseOffer);
      return undefined;
    });

    render(<ComputeApp {...props} initialPath="/compute/offers/offer-1" />);

    expect(await screen.findByRole('button', { name: '方案展示 · 暂不接单' })).toBeDisabled();
    expect(screen.getByText('方案展示，配置以交付前确认为准')).toBeInTheDocument();
  });
});
