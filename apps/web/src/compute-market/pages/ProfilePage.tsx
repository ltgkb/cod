import type { ComputeCapabilities } from '@cod/contracts/compute-market-v2';
import { ChatCircleDots, Cpu, IdentificationCard, MapPin, Package, SealCheck, Storefront, Ticket, UserCircle, Users } from '@phosphor-icons/react';
import { formatCardHours } from '../api';
import { DeviceStatusSummary } from '../components/DeviceStatusSummary';
import { useComputeResource } from '../hooks/useComputeResource';
import type { ComputePageProps } from './shared';

export function ProfilePage({ api, navigate, signedIn, requireLogin, capabilities, displayName }: ComputePageProps & { capabilities: ComputeCapabilities; displayName: string }) {
  const resource = useComputeResource(async (signal) => { if (!signedIn) return { assets: null, devices: [] }; const [assets, devicePage] = await Promise.all([api.assets(signal), api.devices(undefined, signal)]); return { assets, devices: devicePage.items }; }, [signedIn]);
  if (!signedIn) return <section className="compute-login-card"><UserCircle weight="duotone" /><h2>登录后管理算力资产与设备</h2><p>登录成功后会恢复当前页面与未提交表单。</p><button type="button" className="compute-button primary" onClick={() => requireLogin('/compute/me')}>登录 COD</button></section>;
  const services = [
    { label: '实名认证', path: '/compute/verification', icon: IdentificationCard, visible: capabilities.services.verification }, { label: '线下采购', path: '/compute/procurement', icon: Storefront, visible: capabilities.services.procurement },
    { label: '优惠券', path: '/compute/coupons', icon: Ticket, visible: capabilities.services.coupons }, { label: '地址管理', path: '/compute/addresses', icon: MapPin, visible: capabilities.services.addresses },
    { label: '算力入驻', path: '/compute/hosting/apply', icon: SealCheck, visible: capabilities.hosting }, { label: '在线客服', path: '/compute/support', icon: ChatCircleDots, visible: capabilities.services.onlineSupport },
  ];
  return <div className="compute-page-stack"><section className="compute-profile-head"><UserCircle weight="fill" /><div><h2>{displayName || 'COD 用户'}</h2><p>统一 COD 账户</p></div></section><section className="compute-profile-cards"><button type="button" onClick={() => navigate('/compute/assets')}><span>我的资产</span><strong>{resource.data?.assets ? `${formatCardHours(resource.data.assets.availableCardHoursMilli)} 卡时` : '查看资产'}</strong><small>可用、冻结与账本分开记录</small></button>{capabilities.referrals && <button type="button" onClick={() => navigate('/compute/referrals')}><span>邀请好友</span><strong><Users /> 邀请记录</strong><small>奖励由真实条件触发入账</small></button>}</section><section className="compute-panel"><div className="compute-section-heading"><div><h2>我的设备</h2><p>只有完成验收的托管设备才会显示</p></div><button type="button" onClick={() => navigate('/compute/devices')}>全部设备</button></div><DeviceStatusSummary devices={resource.data?.devices ?? []} onSelect={(status) => navigate(`/compute/devices?status=${status}`)} /></section><section><h2 className="compute-service-title">服务</h2><div className="compute-service-grid">{services.filter((service) => service.visible).map((service) => <button type="button" key={service.path} onClick={() => navigate(service.path)}><service.icon weight="duotone" /><span>{service.label}</span></button>)}<button type="button" onClick={() => navigate('/compute/orders')}><Package weight="duotone" /><span>我的订单</span></button><button type="button" onClick={() => navigate('/compute/hosting')}><Cpu weight="duotone" /><span>托管说明</span></button></div></section><footer className="compute-signature">COD · 可信赖的算力工作空间</footer></div>;
}

