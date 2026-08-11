export class GooseLaunchInterruptedError extends Error {
  constructor() {
    super('Goose launch was interrupted by a renderer lifecycle change');
    this.name='GooseLaunchInterruptedError';
  }
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
