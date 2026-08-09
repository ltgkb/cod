import { describe, expect, it } from 'vitest';
import { buildCodeExecutionPrompt, validateCodeRun, type GooseRunResult } from './goose';

const result=(overrides:Partial<GooseRunResult>={}):GooseRunResult=>({answer:'完成',toolCalls:1,completedTools:1,failedTools:0,mutationTools:1,...overrides});

describe('COD desktop execution guard',()=>{
  it('instructs the agent to execute instead of promising future work',()=>{
    const prompt=buildCodeExecutionPrompt('创建 2048 小游戏');
    expect(prompt).toContain('Execute the user\'s request now');
    expect(prompt).toContain('Do not merely promise to start');
    expect(prompt).toContain('创建 2048 小游戏');
  });

  it('rejects conversational answers that did not invoke project tools',()=>{
    expect(()=>validateCodeRun('创建 2048 小游戏',result({toolCalls:0,completedTools:0,mutationTools:0}))).toThrow('没有执行任何项目工具');
  });

  it('requires a mutation tool for creation and modification requests',()=>{
    expect(()=>validateCodeRun('帮我创建 2048 小游戏',result({mutationTools:0}))).toThrow('没有执行文件修改');
    expect(()=>validateCodeRun('解释这个项目',result({mutationTools:0}))).not.toThrow();
  });

  it('does not complete when every project tool failed',()=>{
    expect(()=>validateCodeRun('检查项目',result({completedTools:0,failedTools:1,mutationTools:0}))).toThrow('项目工具全部失败');
  });
});
