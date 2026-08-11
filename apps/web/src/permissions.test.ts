import { describe, expect, it } from 'vitest';
import { permissionOptionLabel, presentPermissionOptions } from './permissions';

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
});
