import { describe, expect, it } from 'vitest';
import { buildCodeExecutionPrompt, requestLikelyRequiresMutation, validateCodeRun, type GooseRunResult } from './goose';

const result=(overrides:Partial<GooseRunResult>={}):GooseRunResult=>({answer:'完成',toolCalls:1,completedTools:1,failedTools:0,mutationTools:1,...overrides});

describe('COD desktop execution guard',()=>{
  it('instructs the agent to execute instead of promising future work',()=>{
    const prompt=buildCodeExecutionPrompt('创建 2048 小游戏');
    expect(prompt).toContain('Execute the user\'s request now');
    expect(prompt).toContain('Developer write/edit/shell tools');
    expect(prompt).toContain('before marking any TODO item complete');
    expect(prompt).toContain('Do not merely promise to start');
    expect(prompt).toContain('创建 2048 小游戏');
  });

  it('gives the Agent non-conflicting read-only instructions',()=>{
    const prompt=buildCodeExecutionPrompt('只读取 package.json，不要修改任何文件。');
    expect(prompt).toContain('This is a read-only project request');
    expect(prompt).toContain('Do not edit, create, delete, move');
    expect(prompt).not.toContain('make the requested file changes');
  });

  it('rejects conversational answers that did not invoke project tools',()=>{
    expect(()=>validateCodeRun('创建 2048 小游戏',result({toolCalls:0,completedTools:0,mutationTools:0}))).toThrow('没有执行任何项目工具');
  });

  it('requires a mutation tool for creation and modification requests',()=>{
    expect(()=>validateCodeRun('帮我创建 2048 小游戏',result({mutationTools:0}))).toThrow('没有检测到真实文件改动');
    expect(()=>validateCodeRun('帮我创建 2048 小游戏',result({mutationTools:1}))).not.toThrow();
    expect(()=>validateCodeRun('帮我调整并补全 2048 小游戏',result({mutationTools:0}),true)).not.toThrow();
    expect(()=>validateCodeRun('解释这个项目',result({mutationTools:0}))).not.toThrow();
  });

  it('does not mistake an explicitly read-only instruction for a mutation request',()=>{
    expect(requestLikelyRequiresMutation('只读取 package.json，不要修改任何文件。')).toBe(false);
    expect(requestLikelyRequiresMutation('Review package.json only; do not modify or edit any files.')).toBe(false);
    expect(()=>validateCodeRun('只读取 package.json，不要修改任何文件。',result({mutationTools:0}))).not.toThrow();
    expect(requestLikelyRequiresMutation('不要修改配置，只修复测试。')).toBe(true);
    expect(requestLikelyRequiresMutation('Do not modify configuration; fix the tests.')).toBe(true);
  });

  it('does not complete when every project tool failed',()=>{
    expect(()=>validateCodeRun('检查项目',result({completedTools:0,failedTools:1,mutationTools:0}))).toThrow('项目工具全部失败');
  });
});
