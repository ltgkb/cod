import { useCallback, useEffect, useMemo, useState } from 'react';
import { createComputeApi } from './api';
import { computeAccountEnabled, computePurchasingEnabled, unavailableComputeCapabilities } from './capabilities';
import { ComputeShell } from './components/ComputeShell';
import { activeTab, normalizeComputePath, parseComputeRoute, routeParam } from './routes';
import type { ComputeAppProps } from './types';
import { useComputeResource } from './hooks/useComputeResource';
import { AssetsPage, AssetsShowcasePage } from './pages/AssetsPage';
import { CheckoutPage } from './pages/CheckoutPage';
import { DeviceDetailPage } from './pages/DeviceDetailPage';
import { DevicesPage } from './pages/DevicesPage';
import { HomePage } from './pages/HomePage';
import { HostingApplicationDetailPage } from './pages/HostingApplicationDetailPage';
import { HostingApplicationsPage } from './pages/HostingApplicationsPage';
import { HostingApplyPage } from './pages/HostingApplyPage';
import { HostingPage } from './pages/HostingPage';
import { HostingGuidePage } from './pages/HostingGuidePage';
import { NewsDetailPage } from './pages/NewsDetailPage';
import { NewsPage } from './pages/NewsPage';
import { OfferDetailPage } from './pages/OfferDetailPage';
import { OffersPage } from './pages/OffersPage';
import { OrderDetailPage } from './pages/OrderDetailPage';
import { OrdersPage } from './pages/OrdersPage';
import { ProfilePage } from './pages/ProfilePage';
import { RankingsPage } from './pages/RankingsPage';
import { ReferralsPage } from './pages/ReferralsPage';
import { SupportPage } from './pages/SupportPage';
import { ErrorState } from './components/ErrorState';
import './compute-market.css';

export function ComputeApp(props: ComputeAppProps) {
  const { onRequireLogin } = props;
  const [location, setLocation] = useState(() => normalizeComputePath(props.initialPath));
  const route = useMemo(() => parseComputeRoute(location), [location]);
  const api = useMemo(() => createComputeApi({ baseUrl: props.apiBaseUrl, token: props.session?.token }), [props.apiBaseUrl, props.session?.token]);
  const capabilities = useComputeResource((signal) => api.capabilities(signal), [api], unavailableComputeCapabilities);
  const navigate = useCallback((path: string) => { const normalized = normalizeComputePath(path); window.history.pushState({ compute: true }, '', normalized); setLocation(normalized); window.scrollTo({ top: 0, behavior: 'auto' }); }, []);
  const back = useCallback(() => { if (window.history.state?.compute) window.history.back(); else navigate(activeTab(route.path)); }, [navigate, route.path]);
  useEffect(() => { const onPopState = () => { const next = `${window.location.pathname}${window.location.search}`; if (next.startsWith('/compute')) setLocation(next); else props.onExit(); }; window.addEventListener('popstate', onPopState); return () => window.removeEventListener('popstate', onPopState); }, [props]);
  useEffect(() => { const initial = normalizeComputePath(props.initialPath); if (`${window.location.pathname}${window.location.search}` !== initial) window.history.replaceState({ computeRoot: true }, '', initial); }, [props.initialPath]);
  const requireLogin = useCallback((returnTo: string) => onRequireLogin(normalizeComputePath(returnTo)), [onRequireLogin]);
  const pageProps = { api, navigate, requireLogin, signedIn: Boolean(props.session) };
  const title = pageTitle(route.path);
  const resolvedCapabilities = capabilities.data ?? unavailableComputeCapabilities;
  const routeAvailable = capabilities.state !== 'ready' || isRouteAvailable(route.path, resolvedCapabilities);

  let page: React.ReactNode;
  if (!routeAvailable) page = <ErrorState title="能力尚未开放" message="该页面依赖的真实服务尚未接入，当前不会接受或保存相关操作。" onRetry={() => navigate('/compute')} />;
  else if (route.path === '/compute') page = <HomePage {...pageProps} showProductShowcase={resolvedCapabilities.enabled} />;
  else if (route.path === '/compute/offers') page = <OffersPage {...pageProps} initialQuery={route.query} />;
  else if (/^\/compute\/offers\/[^/]+$/.test(route.path)) page = <OfferDetailPage {...pageProps} offerId={routeParam(route.path)} purchasingEnabled={computePurchasingEnabled(resolvedCapabilities)} />;
  else if (route.path.startsWith('/compute/checkout/')) page = props.session ? <CheckoutPage {...pageProps} skuId={routeParam(route.path)} query={route.query} /> : <LoginRedirect returnTo={location} requireLogin={requireLogin} />;
  else if (route.path === '/compute/orders') page = props.session ? <OrdersPage {...pageProps} /> : <LoginRedirect returnTo={location} requireLogin={requireLogin} />;
  else if (/^\/compute\/orders\/[^/]+$/.test(route.path)) page = props.session ? <OrderDetailPage {...pageProps} orderId={routeParam(route.path)} /> : <LoginRedirect returnTo={location} requireLogin={requireLogin} />;
  else if (route.path === '/compute/hosting') page = <HostingPage {...pageProps} interactive={resolvedCapabilities.hosting} />;
  else if (route.path === '/compute/hosting/guide') page = <HostingGuidePage />;
  else if (route.path === '/compute/hosting/apply') page = props.session ? <HostingApplyPage {...pageProps} /> : <LoginRedirect returnTo={location} requireLogin={requireLogin} />;
  else if (route.path === '/compute/hosting/applications') page = props.session ? <HostingApplicationsPage {...pageProps} /> : <LoginRedirect returnTo={location} requireLogin={requireLogin} />;
  else if (/^\/compute\/hosting\/applications\/[^/]+$/.test(route.path)) page = props.session ? <HostingApplicationDetailPage {...pageProps} applicationId={routeParam(route.path)} /> : <LoginRedirect returnTo={location} requireLogin={requireLogin} />;
  else if (route.path === '/compute/devices') page = props.session ? <DevicesPage {...pageProps} initialStatus={(route.query.get('status') ?? undefined) as never} /> : <LoginRedirect returnTo={location} requireLogin={requireLogin} />;
  else if (/^\/compute\/devices\/[^/]+$/.test(route.path)) page = props.session ? <DeviceDetailPage {...pageProps} deviceId={routeParam(route.path)} /> : <LoginRedirect returnTo={location} requireLogin={requireLogin} />;
  else if (route.path === '/compute/news') page = <NewsPage {...pageProps} />;
  else if (/^\/compute\/news\/[^/]+$/.test(route.path)) page = <NewsDetailPage {...pageProps} slug={routeParam(route.path)} />;
  else if (route.path === '/compute/rankings') page = <RankingsPage {...pageProps} />;
  else if (route.path === '/compute/me') page = <ProfilePage {...pageProps} capabilities={capabilities.data ?? unavailableComputeCapabilities} displayName={props.session?.account.displayName ?? ''} />;
  else if (route.path === '/compute/assets') page = resolvedCapabilities.assets ? props.session ? <AssetsPage {...pageProps} /> : <LoginRedirect returnTo={location} requireLogin={requireLogin} /> : <AssetsShowcasePage />;
  else if (route.path === '/compute/referrals') page = props.session ? <ReferralsPage {...pageProps} /> : <LoginRedirect returnTo={location} requireLogin={requireLogin} />;
  else if (route.path === '/compute/support') page = props.session ? <SupportPage onOpenCodTask={props.onOpenCodTask} /> : <LoginRedirect returnTo={location} requireLogin={requireLogin} />;
  else page = <ErrorState title="页面不存在" message="该算力市场页面不存在或尚未由服务端 capability 开放。" onRetry={() => navigate('/compute')} />;

  if (capabilities.state === 'error' && !(capabilities.data?.enabled)) return <div className="compute-app compute-fatal"><ErrorState title="算力市场暂不可用" message={capabilities.error?.message} onRetry={capabilities.reload} /><button type="button" className="compute-button secondary" onClick={props.onExit}>返回 COD</button></div>;
  if (capabilities.state === 'ready' && !capabilities.data?.enabled) return <div className="compute-app compute-fatal"><ErrorState title="算力市场尚未开放" message="真实库存、持久化与统一卡时依赖完成接入前，服务端 capability 会保持关闭。" /><button type="button" className="compute-button secondary" onClick={props.onExit}>返回 COD</button></div>;
  return <ComputeShell path={route.path} title={title} capabilities={resolvedCapabilities} signedIn={Boolean(props.session)} navigate={navigate} back={back} onExit={props.onExit}>{page}</ComputeShell>;
}

