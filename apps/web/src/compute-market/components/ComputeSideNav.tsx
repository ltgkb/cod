import type { ComputeCapabilities } from '@cod/contracts/compute-market-v2';
import { ArrowLeft, ChartBar, Cpu, HardDrives, House, Newspaper, Package, UserCircle, Wallet } from '@phosphor-icons/react';
import { activeTab } from '../routes';
import { computeAccountEnabled, computePurchasingEnabled } from '../capabilities';

export function ComputeSideNav({ path, capabilities, navigate, onExit }: { path: string; capabilities: ComputeCapabilities; navigate: (path: string) => void; onExit: () => void }) {
  const active = activeTab(path);
  const items = [
    { path: '/compute', label: '首页', icon: House, visible: true }, { path: '/compute/offers', label: '全部算力', icon: HardDrives, visible: true },
    { path: '/compute/hosting', label: '设备托管', icon: Cpu, visible: capabilities.enabled }, { path: '/compute/assets', label: '我的资产', icon: Wallet, visible: capabilities.enabled },
    { path: '/compute/orders', label: '我的订单', icon: Package, visible: computePurchasingEnabled(capabilities) },
    { path: '/compute/news', label: '资讯', icon: Newspaper, visible: capabilities.news }, { path: '/compute/rankings', label: '排行榜', icon: ChartBar, visible: capabilities.rankings },
    { path: '/compute/me', label: '我的', icon: UserCircle, visible: computeAccountEnabled(capabilities) },
  ];
  const selected = (itemPath: string) => path === itemPath || (itemPath === '/compute/offers' && path.startsWith('/compute/offers/')) || (itemPath === '/compute/orders' && path.startsWith('/compute/orders/')) || (itemPath !== '/compute' && active === itemPath);
  return <aside className="compute-side-nav"><button type="button" className="compute-brand" onClick={() => navigate('/compute')}><span>COD</span><small>算力市场</small></button><nav aria-label="算力市场侧栏">{items.filter((item) => item.visible).map((item) => <button type="button" key={item.path} className={selected(item.path) ? 'active' : ''} onClick={() => navigate(item.path)}><item.icon aria-hidden /><span>{item.label}</span></button>)}</nav><button type="button" className="compute-exit" onClick={onExit}><ArrowLeft aria-hidden /> 返回 COD</button></aside>;
}
