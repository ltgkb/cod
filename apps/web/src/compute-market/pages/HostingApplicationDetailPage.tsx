import { ErrorState } from '../components/ErrorState';
import { StatusTimeline } from '../components/StatusTimeline';
import { useComputeResource } from '../hooks/useComputeResource';
import type { ComputePageProps } from './shared';

export function HostingApplicationDetailPage({ api, applicationId }: ComputePageProps & { applicationId: string }) {
  const resource = useComputeResource(async (signal) => { const result = await api.hostingApplications(signal); const item = result.items.find((entry) => entry.id === applicationId); if (!item) throw new Error('托管申请不存在'); return item; }, [applicationId]);
  if (resource.state === 'error') return <ErrorState message={resource.error?.message} onRetry={resource.reload} />; if (!resource.data) return <div className="compute-skeleton detail-card" />; const application = resource.data;
  return <div className="compute-detail-layout"><div className="compute-detail-primary"><section className="compute-panel"><span className={`compute-status-pill ${application.status}`}>{application.events.at(-1)?.label}</span><h2>{application.devices[0]?.gpuModel || '托管申请'}</h2><dl className="compute-definition-grid"><div><dt>主体</dt><dd>{application.subjectType === 'enterprise' ? '企业' : '个人'} · {application.verificationStatus}</dd></div><div><dt>联系人</dt><dd>{application.contactName} · {application.contactPhone.replace(/(\d{3})\d+(\d{2})/, '$1****$2')}</dd></div><div><dt>设备</dt><dd>{application.devices.map((device) => `${device.brand} ${device.model} / ${device.gpuCount} 卡`).join('；')}</dd></div><div><dt>机房需求</dt><dd>{application.rackUnits} U · {application.powerWatts} W · {application.hostingMonths} 个月</dd></div></dl></section><section className="compute-panel"><h2>申请时间线</h2><StatusTimeline events={application.events} /></section></div><aside className="compute-panel"><h2>下一步</h2><strong>{application.nextAction ?? '暂无待办'}</strong><p>责任方：{application.responsibleParty === 'user' ? '用户' : application.responsibleParty === 'cod' ? 'COD' : application.responsibleParty === 'partner' ? '合作方' : '无'}</p><p className="compute-boundary-note">申请与设备是两个实体。只有完成验收后才会创建托管设备并计入“我的设备”。</p></aside></div>;
}

