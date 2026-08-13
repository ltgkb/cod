import { useCallback, useEffect, useRef, useState } from 'react';
import type { ComputeLoadState } from '../types';

export function useComputeResource<T>(loader: (signal: AbortSignal) => Promise<T>, dependencies: readonly unknown[], initialValue: T | null = null) {
  const [data, setData] = useState<T | null>(initialValue);
  const [state, setState] = useState<ComputeLoadState>('idle');
  const [error, setError] = useState<Error | null>(null);
  const loaderRef = useRef(loader); loaderRef.current = loader;
  const controllerRef = useRef<AbortController | null>(null);
  const dataRef = useRef(data); dataRef.current = data;
  const load = useCallback(async (refresh = false) => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setState((current) => refresh && (current === 'ready' || current === 'offline') ? 'refreshing' : 'loading'); setError(null);
    try { const next = await loaderRef.current(controller.signal); setData(next); setState('ready'); }
    catch (caught) { if (controller.signal.aborted) return; setError(caught instanceof Error ? caught : new Error('加载失败')); setState((caught as { code?: string }).code === 'offline' && dataRef.current ? 'offline' : 'error'); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, dependencies);
  useEffect(() => { void load(); return () => controllerRef.current?.abort(); }, [load]);
  return { data, state, error, reload: () => load(true), setData };
}
