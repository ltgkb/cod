import type { HostedDeviceStatus, HostedDeviceV2 } from '@cod/contracts/compute-market-v2';

const items: Array<{ status: HostedDeviceStatus; label: string; matches: HostedDeviceStatus[] }> = [
  { status: 'pending_review', label: '待审核', matches: ['pending_review'] }, { status: 'deploying', label: '部署中', matches: ['deploying'] },
  { status: 'running', label: '运行中', matches: ['running'] }, { status: 'action_required', label: '待处理', matches: ['action_required', 'maintenance', 'offline'] },
];
export function DeviceStatusSummary({ devices, onSelect }: { devices: HostedDeviceV2[]; onSelect?: (status: HostedDeviceStatus) => void }) {
  return <div className="compute-device-summary">{items.map((item) => <button type="button" key={item.status} onClick={() => onSelect?.(item.status)} disabled={!onSelect}><strong>{devices.filter((device) => item.matches.includes(device.status)).length}</strong><span>{item.label}</span></button>)}</div>;
}
