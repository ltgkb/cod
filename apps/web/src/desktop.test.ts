import { describe, expect, it } from 'vitest';
import { desktopGitDiffError } from './desktop';

describe('desktop Git diff status', () => {
  it('recognizes explicit desktop failures without treating a non-Git project as an error', () => {
    expect(desktopGitDiffError('Git 状态读取超时；项目文件仍可正常使用。')).toBeTruthy();
    expect(desktopGitDiffError('Git 改动读取超时；项目文件仍可正常使用。')).toBeTruthy();
    expect(desktopGitDiffError('Git 改动读取失败；项目文件仍可正常使用。')).toBeTruthy();
    expect(desktopGitDiffError('当前目录不是 Git 仓库，暂无可显示的改动。')).toBeNull();
    expect(desktopGitDiffError('diff --git a/file b/file')).toBeNull();
  });
});
