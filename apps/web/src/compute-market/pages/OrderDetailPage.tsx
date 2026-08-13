import { useState } from 'react';
import { formatCardHours, periodLabel } from '../api';
import { ErrorState } from '../components/ErrorState';
import { StatusTimeline } from '../components/StatusTimeline';
import { useComputeResource } from '../hooks/useComputeResource';
import type { ComputePageProps } from './shared';

export function OrderDetailPage({ api, orderId, navigate }: ComputePageProps & { orderId: string }) {
  const resource = useComputeResource((signal) => api.order(orderId, signal), [orderId]); const [message, setMessage] = useState('');
  if (resource.state === 'error') return <ErrorState message={resource.error?.message} onRetry={resource.reload} />; if (!resource.data) return <div className="compute-skeleton detail-card" />;
  const order = resource.data; const cancellable = ['draft', 'reserved', 'pending_quote', 'quoted', 'pending_settlement'].includes(order.status);
  const cancel = async () => { try { await api.cancelOrder(order.id); setMessage('订单已取消。'); await resource.reload(); } catch (error) { setMessage(error instanceof Error ? error.message : '取消失败'); } };
  return <div className="compute-detail-layout"><div className="compute-detail-primary"><section className="compute-panel"><span className={`compute-status-pill ${order.status}`}>{order.events.at(-1)?.label}</span><h2>{order.skuSnapshot.offerTitle}</h2><dl className="compute-definition-grid"><div><dt>订单号</dt><dd>{order.id}</dd></div><div><dt>GPU</dt><dd>{order.skuSnapshot.gpuModel} / {order.skuSnapshot.gpuMemoryGb} GB</dd></div><div><dt>镜像</dt><dd>{order.skuSnapshot.imageLabel}</dd></div><div><dt>区域</dt><dd>{order.skuSnapshot.regionLabel}</dd></div><div><dt>资源数量</dt><dd>{order.quantity} 台</dd></div><div><dt>可用时长</dt><dd>{order.availableDurationHours} {periodLabel(order.skuSnapshot.period)}</dd></div><div><dt>应扣卡时</dt><dd>{formatCardHours(order.chargedCardHoursMilli)} 卡时</dd></div><div><dt>条款版本</dt><dd>{order.termsVersion}</dd></div><div><dt>联系人</dt><dd>{order.contact.name} · {order.contact.phone.replace(/(\d{3})\d+(\d{2})/, '$1****$2')}</dd></div></dl></section><section className="compute-panel"><h2>状态时间线</h2><StatusTimeline events={order.events} /></section></div><aside className="compute-panel compute-order-actions"><h2>可执行操作</h2><button type="button" className="compute-button secondary" onClick={() => navigate('/compute/support')}>联系支持</button>{cancellable && <button type="button" className="compute-button danger" onClick={cancel}>取消订单</button>}{message && <p role="status">{message}</p>}<p>交付凭据将通过短期一次性领取流程提供，不会出现在普通页面响应或日志中。</p></aside></div>;
}
