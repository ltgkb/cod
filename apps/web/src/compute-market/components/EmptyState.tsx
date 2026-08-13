import type { ReactNode } from 'react';

export function EmptyState({ title, description, action }: { title: string; description: string; action?: ReactNode }) {
  return <section className="compute-state-card" aria-label={title}><span className="compute-state-icon" aria-hidden>◇</span><h2>{title}</h2><p>{description}</p>{action}</section>;
}

