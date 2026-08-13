import type { ComputeCapabilities } from '@cod/contracts/compute-market-v2';

export const unavailableComputeCapabilities: ComputeCapabilities = {
  enabled: false, instantPurchase: false, reservationPurchase: false, hosting: false, devices: false,
  assets: false, cardHourTrades: false, referrals: false, news: false, rankings: false, hostedSettlements: false, admin: false,
  services: { verification: false, procurement: false, coupons: false, addresses: false, onlineSupport: false, humanSupport: false },
};

export const computePurchasingEnabled = (capabilities: ComputeCapabilities): boolean => capabilities.instantPurchase || capabilities.reservationPurchase;

export const computeAccountEnabled = (capabilities: ComputeCapabilities): boolean =>
  computePurchasingEnabled(capabilities)
  || capabilities.hosting
  || capabilities.devices
  || capabilities.assets
  || capabilities.referrals
  || Object.values(capabilities.services).some(Boolean);

export function visibleBottomTabs(capabilities: ComputeCapabilities) {
  return [
    { path: '/compute', label: '首页', visible: true },
    { path: '/compute/hosting', label: '设备托管', visible: capabilities.enabled },
    { path: '/compute/assets', label: '我的资产', visible: capabilities.enabled },
    { path: '/compute/news', label: '资讯', visible: capabilities.news },
    { path: '/compute/rankings', label: '排行榜', visible: capabilities.rankings },
    { path: '/compute/me', label: '我的', visible: computeAccountEnabled(capabilities) },
  ].filter((item) => item.visible);
}
