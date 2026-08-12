function httpOrigin(value: unknown, allowBareHost: boolean): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const candidate = allowBareHost && !/^[a-z][a-z\d+.-]*:\/\//i.test(value)
    ? `http://${value}`
    : value;
  try {
    const url = new URL(candidate);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

export function resolveDevelopmentServerOrigin(
  sourceCodeScriptUrl: unknown,
  expoGoDebuggerHost: unknown,
  expoHostUri: unknown,
): string | undefined {
  return httpOrigin(sourceCodeScriptUrl, false)
    ?? httpOrigin(expoGoDebuggerHost, true)
    ?? httpOrigin(expoHostUri, true);
}
