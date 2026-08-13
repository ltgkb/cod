import type { ComputeOfferV2 } from '@cod/contracts/compute-market-v2';

export function SpecGrid({ offer, detailed = false }: { offer: ComputeOfferV2; detailed?: boolean }) {
  const specs = detailed ? [
    ['CPU', `${offer.specs.cpuModel}${offer.specs.cpuCores ? ` · ${offer.specs.cpuCores} 核` : ''}`, `驱动 ${offer.specs.driverVersion}`],
    ['RAM', `${offer.specs.ramGb} GB`, '内存'],
    ['硬盘', `${offer.specs.systemDiskGb} GB 系统盘${offer.specs.dataDiskGb ? ` · ${offer.specs.dataDiskGb} GB 数据盘` : ''}`, '存储'],
    ['CUDA', offer.specs.cudaVersion, '运行环境'],
    ['网络', offer.specs.networkLabel, '网络'],
    ['区域', offer.regionLabel, '交付区域'],
  ] : [
    ['CPU', offer.specs.cpuModel, `驱动 ${offer.specs.driverVersion}`], ['RAM', `${offer.specs.ramGb} GB`, '内存'],
    ['SYS', `${offer.specs.systemDiskGb} GB`, '系统盘'], ['CUDA', offer.specs.cudaVersion, '版本'],
  ];
  return <dl className={`compute-spec-grid ${detailed ? 'detailed' : ''}`}>{specs.map(([label, value, detail]) => <div key={label}><dt>{label} <small>{detail}</small></dt><dd>{value}</dd></div>)}</dl>;
}