function isRouteAvailable(path: string, capabilities: typeof unavailableComputeCapabilities): boolean {
  if (path === '/compute' || path === '/compute/offers' || /^\/compute\/offers\/[^/]+$/.test(path) || path === '/compute/hosting' || path === '/compute/hosting/guide' || path === '/compute/assets') return true;
  if (path.startsWith('/compute/checkout/') || path.startsWith('/compute/orders')) return computePurchasingEnabled(capabilities);
  if (path.startsWith('/compute/hosting')) return capabilities.hosting;
  if (path.startsWith('/compute/devices')) return capabilities.devices;
  if (path.startsWith('/compute/news')) return capabilities.news;
  if (path.startsWith('/compute/rankings')) return capabilities.rankings;
  if (path === '/compute/me') return computeAccountEnabled(capabilities);
  if (path.startsWith('/compute/assets')) return capabilities.assets;
  if (path.startsWith('/compute/referrals')) return capabilities.referrals;
  if (path.startsWith('/compute/support')) return capabilities.services.onlineSupport || capabilities.services.humanSupport;
  return false;
}

function LoginRedirect({ returnTo, requireLogin }: { returnTo: string; requireLogin: (path: string) => void }) {
  useEffect(() => requireLogin(returnTo), [requireLogin, returnTo]); return <div className="compute-skeleton detail-card" aria-label="正在前往登录" />;
}

function pageTitle(path: string): string {
  if (path === '/compute') return '算力市场'; if (path === '/compute/offers') return '全部算力'; if (path.startsWith('/compute/offers/')) return '商品详情';
  if (path.startsWith('/compute/checkout/')) return '确认订单'; if (path === '/compute/orders') return '我的订单'; if (path.startsWith('/compute/orders/')) return '订单详情';
  if (path === '/compute/hosting') return '设备托管'; if (path === '/compute/hosting/guide') return '托管说明'; if (path === '/compute/hosting/apply') return '托管申请'; if (path === '/compute/hosting/applications') return '申请记录'; if (path.startsWith('/compute/hosting/applications/')) return '申请详情';
  if (path === '/compute/devices') return '我的设备'; if (path.startsWith('/compute/devices/')) return '设备详情'; if (path === '/compute/news') return '资讯'; if (path.startsWith('/compute/news/')) return '资讯详情';
  if (path === '/compute/rankings') return '排行榜'; if (path === '/compute/me') return '我的'; if (path === '/compute/assets') return '我的资产'; if (path === '/compute/referrals') return '邀请好友'; if (path === '/compute/support') return '在线客服'; return '算力市场';
}
