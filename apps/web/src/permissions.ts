export interface PermissionOptionLike {
  optionId: string;
  name: string;
  kind: string;
}

export interface PermissionToolCallLike {
  title?: unknown;
  kind?: unknown;
  rawInput?: unknown;
  locations?: unknown;
  content?: unknown;
}

export interface PermissionToolSummary {
  title: string;
  kindLabel: string;
  command: string | null;
  paths: string[];
  detail: string;
}

export const maxPermissionSummaryChars = 1_000;
export const persistentPermissionWarning = '风险：选择“本会话始终允许”后，后续同类操作将不再逐次询问。';

const maximumRawFragmentChars = 4_096;
const maximumTraversalDepth = 5;
const maximumTraversalNodes = 80;
const maximumObjectEntries = 24;
const maximumPaths = 4;

const commandKeys = new Set(['args', 'arguments', 'argv', 'cmd', 'command', 'executable', 'program', 'script', 'shellcommand']);
const contextKeys = new Set(['action', 'description', 'operation', 'pattern', 'query', 'summary']);
const pathKeys = new Set(['cwd', 'destination', 'directories', 'directory', 'file', 'filepath', 'filepaths', 'files', 'from', 'path', 'paths', 'root', 'sourcepath', 'target', 'targets', 'to', 'uri']);
const sensitiveKeyFragments = ['accesstoken', 'apikey', 'authorization', 'cookie', 'credential', 'environment', 'header', 'password', 'passwd', 'privatekey', 'secret', 'sessiontoken', 'token'];

const toolKindLabels: Record<string, string> = {
  read: '读取',
  edit: '修改文件',
  delete: '删除',
  move: '移动文件',
  search: '搜索',
  execute: '执行命令',
  think: '分析',
  fetch: '网络请求',
  switch_mode: '切换模式',
  other: '其他操作',
};

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

export function permissionOptionsRequirePersistentWarning(options: PermissionOptionLike[]): boolean {
  return options.some((option) => option.kind === 'allow_always');
}

