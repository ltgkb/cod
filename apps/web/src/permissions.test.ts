import { describe, expect, it } from 'vitest';
import {
  maxPermissionSummaryChars,
  permissionOptionLabel,
  permissionOptionsRequirePersistentWarning,
  permissionSummaryTextLength,
  presentPermissionOptions,
  summarizePermissionToolCall,
} from './permissions';

describe('permission option presentation', () => {
  const option = (kind: string, name = kind) => ({ optionId: `${kind}-id`, kind, name });

  it('puts one-time decisions before persistent permissions', () => {
    const presented = presentPermissionOptions([
      option('allow_always'), option('reject_always'), option('reject_once'), option('allow_once'),
    ]);
    expect(presented.map((item) => item.kind)).toEqual(['allow_once', 'reject_once', 'allow_always', 'reject_always']);
  });

  it('uses clear Chinese labels and preserves unknown provider labels', () => {
    expect(permissionOptionLabel(option('allow_once'))).toBe('仅允许这一次');
    expect(permissionOptionLabel(option('allow_always'))).toBe('本会话始终允许');
    expect(permissionOptionLabel(option('custom', '交由管理员审批'))).toBe('交由管理员审批');
  });

  it('warns only when a persistent allow option is available', () => {
    expect(permissionOptionsRequirePersistentWarning([option('allow_once'), option('allow_always')])).toBe(true);
    expect(permissionOptionsRequirePersistentWarning([option('allow_once'), option('reject_once')])).toBe(false);
  });
});

describe('permission tool summaries', () => {
  it('shows the tool kind, command arguments, affected paths, and safe content context', () => {
    const summary = summarizePermissionToolCall({
      title: '运行项目测试',
      kind: 'execute',
      rawInput: {
        command: 'npm',
        args: ['test', '--', 'src/auth.test.ts'],
        cwd: '/workspace/cod',
        description: '运行登录测试',
      },
      locations: [{ path: '/workspace/cod/src/auth.test.ts', line: 18 }],
      content: [
        { type: 'diff', path: '/workspace/cod/src/auth.ts', oldText: '', newText: 'updated' },
        { type: 'content', content: { type: 'text', text: '将验证登录失败分支' } },
      ],
    });

    expect(summary).toMatchObject({ title: '运行项目测试', kindLabel: '执行命令' });
    expect(summary.command).toContain('npm · test -- src/auth.test.ts');
    expect(summary.paths).toEqual(expect.arrayContaining(['/workspace/cod', '/workspace/cod/src/auth.test.ts:18', '/workspace/cod/src/auth.ts']));
    expect(summary.detail).toContain('运行登录测试');
    expect(summary.detail).toContain('包含文件差异');
    expect(summary.detail).toContain('将验证登录失败分支');
  });

  it('redacts credentials and converts markup to inert plain text', () => {
    const apiKey = `sk-${'a'.repeat(40)}`;
    const bearer = `eyJ${'b'.repeat(18)}.${'c'.repeat(18)}.${'d'.repeat(12)}`;
    const password = 'do-not-display-password';
    const summary = summarizePermissionToolCall({
      title: `<script>token=${apiKey}</script>`,
      kind: 'execute',
      rawInput: {
        command: `curl --token ${apiKey} https://user:${password}@api.kai.com/run?token=${bearer}`,
        args: [`Authorization: Bearer ${bearer}`, `API_KEY=${apiKey}`, '--password', password],
        env: { PASSWORD: password, SAFE_VALUE: 'also-not-shown' },
        headers: { authorization: `Bearer ${bearer}` },
      },
      content: [{ type: 'content', content: { type: 'text', text: `<img src=x onerror=alert(1)> password=${password}` } }],
    });
    const rendered = [summary.title, summary.kindLabel, summary.command ?? '', ...summary.paths, summary.detail].join(' ');

    expect(rendered).not.toContain(apiKey);
    expect(rendered).not.toContain(bearer);
    expect(rendered).not.toContain(password);
    expect(rendered).not.toContain('also-not-shown');
    expect(rendered).not.toMatch(/[<>]/);
    expect(rendered).toContain('已隐藏');
    expect(summary.detail).toContain('敏感参数已隐藏');

    const argvSecret = 'short-but-sensitive';
    const argvSummary = summarizePermissionToolCall({ kind: 'execute', rawInput: ['curl', '--token', argvSecret] });
    expect(argvSummary.command).not.toContain(argvSecret);
    expect(argvSummary.command).toContain('--token [已隐藏]');
  });

  it('bounds traversal and total output without invoking accessors or serializing binary content', () => {
    let getterCalled = false;
    const circular: Record<string, unknown> = { command: 'node', args: ['safe-script.js'], path: `/workspace/${'x'.repeat(2_000)}` };
    circular.self = circular;
    Object.defineProperty(circular, 'token', { enumerable: true, get() { getterCalled = true; throw new Error('must not run'); } });
    const summary = summarizePermissionToolCall({
      title: 'T'.repeat(5_000),
      kind: 'execute',
      rawInput: circular,
      locations: Array.from({ length: 20 }, (_, index) => ({ path: `/workspace/path-${index}` })),
      content: [{ type: 'content', content: { type: 'image', data: 'binary-secret'.repeat(1_000), mimeType: 'image/png' } }],
    });

    expect(getterCalled).toBe(false);
    expect(permissionSummaryTextLength(summary)).toBeLessThanOrEqual(maxPermissionSummaryChars);
    expect(summary.title.length).toBeLessThanOrEqual(160);
    expect(summary.command?.length).toBeLessThanOrEqual(320);
    expect(summary.paths).toHaveLength(4);
    expect(summary.paths.every((path) => path.length <= 84)).toBe(true);
    expect(summary.detail).not.toContain('binary-secret');
    expect(summary.detail).toContain('图像内容（数据未展示）');
  });
});
