import type { ComputeCapabilities } from '@cod/contracts/compute-market-v2';
import { ChartBar, Cpu, House, Newspaper, UserCircle, Wallet } from '@phosphor-icons/react';
import { visibleBottomTabs } from '../capabilities';
import { activeTab } from '../routes';

const icons = { '/compute': House, '/compute/hosting': Cpu, '/compute/assets': Wallet, '/compute/news': Newspaper, '/compute/rankings': ChartBar, '/compute/me': UserCircle };
export function ComputeBottomNav({ path, capabilities, navigate }: { path: string; capabilities: ComputeCapabilities; navigate: (path: string) => void }) {
  const active = activeTab(path);
  return <nav className="compute-bottom-nav" aria-label="算力市场主导航">{visibleBottomTabs(capabilities).map((item) => { const Icon = icons[item.path as keyof typeof icons]; return <button type="button" key={item.path} aria-current={active === item.path ? 'page' : undefined} onClick={() => navigate(item.path)}><Icon weight={active === item.path ? 'fill' : 'regular'} aria-hidden /><span>{item.label}</span></button>; })}</nav>;
}