function normalizedKey(key: string): string {
  return key.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function isSensitiveKey(key: string): boolean {
  const normalized = normalizedKey(key);
  return normalized === 'env' || sensitiveKeyFragments.some((fragment) => normalized.includes(fragment));
}

function ownEntries(value: object): Array<[string, unknown]> {
  try {
    return Object.entries(Object.getOwnPropertyDescriptors(value))
      .filter(([, descriptor]) => descriptor.enumerable && Object.prototype.hasOwnProperty.call(descriptor, 'value'))
      .slice(0, maximumObjectEntries)
      .map(([key, descriptor]) => [key, descriptor.value]);
  } catch {
    return [];
  }
}

function ownValue(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value') ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function plainText(input: string): string {
  let result = '';
  for (const character of input.slice(0, maximumRawFragmentChars)) {
    const code = character.codePointAt(0) ?? 0;
    const control = (code >= 0 && code <= 8) || code === 11 || code === 12 || (code >= 14 && code <= 31) || (code >= 127 && code <= 159);
    const bidirectionalControl = (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
    if (control || bidirectionalControl) result += ' ';
    else if (character === '<') result += '‹';
    else if (character === '>') result += '›';
    else result += character;
  }
  return result.replace(/\s+/g, ' ').trim();
}

function redactSensitiveText(input: string): string {
  return plainText(input
    .slice(0, maximumRawFragmentChars)
    .replace(/-----BEGIN [^-]{0,80}PRIVATE KEY-----[\s\S]*?(?:-----END [^-]{0,80}PRIVATE KEY-----|$)/gi, '[私钥已隐藏]')
    .replace(/(https?:\/\/)[^\s/:@]+:[^\s/@]+@/gi, '$1[凭据已隐藏]@')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [已隐藏]')
    .replace(/\b(?:sk|ghp|gho|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,}\b/gi, '[令牌已隐藏]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]{5,})?\b/g, '[JWT 已隐藏]')
    .replace(/(--?(?:access[-_]?token|api[-_]?key|authorization|cookie|credential|password|passwd|secret|token)(?:\s+|=))(?:(?:"[^"]*")|(?:'[^']*')|[^\s]+)/gi, '$1[已隐藏]')
    .replace(/\b([A-Z][A-Z0-9_]*(?:ACCESS_KEY|API_KEY|CREDENTIAL|PASSWORD|PASSWD|PRIVATE_KEY|SECRET|TOKEN)[A-Z0-9_]*)\s*=\s*(?:(?:"[^"]*")|(?:'[^']*')|[^\s]+)/g, '$1=[已隐藏]')
    .replace(/((?:["']?)(?:access[-_]?token|api[-_]?key|authorization|cookie|credential|password|passwd|private[-_]?key|secret|token)(?:["']?)\s*[:=]\s*)(?:(?:"[^"]*")|(?:'[^']*')|[^,}\s]+)/gi, '$1[已隐藏]')
    .replace(/([?&](?:access[-_]?token|api[-_]?key|authorization|credential|password|secret|token)=)[^&#\s]+/gi, '$1[已隐藏]')
    .replace(/\b[A-Za-z0-9_+=-]{64,}\b/g, '[长凭据已隐藏]'));
}

function limited(input: string, maximum: number): string {
  if (input.length <= maximum) return input;
  return `${input.slice(0, Math.max(0, maximum - 1)).trimEnd()}…`;
}

function safePath(input: string): string {
  const redacted = redactSensitiveText(input);
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(redacted)) return redacted;
  try {
    const url = new URL(redacted);
    const authority = url.host ? `//${url.host}` : '//';
    return `${url.protocol}${authority}${url.pathname}${url.search ? '?…' : ''}`;
  } catch {
    return redacted;
  }
}

function primitiveText(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') return String(value);
  return null;
}

function addUnique(values: string[], value: string): void {
  if (value && !values.includes(value)) values.push(value);
}

function collectInputHints(rawInput: unknown): { commands: string[]; paths: string[]; details: string[]; hidden: boolean } {
  const commands: string[] = [];
  const paths: string[] = [];
  const details: string[] = [];
  const seen = new WeakSet<object>();
  let visited = 0;
  let hidden = false;

  const visit = (value: unknown, key: string, inheritedCategory: 'command' | 'path' | 'context' | null, depth: number): void => {
    if (visited >= maximumTraversalNodes || depth > maximumTraversalDepth) return;
    visited += 1;
    if (isSensitiveKey(key)) { hidden = true; return; }
    const normalized = normalizedKey(key);
    const category = commandKeys.has(normalized) ? 'command' : pathKeys.has(normalized) ? 'path' : contextKeys.has(normalized) ? 'context' : depth === 0 && Array.isArray(value) ? 'command' : inheritedCategory;
    const primitive = primitiveText(value);
    if (primitive !== null) {
      const safe = category === 'path' ? safePath(primitive) : redactSensitiveText(primitive);
      if (safe.includes('已隐藏')) hidden = true;
      if (category === 'command' || (depth === 0 && typeof value === 'string')) addUnique(commands, safe);
      else if (category === 'path') addUnique(paths, safe);
      else if (category === 'context') addUnique(details, safe);
      return;
    }
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value) && category === 'command') {
      const entries = ownEntries(value);
      const argumentText = entries.map(([, childValue]) => primitiveText(childValue)).filter((part): part is string => part !== null).join(' ');
      if (argumentText) {
        const safe = redactSensitiveText(argumentText);
        if (safe.includes('已隐藏')) hidden = true;
        addUnique(commands, safe);
      }
      for (const [childKey, childValue] of entries) if (primitiveText(childValue) === null) visit(childValue, childKey, 'command', depth + 1);
      return;
    }
    const arrayCategory = Array.isArray(value) ? category : null;
    for (const [childKey, childValue] of ownEntries(value)) visit(childValue, childKey, arrayCategory, depth + 1);
  };

  visit(rawInput, 'rawInput', null, 0);
  return { commands, paths, details, hidden };
}

function collectContentHints(content: unknown, paths: string[], details: string[]): void {
  if (!Array.isArray(content)) return;
  for (const item of content.slice(0, 8)) {
    const type = ownValue(item, 'type');
    if (type === 'diff') {
      const path = ownValue(item, 'path');
      if (typeof path === 'string') addUnique(paths, safePath(path));
      addUnique(details, '包含文件差异');
      continue;
    }
    if (type === 'terminal') {
      addUnique(details, '包含终端会话');
      continue;
    }
    if (type !== 'content') continue;
    const block = ownValue(item, 'content');
    const blockType = ownValue(block, 'type');
    if (blockType === 'text') {
      const text = ownValue(block, 'text');
      if (typeof text === 'string') addUnique(details, redactSensitiveText(text));
    } else if (blockType === 'resource_link') {
      const uri = ownValue(block, 'uri');
      if (typeof uri === 'string') addUnique(paths, safePath(uri));
      const title = ownValue(block, 'title') ?? ownValue(block, 'name');
      if (typeof title === 'string') addUnique(details, redactSensitiveText(title));
    } else if (blockType === 'resource') {
      const resource = ownValue(block, 'resource');
      const uri = ownValue(resource, 'uri');
      if (typeof uri === 'string') addUnique(paths, safePath(uri));
      addUnique(details, '包含资源内容（正文未展示）');
    } else if (blockType === 'image' || blockType === 'audio') {
      addUnique(details, `包含${blockType === 'image' ? '图像' : '音频'}内容（数据未展示）`);
    }
  }
}

export function summarizePermissionToolCall(toolCall: PermissionToolCallLike): PermissionToolSummary {
  const titleValue = ownValue(toolCall, 'title');
  const kindValue = ownValue(toolCall, 'kind');
  const rawInput = ownValue(toolCall, 'rawInput');
  const inputHints = collectInputHints(rawInput);
  const paths = [...inputHints.paths];
  const details = [...inputHints.details];

  const locations = ownValue(toolCall, 'locations');
  if (Array.isArray(locations)) {
    for (const location of locations.slice(0, 8)) {
      const path = ownValue(location, 'path');
      if (typeof path !== 'string') continue;
      const line = ownValue(location, 'line');
      const suffix = typeof line === 'number' && Number.isSafeInteger(line) && line > 0 ? `:${line}` : '';
      addUnique(paths, `${safePath(path)}${suffix}`);
    }
  }
  collectContentHints(ownValue(toolCall, 'content'), paths, details);
  if (inputHints.hidden) addUnique(details, '敏感参数已隐藏');

  const summary: PermissionToolSummary = {
    title: limited(typeof titleValue === 'string' && titleValue.trim() ? redactSensitiveText(titleValue) : '需要授权的本机操作', 160),
    kindLabel: limited(typeof kindValue === 'string' ? toolKindLabels[kindValue] ?? '其他操作' : '未声明类型', 16),
    command: inputHints.commands.length ? limited(inputHints.commands.join(' · '), 320) : null,
    paths: paths.slice(0, maximumPaths).map((path) => limited(path, 84)),
    detail: limited(details.filter(Boolean).join(' · ') || '未提供更多可核验参数，请谨慎授权。', 150),
  };
  return summary;
}

export function permissionSummaryTextLength(summary: PermissionToolSummary): number {
  return summary.title.length + summary.kindLabel.length + (summary.command?.length ?? 0)
    + summary.paths.reduce((total, path) => total + path.length, 0) + summary.detail.length;
}
