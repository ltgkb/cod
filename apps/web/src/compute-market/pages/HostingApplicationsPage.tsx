import { CaretRight } from '@phosphor-icons/react';
import { EmptyState } from '../components/EmptyState';
import { ErrorState } from '../components/ErrorState';
import { useComputeResource } from '../hooks/useComputeResource';
import type { ComputePageProps } from './shared';

const labels = { draft: '草稿', submitted: '已提交', reviewing: '审核中', site_survey: '待验机', quoted: '已报价', contract_pending: '待合同', inbound_pending: '待入场', deploying: '部署中', running: '运行中', action_required: '待处理', offboarding: '退场中', completed: '已完成', rejected: '已拒绝', cancelled: '已取消' };
export function HostingApplicationsPage({ api, navigate }: ComputePageProps) {
  const resource = useComputeResource((signal) => api.hostingApplications(signal), []);
  if (resource.state === 'error') return <ErrorState message={resource.error?.message} onRetry={resource.reload} />; if (!resource.data) return <div className="compute-skeleton list" />;
  return resource.data.items.length ? <div className="compute-order-list">{resource.data.items.map((application) => <button type="button" key={application.id} onClick={() => navigate(`/compute/hosting/applications/${application.id}`)}><div><span>申请 · {application.id.slice(-8).toUpperCase()}</span><i>{labels[application.status]}</i></div><strong>{application.devices[0]?.gpuModel || '设备资料待完善'} · {application.devices.reduce((sum, device) => sum + device.gpuCount, 0)} 卡</strong><small>{application.city || '城市待填写'} · {application.subjectType === 'enterprise' ? '企业' : '个人'}</small><time>{new Date(application.updatedAt).toLocaleString('zh-CN')}</time><CaretRight /></button>)}</div> : <EmptyState title="还没有托管申请" description="开始四步申请，草稿与正式申请会分别显示。" action={<button type="button" className="compute-button primary" onClick={() => navigate('/compute/hosting/apply')}>申请设备托管</button>} />;
}

