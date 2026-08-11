const inheritedEnvironmentNames = new Set([
  'APPDATA',
  'COLORTERM',
  'ComSpec',
  'CURL_CA_BUNDLE',
  'HOMEDRIVE',
  'HOMEPATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LOCALAPPDATA',
  'LOGNAME',
  'NODE_EXTRA_CA_CERTS',
  'NO_COLOR',
  'PATH',
  'PATHEXT',
  'ProgramData',
  'REQUESTS_CA_BUNDLE',
  'SHELL',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE',
  'SystemDrive',
  'SystemRoot',
  'TEMP',
  'TERM',
  'TMP',
  'TMPDIR',
  'TZ',
  'USER',
  'USERPROFILE',
  'WINDIR',
].map((name) => name.toUpperCase()));
const sensitiveEnvironmentName = /(?:^|_)(?:TOKEN|KEY|SECRET|PASSWORD)(?:_|$)|^(?:AWS|GCP|GOOGLE|AZURE|GH|GITHUB|NPM)(?:_|$)/i;

export function minimalGooseEnvironment(source: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    const normalizedName = name.toUpperCase();
    if (sensitiveEnvironmentName.test(normalizedName)) continue;
    if (!inheritedEnvironmentNames.has(normalizedName) && !normalizedName.startsWith('LC_')) continue;
    if (typeof value !== 'string' || value.includes('\0')) continue;
    result[name] = value;
  }
  return result;
}
