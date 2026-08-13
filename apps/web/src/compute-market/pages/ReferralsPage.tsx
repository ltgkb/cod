import { Copy, ShareNetwork } from '@phosphor-icons/react';
import { useState } from 'react';
import { formatCardHours } from '../api';
import { EmptyState } from '../components/EmptyState';
import { ErrorState } from '../components/ErrorState';
import { useComputeResource } from '../hooks/useComputeResource';
import type { ComputePageProps } from './shared';

export function ReferralsPage({ api }: ComputePageProps) {
  const resource = useComputeResource((signal) => api.referrals(signal), []); const [message, setMessage] = useState(''); if (resource.state === 'error') return <ErrorState message={resource.error?.message} onRetry={resource.reload} />; if (!resource.data) return <div className="compute-skeleton detail-card" />; const data = resource.data;
  const copy = async () => { await navigator.clipboard?.writeText(data.inviteUrl); setMessage('邀请链接已复制。'); };
  const share = async () => { if (navigator.share) await navigator.share({ title: 'COD 算力市场', text: data.rule, url: data.inviteUrl }); else await copy(); };
  return <div className="compute-page-stack"><section className="compute-referral-hero"><span>我的邀请码</span><strong>{data.inviteCode}</strong><p>{data.inviteUrl}</p><div><button type="button" onClick={copy}><Copy /> 复制链接</button><button type="button" onClick={share}><ShareNetwork /> 系统分享</button></div>{message && <small role="status">{message}</small>}</section><section className="compute-panel"><h2>奖励规则</h2><p>{data.rule}</p></section><section className="compute-panel"><h2>邀请记录</h2>{data.records.length ? data.records.map((record) => <div key={record.id}>{record.maskedInvitee} · {formatCardHours(record.rewardCardHoursMilli)} 卡时 · {record.status}</div>) : <EmptyState title="还没有邀请记录" description="分享链接后，奖励状态会由服务端根据真实条件更新。" />}</section></div>;
}
