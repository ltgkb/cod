import type { ComputeOfferV2 } from '@cod/contracts/compute-market-v2';

const deliveryLabels = { container: '容器实例', virtual_machine: '独占虚拟机', bare_metal: '裸金属整机' } as const;

export function SpecGrid({ offer, detailed = false }: { offer: ComputeOfferV2; detailed?: boolean }) {
  const sku = offer.skus[0];
  const image = sku?.imageOptions[0];
  const imageLabel = image ? [image.framework, image.frameworkVersion].filter(Boolean).join(' ') : '交付前选择';
  const storage = offer.specs.storageLabel ?? `${offer.specs.systemDiskGb} GB 系统盘${offer.specs.dataDiskGb ? ` + ${offer.specs.dataDiskGb} GB 数据盘` : ''}`;
  const specs = detailed ? [
    ['GPU', `${offer.gpu.countPerUnit} × ${offer.gpu.model} / ${offer.gpu.memoryGb} GB`, '设备'],
    ['交付', sku ? deliveryLabels[sku.deliveryMode] : '交付前确认', '资源形态'],
    ['CPU', `${offer.specs.cpuModel}${offer.specs.cpuCores ? ` · ${offer.specs.cpuCores} 核` : ''}`, `驱动 ${offer.specs.driverVersion}`],
    ['RAM', `${offer.specs.ramGb} GB`, '内存'],
    ['存储', storage, '系统与数据盘'],
    ['互联', offer.specs.gpuInterconnectLabel ?? '交付前确认', 'GPU 拓扑'],
    ['CUDA', offer.specs.cudaVersion, '运行环境'],
    ['镜像', imageLabel, image?.operatingSystem ?? '操作系统交付前确认'],
    ['网络', offer.specs.networkLabel, '网络'],
    ['功耗', offer.specs.powerLabel ?? '交付前确认', '设备'],
    ['区域', offer.regionLabel, '交付区域'],
  ] : [
    ['交付', sku ? deliveryLabels[sku.deliveryMode] : '待确认', '资源形态'],
    ['镜像', imageLabel, image?.operatingSystem ?? '运行环境'],
    ['RAM', `${offer.specs.ramGb} GB`, '内存'],
    ['存储', offer.specs.storageLabel ?? `${offer.specs.systemDiskGb} GB 系统盘`, '本地盘'],
  ];
  return <dl className={`compute-spec-grid ${detailed ? 'detailed' : ''}`}>{specs.map(([label, value, detail]) => <div key={label}><dt>{label} <small>{detail}</small></dt><dd>{value}</dd></div>)}</dl>;
}
