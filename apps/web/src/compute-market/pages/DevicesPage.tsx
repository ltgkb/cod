import type { HostedDeviceStatus } from '@cod/contracts/compute-market-v2';
import { CaretRight, Pulse } from '@phosphor-icons/react';
import { DeviceStatusSummary } from '../components/DeviceStatusSummary';
import { EmptyState } from '../components/EmptyState';
import { ErrorState } from '../components/ErrorState';
import { useComputeResource } from '../hooks/useComputeResource';
import type { ComputePageProps } from './shared';

const labels: Record<HostedDeviceStatus, string> = { pending_review: '待审核', deploying: '部署中', running: '运行中', action_required: '待处理', maintenance: '维护中', offline: '离线', retired: '已退场' };
export function DevicesPage({ api, navigate, initialStatus }: ComputePageProps & { initialStatus?: HostedDeviceStatus }) {
  const resource = useComputeResource((signal) => api.devices(initialStatus, signal), [initialStatus]); if (resource.state === 'error') return <ErrorState message={resource.error?.message} onRetry={resource.reload} />; if (!resource.data) return <div className="compute-skeleton list" />;
  return <div className="compute-page-stack"><section className="compute-panel"><DeviceStatusSummary devices={resource.data.items} onSelect={(status) => navigate(`/compute/devices?status=${status}`)} /></section>{resource.data.items.length ? <div className="compute-device-list">{resource.data.items.map((device) => <button type="button" key={device.id} onClick={() => navigate(`/compute/devices/${device.id}`)}><div><span className={`compute-status-pill ${device.status}`}>{labels[device.status]}</span><strong>{device.name}</strong><small>{device.gpuModel} · {device.gpuCount} 卡</small></div><dl><div><dt>机房区域</dt><dd>{device.regionLabel}</dd></div><div><dt>最近心跳</dt><dd>{device.lastHeartbeatAt ? new Date(device.lastHeartbeatAt).toLocaleString('zh-CN') : '监控未接入'}</dd></div>{device.availability24hPercent !== null && <div><dt>24h 可用率</dt><dd>{device.availability24hPercent}%</dd></div>}</dl>{device.actionRequired && <p><Pulse /> {device.actionRequired}</p>}<CaretRight /></button>)}</div> : <EmptyState title="暂无托管设备" description="申请记录不会计入设备。完成验收和部署后，真实设备会显示在这里。" action={<button type="button" className="compute-button primary" onClick={() => navigate('/compute/hosting/apply')}>申请设备托管</button>} />}</div>;
}

