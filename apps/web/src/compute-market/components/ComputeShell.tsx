import type { PropsWithChildren } from 'react';
import type { ComputeCapabilities } from '@cod/contracts/compute-market-v2';
import { ArrowLeft, Bell, Gear, UserCircle } from '@phosphor-icons/react';
import { isDetailPath } from '../routes';
import { ComputeBottomNav } from './ComputeBottomNav';
import { ComputeSideNav } from './ComputeSideNav';

export function ComputeShell({ path, title, capabilities, signedIn, navigate, back, onExit, children }: PropsWithChildren<{ path: string; title: string; capabilities: ComputeCapabilities; signedIn: boolean; navigate: (path: string) => void; back: () => void; onExit: () => void }>) {
  const detail = isDetailPath(path);
  return <div className="compute-app"><ComputeSideNav path={path} capabilities={capabilities} navigate={navigate} onExit={onExit} /><div className="compute-main"><header className="compute-topbar">{detail ? <button type="button" className="compute-icon-button" aria-label="返回" onClick={back}><ArrowLeft /></button> : <span className="compute-mobile-mark">COD</span>}<div><h1>{title}</h1><small>COD COMPUTE</small></div><div className="compute-top-actions"><button type="button" className="compute-icon-button" aria-label="通知"><Bell /></button><button type="button" className="compute-icon-button" aria-label={signedIn ? '账户' : '登录'} onClick={() => navigate('/compute/me')}>{signedIn ? <UserCircle weight="fill" /> : <Gear />}</button></div></header><main className={detail ? 'compute-content detail' : 'compute-content'}>{children}</main>{!detail && <ComputeBottomNav path={path} capabilities={capabilities} navigate={navigate} />}</div></div>;
}

