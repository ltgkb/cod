import type { ComputeOfferFilters as Filters } from '@cod/contracts/compute-market-v2';
import { EmptyState } from '../components/EmptyState';
import { ErrorState } from '../components/ErrorState';
import { OfferCard } from '../components/OfferCard';
import { OfferFilters } from '../components/OfferFilters';
import { useComputeResource } from '../hooks/useComputeResource';
import type { ComputePageProps } from './shared';

export function OffersPage({ api, navigate, initialQuery }: ComputePageProps & { initialQuery: URLSearchParams }) {
  const queryFilters = Object.fromEntries(initialQuery) as Filters; if (queryFilters.memoryGb) queryFilters.memoryGb = Number(queryFilters.memoryGb);
  const resource = useComputeResource((signal) => api.offers(queryFilters, signal), [initialQuery.toString()]);
  const update = (next: Filters) => { const query = new URLSearchParams(); for (const [key, value] of Object.entries(next)) if (value !== undefined && value !== '') query.set(key, String(value)); navigate(`/compute/offers${query.size ? `?${query}` : ''}`); };
  return <div className="compute-catalog-layout"><OfferFilters filters={queryFilters} onChange={update} /><section className="compute-catalog-results"><div className="compute-results-heading"><div><h2>全部算力</h2><p>{resource.data ? `${resource.data.items.length} 个可浏览商品` : '正在加载真实商品'}</p></div></div>{resource.state === 'error' && !resource.data ? <ErrorState message={resource.error?.message} onRetry={resource.reload} /> : !resource.data ? <div className="compute-offer-grid"><div className="compute-skeleton card" /><div className="compute-skeleton card" /></div> : resource.data.items.length ? <div className="compute-offer-grid">{resource.data.items.map((offer) => <OfferCard key={offer.id} offer={offer} onOpen={() => navigate(`/compute/offers/${offer.id}`)} />)}</div> : <EmptyState title="没有符合条件的商品" description="当前筛选组合暂无结果。" action={<button type="button" className="compute-button primary" onClick={() => update({})}>清除筛选</button>} />}</section></div>;
}

