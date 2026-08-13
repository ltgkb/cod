import { ChatCircleDots, Cpu, Funnel, Package, SignIn, Storefront } from '@phosphor-icons/react';
import { OfferCard } from '../components/OfferCard';
import { ErrorState } from '../components/ErrorState';
import { useComputeResource } from '../hooks/useComputeResource';
import type { ComputePageProps } from './shared';

export function HomePage({ api, navigate, signedIn, requireLogin }: ComputePageProps) {
  const resource = useComputeResource((signal) => api.home(signal), []);
  if (resource.state === 'error' && !resource.data) return <ErrorState message={resource.error?.message} onRetry={resource.reload} />;
  if (!resource.data) return <HomeSkeleton />;
  const data = resource.data;
  const actions = [
    { id: 'offers', label: '找算力', icon: Storefront, path: '/compute/offers' }, { id: 'hosting', label: '托管设备', icon: Cpu, path: '/compute/hosting' },
    { id: 'orders', label: '我的订单', icon: Package, path: '/compute/orders', login: true }, { id: 'support', label: '在线客服', icon: ChatCircleDots, path: '/compute/support', login: true },
  ];
  return <div className="compute-page-stack">{resource.state === 'offline' && <p className="compute-offline-banner">当前为离线数据，下单和提交已暂停。</p>}{data.banner ? <section className="compute-home-banner"><div><span>可用卡时</span><strong>{(data.banner.availableCardHoursMilli ?? 0) / 1000}</strong></div><div><span>进行中订单</span><strong>{data.banner.activeOrderCount ?? 0}</strong></div></section> : <section className="compute-guest-banner"><div><strong>高性能算力，按需透明匹配</strong><span>浏览真实商品与配置，库存由人工核验后报价。</span></div>{!signedIn && <button type="button" onClick={() => requireLogin('/compute')}><SignIn /> 登录查看资产</button>}</section>}
    <section className="compute-quick-actions" aria-label="快捷入口">{actions.filter((action) => data.quickActions.includes(action.id as never)).map((action) => <button type="button" key={action.id} onClick={() => action.login && !signedIn ? requireLogin(action.path) : navigate(action.path)}><action.icon weight="duotone" /><span>{action.label}</span></button>)}</section>
    <section><div className="compute-section-heading"><div><h2>热门算力卡</h2><p>精选高性能计算资源</p></div><button type="button" onClick={() => navigate('/compute/offers')}><Funnel /> 筛选</button></div><div className="compute-offer-grid">{data.featuredOffers.map((offer) => <OfferCard key={offer.id} offer={offer} onOpen={() => navigate(`/compute/offers/${offer.id}`)} />)}</div></section>
  </div>;
}

function HomeSkeleton() { return <div className="compute-page-stack" aria-label="正在加载"><div className="compute-skeleton banner" /><div className="compute-skeleton actions" /><div className="compute-offer-grid"><div className="compute-skeleton card" /><div className="compute-skeleton card" /></div></div>; }

