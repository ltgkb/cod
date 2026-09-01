import type { CardHourLedgerEntry, ComputeAssetsSummary, ComputeCapabilities, HostedDeviceV2, HostingApplicationV2 } from '@cod/contracts/compute-market-v2';
import {
  ChartLineUp, ChatCircleDots, ClockCountdown, Coins, DesktopTower, IdentificationCard, MapPin, Package,
  SealCheck, Storefront, Ticket, UserCircle, Wallet,
} from '@phosphor-icons/react';
import { formatCardHours } from '../api';
import { computePurchasingEnabled } from '../capabilities';
import { useComputeResource } from '../hooks/useComputeResource';
import { buildEarningsSeries, cumulativeHostingEarnings, deriveHostingRemaining } from '../profileMetrics';
import type { ComputePageProps } from './shared';

interface ProfileData {
  assets: ComputeAssetsSummary | null;
  ledger: CardHourLedgerEntry[];
  devices: HostedDeviceV2[];
  hostingApplications: HostingApplicationV2[];
}

const CHART_WIDTH = 720;
const CHART_HEIGHT = 220;
const CHART_LEFT = 54;
const CHART_RIGHT = 18;
const CHART_TOP = 18;
const CHART_BOTTOM = 38;

function EarningsChart({ entries }: { entries: CardHourLedgerEntry[] }) {
  const series = buildEarningsSeries(entries);
  const maximum = Math.max(...series.map((point) => point.cardHoursMilli));
  const chartWidth = CHART_WIDTH - CHART_LEFT - CHART_RIGHT;
  const chartHeight = CHART_HEIGHT - CHART_TOP - CHART_BOTTOM;
  const points = maximum > 0 ? series.map((point, index) => {
    const x = CHART_LEFT + (index / Math.max(1, series.length - 1)) * chartWidth;
    const y = CHART_TOP + (1 - point.cardHoursMilli / maximum) * chartHeight;
    return { x, y };
  }) : [];
  const linePath = points.map((point, index) => `${index ? 'L' : 'M'} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(' ');
  const areaPath = points.length ? `${linePath} L ${points.at(-1)!.x.toFixed(2)} ${(CHART_HEIGHT - CHART_BOTTOM).toFixed(2)} L ${points[0].x.toFixed(2)} ${(CHART_HEIGHT - CHART_BOTTOM).toFixed(2)} Z` : '';
  const periodTotal = series.reduce((total, point) => total + point.cardHoursMilli, 0);

  return <div className="compute-earnings-chart-wrap">
    {maximum > 0 ? <>
      <svg className="compute-earnings-chart" viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`} role="img" aria-label="近 30 天托管收益折线图">
        <defs><linearGradient id="compute-earnings-area" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="currentColor" stopOpacity="0.22" /><stop offset="1" stopColor="currentColor" stopOpacity="0" /></linearGradient></defs>
        {[0, 0.5, 1].map((position) => <line key={position} className="compute-chart-grid" x1={CHART_LEFT} x2={CHART_WIDTH - CHART_RIGHT} y1={CHART_TOP + position * chartHeight} y2={CHART_TOP + position * chartHeight} />)}
        <text className="compute-chart-label" x="0" y={CHART_TOP + 4}>{formatCardHours(maximum)}</text>
        <text className="compute-chart-label" x="30" y={CHART_HEIGHT - CHART_BOTTOM + 4}>0</text>
        <path className="compute-chart-area" d={areaPath} fill="url(#compute-earnings-area)" />
        <path className="compute-chart-line" d={linePath} />
        {points.map((point, index) => series[index].cardHoursMilli > 0 && <circle key={series[index].date} className="compute-chart-point" cx={point.x} cy={point.y} r="3.5"><title>{series[index].label}，{formatCardHours(series[index].cardHoursMilli)} 卡时</title></circle>)}
        <text className="compute-chart-label x-axis" x={CHART_LEFT} y={CHART_HEIGHT - 8}>{series[0].label}</text>
        <text className="compute-chart-label x-axis middle" x={CHART_WIDTH / 2} y={CHART_HEIGHT - 8}>{series[Math.floor(series.length / 2)].label}</text>
        <text className="compute-chart-label x-axis end" x={CHART_WIDTH - CHART_RIGHT} y={CHART_HEIGHT - 8}>{series.at(-1)!.label}</text>
      </svg>
      <p className="compute-chart-summary"><span>近 30 天已入账</span><strong>{formatCardHours(periodTotal)} 卡时</strong></p>
    </> : <div className="compute-chart-empty"><ChartLineUp weight="duotone" /><strong>近 30 天暂无收益入账</strong><p>托管结算完成后，逐日收益会自动形成趋势。</p></div>}
  </div>;
}

