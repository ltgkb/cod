import { ShareNetwork } from '@phosphor-icons/react';
import { ErrorState } from '../components/ErrorState';
import { useComputeResource } from '../hooks/useComputeResource';
import type { ComputePageProps } from './shared';

export function NewsDetailPage({ api, slug }: ComputePageProps & { slug: string }) {
  const resource = useComputeResource((signal) => api.newsEntry(slug, signal), [slug]); if (resource.state === 'error') return <ErrorState message={resource.error?.message} onRetry={resource.reload} />; if (!resource.data) return <div className="compute-skeleton detail-card" />; const entry = resource.data;
  return <article className="compute-article"><header><span>{entry.category}</span><h2>{entry.title}</h2><div><time>{new Date(entry.publishedAt).toLocaleString('zh-CN')}</time><button type="button" onClick={() => navigator.share?.({ title: entry.title, url: location.href })}><ShareNetwork /> 分享</button></div></header><div className="compute-article-body" dangerouslySetInnerHTML={{ __html: entry.sanitizedHtml }} /></article>;
}

