export function ErrorState({ title = '暂时无法加载', message, onRetry }: { title?: string; message?: string; onRetry?: () => void }) {
  return <section className="compute-state-card compute-error-state" role="alert"><span className="compute-state-icon" aria-hidden>!</span><h2>{title}</h2><p>{message ?? '请检查网络后重试。'}</p>{onRetry && <button type="button" className="compute-button secondary" onClick={onRetry}>重新加载</button>}</section>;
}

