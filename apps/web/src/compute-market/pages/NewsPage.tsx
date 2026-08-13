import { CaretRight, Newspaper } from '@phosphor-icons/react';
import { EmptyState } from '../components/EmptyState';
import { ErrorState } from '../components/ErrorState';
import { useComputeResource } from '../hooks/useComputeResource';
import type { ComputePageProps } from './shared';

export function NewsPage({ api, navigate }: ComputePageProps) {
  const resource = useComputeResource((signal) => api.news(signal), []); if (resource.state === 'error') return <ErrorState message={resource.error?.message} onRetry={resource.reload} />; if (!resource.data) return <div className="compute-skeleton list" />;
  return resource.data.items.length ? <div className="compute-news-list">{resource.data.items.map((entry) => <button type="button" key={entry.id} onClick={() => navigate(`/compute/news/${entry.slug}`)}><span className="compute-news-cover">{entry.coverUrl ? <img src={entry.coverUrl} alt="" /> : <Newspaper weight="duotone" />}</span><div><span>{entry.category}</span><h2>{entry.title}</h2><p>{entry.summary}</p><time>{new Date(entry.publishedAt).toLocaleDateString('zh-CN')}</time></div><CaretRight /></button>)}</div> : <EmptyState title="暂无已发布资讯" description="这里只展示经过审核并已发布的内容，不会用占位消息冒充资讯。" />;
}

