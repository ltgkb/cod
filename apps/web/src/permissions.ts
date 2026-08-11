export interface PermissionOptionLike {
  optionId: string;
  name: string;
  kind: string;
}

const permissionOrder: Record<string, number> = {
  allow_once: 0,
  reject_once: 1,
  allow_always: 2,
  reject_always: 3,
};

export function permissionOptionLabel(option: PermissionOptionLike): string {
  switch (option.kind) {
    case 'allow_once': return '仅允许这一次';
    case 'reject_once': return '拒绝这一次';
    case 'allow_always': return '本会话始终允许';
    case 'reject_always': return '本会话始终拒绝';
    default: return option.name || option.optionId;
  }
}

export function presentPermissionOptions<T extends PermissionOptionLike>(options: T[]): T[] {
  return [...options].sort((left, right) =>
    (permissionOrder[left.kind] ?? Number.MAX_SAFE_INTEGER) - (permissionOrder[right.kind] ?? Number.MAX_SAFE_INTEGER));
}
