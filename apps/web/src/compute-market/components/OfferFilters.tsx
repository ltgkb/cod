import type { ComputeOfferFilters as Filters } from '@cod/contracts/compute-market-v2';
import { Funnel, X } from '@phosphor-icons/react';
import { useState } from 'react';

const groups: Array<{ key: keyof Filters; label: string; options: Array<[string, string]> }> = [
  { key: 'gpuSeries', label: 'GPU 系列', options: [['RTX', 'RTX'], ['A100', 'A100'], ['H100', 'H100'], ['H200', 'H200'], ['L40S', 'L40S'], ['B300', 'B300']] },
  { key: 'memoryGb', label: '显存档位', options: [['24', '24 GB+'], ['48', '48 GB+'], ['80', '80 GB+'], ['140', '140 GB+'], ['280', '280 GB+']] },
  { key: 'useCase', label: '用途', options: [['训练', '训练'], ['推理', '推理'], ['生成式AI', 'AIGC'], ['渲染', '渲染'], ['科研', '科研']] },
  { key: 'deliveryMode', label: '交付形态', options: [['container', '容器'], ['virtual_machine', '虚拟机'], ['bare_metal', '裸金属']] },
];

export function OfferFilters({ filters, onChange }: { filters: Filters; onChange: (filters: Filters) => void }) {
  const [open, setOpen] = useState(false); const activeCount = Object.values(filters).filter(Boolean).length;
  const content = <><div className="compute-filter-heading"><strong>筛选算力</strong><button type="button" onClick={() => setOpen(false)} aria-label="关闭筛选"><X /></button></div>{groups.map((group) => <fieldset key={String(group.key)}><legend>{group.label}</legend><div className="compute-filter-options">{group.options.map(([value, label]) => <button type="button" key={value} className={String(filters[group.key] ?? '') === value ? 'active' : ''} onClick={() => onChange({ ...filters, [group.key]: String(filters[group.key] ?? '') === value ? undefined : group.key === 'memoryGb' ? Number(value) : value })}>{label}</button>)}</div></fieldset>)}<label className="compute-sort-label">排序<select value={filters.sort ?? 'relevance'} onChange={(event) => onChange({ ...filters, sort: event.target.value as Filters['sort'] })}><option value="relevance">综合</option><option value="price_asc">价格升序</option><option value="price_desc">价格降序</option><option value="memory">显存</option><option value="popular">热度</option></select></label><div className="compute-filter-actions"><button type="button" className="compute-button secondary" onClick={() => onChange({})}>重置</button><button type="button" className="compute-button primary" onClick={() => setOpen(false)}>查看结果</button></div></>;
  return <><button type="button" className="compute-filter-trigger" onClick={() => setOpen(true)}><Funnel aria-hidden /> 筛选{activeCount ? <span>{activeCount}</span> : null}</button><aside className={`compute-filter-panel ${open ? 'open' : ''}`} aria-label="算力筛选">{content}</aside>{open && <button type="button" className="compute-filter-scrim" aria-label="关闭筛选" onClick={() => setOpen(false)} />}</>;
}
