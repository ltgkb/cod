import type { ComputeStatusEvent } from '@cod/contracts/compute-market-v2';

export function StatusTimeline({ events }: { events: ComputeStatusEvent[] }) {
  return <ol className="compute-timeline">{[...events].reverse().map((entry, index) => <li key={entry.id} className={index === 0 ? 'current' : ''}><span aria-hidden /><div><strong>{entry.label}</strong><time dateTime={entry.createdAt}>{new Date(entry.createdAt).toLocaleString('zh-CN')}</time>{entry.note && <p>{entry.note}</p>}</div></li>)}</ol>;
}

