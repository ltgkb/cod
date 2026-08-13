import { Trophy } from '@phosphor-icons/react';
import { EmptyState } from '../components/EmptyState';
import { ErrorState } from '../components/ErrorState';
import { useComputeResource } from '../hooks/useComputeResource';
import type { ComputePageProps } from './shared';

export function RankingsPage({ api }: ComputePageProps) {
  const resource = useComputeResource((signal) => api.rankings(signal), []); if (resource.state === 'error') return <ErrorState message={resource.error?.message} onRetry={resource.reload} />; if (!resource.data) return <div className="compute-skeleton list" />; const data = resource.data;
  if (!data.enabled) return <EmptyState title="排行榜暂未开放" description="当前没有可核验的真实排行数据，因此入口会由 capability 隐藏。" />;
  return <div className="compute-page-stack"><section className="compute-ranking-meta"><Trophy weight="duotone" /><div><h2>{data.metric}</h2><p>{data.periodLabel} · 更新于 {new Date(data.updatedAt).toLocaleString('zh-CN')} · {data.anonymous ? '默认匿名' : '用户已授权昵称'}</p></div></section><ol className="compute-ranking-list">{data.entries.map((entry) => <li key={entry.rank}><strong>{entry.rank}</strong><span>{entry.displayName}</span><b>{entry.value} {entry.unit}</b></li>)}</ol></div>;
}

