import type { ComputeOfferV2 } from '@cod/contracts/compute-market-v2';
import { CaretRight } from '@phosphor-icons/react';
import { formatCardHours, periodLabel } from '../api';
import { SpecGrid } from './SpecGrid';

export function OfferCard({ offer, onOpen }: { offer: ComputeOfferV2; onOpen: (offer: ComputeOfferV2) => void }) {
  const sku = offer.skus[0]; const discounted = sku?.compareAtPriceCardHoursMilli !== null && sku?.compareAtPriceCardHoursMilli !== undefined && sku.priceCardHoursMilli !== null && sku.compareAtPriceCardHoursMilli > sku.priceCardHoursMilli;
  const showcase = offer.tags.includes('方案展示');
  const reference = offer.priceReference; const referencePrice = reference ? reference.low === reference.high ? `$${reference.low.toFixed(2)}` : `$${reference.low.toFixed(2)}-$${reference.high.toFixed(2)}` : '';
  return <article className="compute-offer-card" tabIndex={0} role="link" aria-label={`查看 ${offer.title} 详情`} onClick={() => onOpen(offer)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpen(offer); } }}>
    <div className="compute-offer-media"><img src={offer.media[0]?.url} alt={offer.media[0]?.alt ?? offer.title} /><span className="compute-badge">{showcase ? '展示' : '热租'}</span></div>
    <div className="compute-offer-body"><h3>{offer.title}</h3><div className="compute-price-band"><strong>{formatCardHours(sku?.priceCardHoursMilli)}</strong><span>{sku?.priceCardHoursMilli === null || sku?.priceCardHoursMilli === undefined ? `/${sku ? periodLabel(sku.period) : '小时'}` : `卡时/${sku ? periodLabel(sku.period) : '小时'}`}</span>{discounted && <del>{formatCardHours(sku.compareAtPriceCardHoursMilli)}卡时</del>}</div>{reference && <p className="compute-external-price">外部公开参考 {referencePrice} / GPU 小时</p>}
      <div className="compute-tags">{offer.tags.slice(0, 3).map((tag) => <span key={tag}>{tag}</span>)}</div><SpecGrid offer={offer} />
      <div className="compute-card-footer"><span className={`compute-stock ${offer.availability.level}`}>{offer.availability.label}</span><span>查看详情 <CaretRight aria-hidden /></span></div>
    </div>
  </article>;
}
