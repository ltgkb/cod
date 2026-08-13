import type { ComputeOrderStatus } from '@cod/contracts/compute-market-v2';
import { CaretRight } from '@phosphor-icons/react';
import { useState } from 'react';
import { formatCardHours, periodLabel } from '../api';
import { EmptyState } from '../components/EmptyState';
import { ErrorState } from '../components/ErrorState';
import { useComputeResource } from '../hooks/useComputeResource';
import type { ComputePageProps } from './shared';

const tabs: Array<{ label: string; statuses: ComputeOrderStatus[] }> = [
  { label: '全部', statuses: [] }, { label: '待确认', statuses: ['pending_quote', 'quoted', 'pending_settlement', 'reserved'] },
  { label: '交付中', statuses: ['settled', 'provisioning'] }, { label: '使用中', statuses: ['running', 'action_required'] }, { label: '已完成', statuses: ['completed', 'cancelled', 'refunded'] },
];
const statusLabel: Record<ComputeOrderStatus, string> = { draft: '草稿', reserved: '已预占', pending_quote: '待报价', quoted: '待确认报价', pending_settlement: '待结算', settled: '已结算', provisioning: '交付中', running: '使用中', action_required: '待处理', completed: '已完成', cancelled: '已取消', refund_pending: '退款中', refunded: '已退款' };

export function OrdersPage({ api, navigate }: ComputePageProps) {
  const [tab, setTab] = useState(0); const resource = useComputeResource((signal) => api.orders(undefined, signal), []); const orders = resource.data?.items.filter((order) => !tabs[tab].statuses.length || tabs[tab].statuses.includes(order.status)) ?? [];
  return <div className="compute-page-stack"><div className="compute-tabs" role="tablist">{tabs.map((item, index) => <button type="button" role="tab" aria-selected={tab === index} key={item.label} onClick={() => setTab(index)}>{item.label}</button>)}</div>{resource.state === 'error' ? <ErrorState message={resource.error?.message} onRetry={resource.reload} /> : !resource.data ? <div className="compute-skeleton list" /> : orders.length ? <div className="compute-order-list">{orders.map((order) => <button type="button" key={order.id} onClick={() => navigate(`/compute/orders/${order.id}`)}><div><span>订单 · {order.id.slice(-8).toUpperCase()}</span><i className={order.status}>{statusLabel[order.status]}</i></div><strong>{order.skuSnapshot.gpuModel} · {order.quantity} 台</strong><small>可用 {order.availableDurationHours} {periodLabel(order.skuSnapshot.period)} · {formatCardHours(order.chargedCardHoursMilli)} 卡时</small><time>{new Date(order.updatedAt).toLocaleString('zh-CN')}</time><CaretRight /></button>)}</div> : <EmptyState title="还没有这类订单" description="从真实商品详情提交租赁需求后，状态会显示在这里。" action={<button type="button" className="compute-button primary" onClick={() => navigate('/compute/offers')}>去找算力</button>} />}</div>;
}
