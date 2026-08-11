export interface NativeBackTarget {
  handleNativeBack?: () => void;
}

export function forwardNativeBack(available: boolean, target: NativeBackTarget | null): boolean {
  if (!available || typeof target?.handleNativeBack !== 'function') return false;
  target.handleNativeBack();
  return true;
}
