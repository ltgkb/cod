import type { ChildProcess } from 'node:child_process';

function childHasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

export class GooseLaunchInterruptedError extends Error {
  constructor() {
    super('Goose launch was interrupted by a renderer lifecycle change');
    this.name='GooseLaunchInterruptedError';
  }
}

export async function terminateChildProcess(processToStop: ChildProcess | null, timeoutMilliseconds = 2_000): Promise<void> {
  if (!processToStop || childHasExited(processToStop)) return;
  await new Promise<void>((resolve) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      processToStop.removeListener('exit', finish);
      resolve();
    };
    const timeout = setTimeout(() => {
      try { processToStop.kill('SIGKILL'); }
      finally { finish(); }
    }, Math.max(0, timeoutMilliseconds));
    processToStop.once('exit', finish);
    if (childHasExited(processToStop)) { finish(); return; }
    try { processToStop.kill(); }
    catch { finish(); }
  });
}

export function forceTerminateChildProcess(processToStop: ChildProcess | null): void {
  if (!processToStop || childHasExited(processToStop)) return;
  try { processToStop.kill('SIGKILL'); }
  catch { /* The process already exited between the check and the signal. */ }
}

export class GooseLaunchCoordinator {
  private generation=0;
  private tail:Promise<void>=Promise.resolve();

  run<T>(operation:(assertCurrent:()=>void)=>Promise<T>):Promise<T>{
    const generation=this.generation;
    const current=this.tail.catch(()=>undefined).then(async()=>{
      const assertCurrent=()=>{if(generation!==this.generation)throw new GooseLaunchInterruptedError();};
      assertCurrent();
      return operation(assertCurrent);
    });
    this.tail=current.then(()=>undefined,()=>undefined);
    return current;
  }

  invalidate(stop:()=>Promise<void>):Promise<void>{
    this.generation+=1;
    const previous=this.tail;
    const stopping=Promise.resolve().then(stop);
    this.tail=Promise.allSettled([previous,stopping]).then(()=>undefined);
    return stopping;
  }
}
