import { formatCardHours } from '../api';

export function PriceBreakdown({ subtotal, discount = 0, balance, quote = false }: { subtotal: number; discount?: number; balance?: number; quote?: boolean }) {
  const charged = Math.max(0, subtotal - discount);
  return <section className="compute-price-breakdown"><h2>费用明细</h2><dl><div><dt>租赁费用小计</dt><dd>{quote ? '待报价' : `${formatCardHours(subtotal)} 卡时`}</dd></div>{discount > 0 && <div><dt>卡时优惠</dt><dd>-{formatCardHours(discount)} 卡时</dd></div>}<div className="total"><dt>{quote ? '核验后报价' : '最终应扣'}</dt><dd>{quote ? '人工确认' : `${formatCardHours(charged)} 卡时`}</dd></div>{balance !== undefined && <div><dt>当前可用卡时</dt><dd>{formatCardHours(balance)} 卡时</dd></div>}</dl><p>COD 卡时是平台结算单位；资源权益以可用时长计量，两者互不混用。</p></section>;
}
