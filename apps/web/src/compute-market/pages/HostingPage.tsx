import { ClipboardText, Cpu, FileText, HardDrives, ShieldCheck } from '@phosphor-icons/react';
import { DeviceStatusSummary } from '../components/DeviceStatusSummary';
import { ErrorState } from '../components/ErrorState';
import { useComputeResource } from '../hooks/useComputeResource';
import type { ComputePageProps } from './shared';

export function HostingPage({ api, navigate, signedIn, requireLogin }: ComputePageProps) {
  const devices = useComputeResource((signal) => signedIn ? api.devices(undefined, signal).then((result) => result.items) : Promise.resolve([]), [signedIn]);
  const open = (path: string) => signedIn ? navigate(path) : requireLogin(path);
  if (devices.state === 'error') return <ErrorState message={devices.error?.message} onRetry={devices.reload} />;
  return <div className="compute-page-stack"><section className="compute-hosting-hero"><div><span>COD 设备托管</span><h2>让设备接入真实可追踪的托管生命周期</h2><p>从资料审核、验机、报价合同到部署运行与退场，每一步明确状态与责任方。</p></div><Cpu weight="duotone" /></section><section className="compute-panel"><div className="compute-section-heading"><div><h2>设备状态</h2><p>申请记录不会提前计入设备或资产</p></div></div><DeviceStatusSummary devices={devices.data ?? []} onSelect={signedIn ? (status) => navigate(`/compute/devices?status=${status}`) : undefined} /></section><section className="compute-hosting-actions"><button type="button" className="primary" onClick={() => open('/compute/hosting/apply')}><ClipboardText /><span><strong>申请设备托管</strong><small>分四步提交并支持草稿</small></span></button><button type="button" onClick={() => open('/compute/devices')}><HardDrives /><span><strong>我的设备</strong><small>查看运行与异常</small></span></button><button type="button" onClick={() => open('/compute/hosting/applications')}><FileText /><span><strong>申请记录</strong><small>跟踪审核与合同</small></span></button><button type="button" onClick={() => navigate('/compute/hosting/guide')}><ShieldCheck /><span><strong>托管说明</strong><small>了解责任边界</small></span></button></section><section className="compute-panel"><h2>托管流程</h2><ol className="compute-process"><li>提交资料</li><li>商务审核</li><li>现场/远程验机</li><li>报价与合同</li><li>入场部署</li><li>运行</li><li>退场</li></ol><p className="compute-boundary-note">提交申请不代表 COD 已接收设备。正式权责以书面合同中的合同主体、设备保管、保险、SLA、赔付、结算和退场条款为准。</p></section></div>;
}
