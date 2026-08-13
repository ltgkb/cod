import { ArrowDownLeft, ArrowUpRight, Lock, Wallet } from '@phosphor-icons/react';
import { formatCardHours } from '../api';
import { EmptyState } from '../components/EmptyState';
import { ErrorState } from '../components/ErrorState';
import { useComputeResource } from '../hooks/useComputeResource';
import type { ComputePageProps } from './shared';

const ledgerLabels = { purchase: '购买卡时', reward: '奖励卡时', rental_charge: '租赁扣减', rental_refund: '卡时退款', hosting_settlement: '托管结算', discount: '优惠', trade_lock: '交易冻结', trade_release: '交易解冻', trade_transfer: '交易转移' };
export function AssetsPage({ api }: ComputePageProps) {
  const resource = useComputeResource(async (signal) => { const [summary, ledger] = await Promise.all([api.assets(signal), api.ledger(signal)]); return { summary, ledger: ledger.items }; }, []);
  if (resource.state === 'error') return <ErrorState message={resource.error?.message} onRetry={resource.reload} />; if (!resource.data) return <div className="compute-skeleton detail-card" />; const { summary, ledger } = resource.data;
  return <div className="compute-page-stack"><section className="compute-assets-hero"><div><span>COD 可用卡时</span><strong>{formatCardHours(summary.availableCardHoursMilli)}</strong></div><Wallet weight="duotone" /></section><section className="compute-asset-metrics"><div><Lock /><span>交易冻结</span><strong>{formatCardHours(summary.lockedCardHoursMilli)} 卡时</strong></div><div><ArrowUpRight /><span>运行中租赁资源</span><strong>{summary.runningResourceCount}</strong></div>{summary.pendingHostedSettlementCardHoursMilli !== null && <div><ArrowDownLeft /><span>托管待结算</span><strong>{formatCardHours(summary.pendingHostedSettlementCardHoursMilli)} 卡时</strong></div>}</section><section className="compute-panel"><h2>卡时明细账</h2>{ledger.length ? <div className="compute-ledger-list">{ledger.map((entry) => <div key={entry.id}><span className={entry.availableDeltaCardHoursMilli >= 0 ? 'positive' : 'negative'}>{entry.availableDeltaCardHoursMilli >= 0 ? <ArrowDownLeft /> : <ArrowUpRight />}</span><div><strong>{ledgerLabels[entry.type]}</strong><small>{entry.reference} · {new Date(entry.createdAt).toLocaleString('zh-CN')}</small></div><b>{entry.availableDeltaCardHoursMilli >= 0 ? '+' : ''}{formatCardHours(entry.availableDeltaCardHoursMilli)}</b></div>)}</div> : <EmptyState title="暂无卡时明细" description="购买、奖励、租赁扣减、退款和结算将分别写入守恒账本。" />}</section><p className="compute-boundary-note">卡时是平台结算单位，不代表资源使用小时；资源权益按订单可用时长记录。</p></div>;
}