export function ProfilePage({ api, navigate, signedIn, requireLogin, capabilities, displayName }: ComputePageProps & { capabilities: ComputeCapabilities; displayName: string }) {
  const resource = useComputeResource(async (signal): Promise<ProfileData> => {
    if (!signedIn) return { assets: null, ledger: [], devices: [], hostingApplications: [] };
    const [assets, ledgerPage, devicePage, hostingPage] = await Promise.all([
      capabilities.assets ? api.assets(signal) : Promise.resolve(null),
      capabilities.assets ? api.ledger(signal) : Promise.resolve({ items: [] }),
      capabilities.devices ? api.devices(undefined, signal) : Promise.resolve({ items: [] }),
      capabilities.hosting ? api.hostingApplications(signal) : Promise.resolve({ items: [] }),
    ]);
    return { assets, ledger: ledgerPage.items, devices: devicePage.items, hostingApplications: hostingPage.items };
  }, [signedIn, capabilities.assets, capabilities.devices, capabilities.hosting]);

  if (!signedIn) return <section className="compute-login-card"><UserCircle weight="duotone" /><h2>登录后管理算力资产与设备</h2><p>登录成功后会恢复当前页面与未提交表单。</p><button type="button" className="compute-button primary" onClick={() => requireLogin('/compute/me')}>登录 COD</button></section>;

  const data = resource.data;
  const isLoading = resource.state === 'idle' || resource.state === 'loading';
  const earnings = cumulativeHostingEarnings(data?.assets ?? null, data?.ledger ?? []);
  const runningDevices = data?.devices.filter((device) => device.status === 'running').length ?? 0;
  const hostingRemaining = deriveHostingRemaining(data?.hostingApplications ?? []);
  const remainingValue = hostingRemaining.days !== null ? `${hostingRemaining.days} 天` : '--';
  const remainingDescription = !capabilities.hosting ? '托管合同服务待开放' : hostingRemaining.state === 'unknown' ? '合同到期时间待确认' : hostingRemaining.state === 'none' ? '暂无在服托管合同' : hostingRemaining.state === 'expired' ? '最近合同已到期' : `${hostingRemaining.activeContracts} 个合同在服，最近到期`;
  const services = [
    { label: '实名认证', path: '/compute/verification', icon: IdentificationCard, visible: capabilities.services.verification },
    { label: '线下采购', path: '/compute/procurement', icon: Storefront, visible: capabilities.services.procurement },
    { label: '优惠券', path: '/compute/coupons', icon: Ticket, visible: capabilities.services.coupons },
    { label: '地址管理', path: '/compute/addresses', icon: MapPin, visible: capabilities.services.addresses },
    { label: '算力入驻', path: '/compute/hosting/apply', icon: SealCheck, visible: capabilities.hosting },
    { label: '在线客服', path: '/compute/support', icon: ChatCircleDots, visible: capabilities.services.onlineSupport },
  ];
  const visibleServices = services.filter((service) => service.visible);

  return <div className="compute-page-stack">
    <section className="compute-profile-head"><UserCircle weight="fill" /><div><h2>{displayName || 'COD 用户'}</h2><p>GPU 资产与工作 Agent 统一账户</p></div></section>

    <section className="compute-profile-overview" aria-labelledby="compute-profile-overview-title" aria-busy={isLoading}>
      <div className="compute-profile-overview-heading"><div><span>资产概览</span><h2 id="compute-profile-overview-title">我的收益与托管</h2></div><small>数据来自资产账本与托管合同</small></div>
      <div className="compute-profile-metrics">
        <article><span className="compute-profile-metric-icon"><Coins weight="duotone" /></span><span>累计收益</span><strong className={isLoading ? 'is-loading' : ''}>{isLoading ? '' : earnings !== null ? `${formatCardHours(earnings)} 卡时` : '--'}</strong><small>{!capabilities.assets ? '结算服务待开放' : earnings === null ? '托管结算待接入' : '已入账托管结算'}</small></article>
        <article><span className="compute-profile-metric-icon"><DesktopTower weight="duotone" /></span><span>设备个数</span><strong className={isLoading ? 'is-loading' : ''}>{isLoading ? '' : capabilities.devices ? `${data?.devices.length ?? 0} 台` : '--'}</strong><small>{!capabilities.devices ? '设备服务待开放' : `运行中 ${runningDevices} 台`}</small></article>
        <article><span className="compute-profile-metric-icon"><ClockCountdown weight="duotone" /></span><span>托管剩余时长</span><strong className={isLoading ? 'is-loading' : ''}>{isLoading ? '' : remainingValue}</strong><small>{remainingDescription}</small></article>
        <article><span className="compute-profile-metric-icon"><Wallet weight="duotone" /></span><span>我的卡时</span><strong className={isLoading ? 'is-loading' : ''}>{isLoading ? '' : data?.assets ? `${formatCardHours(data.assets.availableCardHoursMilli)} 卡时` : '--'}</strong><small>{!capabilities.assets ? '资产账本待开放' : data?.assets ? `另有 ${formatCardHours(data.assets.lockedCardHoursMilli)} 卡时冻结` : '资产账本暂不可用'}</small></article>
      </div>
    </section>

    {resource.state === 'error' && <section className="compute-profile-error" role="alert"><div><strong>资产数据暂时加载失败</strong><p>{resource.error?.message ?? '请检查网络后重试。'}</p></div><button type="button" onClick={resource.reload}>重新加载</button></section>}

    <section className="compute-panel compute-earnings-panel">
      <div className="compute-section-heading"><div><h2>收益趋势</h2><p>近 30 天托管结算，按实际入账日期统计</p></div>{capabilities.assets && <button type="button" onClick={() => navigate('/compute/assets')}>查看收益账本</button>}</div>
      {isLoading ? <div className="compute-chart-skeleton" aria-label="正在加载收益趋势" /> : capabilities.assets ? <EarningsChart entries={data?.ledger ?? []} /> : <div className="compute-chart-empty"><ChartLineUp weight="duotone" /><strong>收益趋势待开放</strong><p>资产账本开放后，这里会展示真实托管结算。</p></div>}
    </section>

    {(visibleServices.length > 0 || computePurchasingEnabled(capabilities)) && <section><h2 className="compute-service-title">服务</h2><div className="compute-service-grid">{visibleServices.map((service) => <button type="button" key={service.path} onClick={() => navigate(service.path)}><service.icon weight="duotone" /><span>{service.label}</span></button>)}{computePurchasingEnabled(capabilities) && <button type="button" onClick={() => navigate('/compute/orders')}><Package weight="duotone" /><span>我的订单</span></button>}</div></section>}
    <footer className="compute-signature">COD · 让 GPU 收益持续驱动工作 Agent</footer>
  </div>;
}
