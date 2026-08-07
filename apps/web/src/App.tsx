import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import {
  ArrowClockwise,
  ArrowSquareOut,
  CaretDown,
  ChatCircleDots,
  Check,
  CircleNotch,
  Code,
  Command,
  File,
  Folder,
  GitDiff,
  Key,
  Lightning,
  ListChecks,
  MagnifyingGlass,
  Moon,
  PaperPlaneTilt,
  Play,
  Plus,
  ShieldCheck,
  SidebarSimple,
  SignOut,
  Stack,
  Sun,
  TerminalWindow,
  UserCircle,
  Warning,
  X,
} from '@phosphor-icons/react';
import type { DeviceRecord, KnowledgeHit, ProductManifest, TaskStatus, WorkspaceFile } from '@cod/contracts';
import {
  createRemoteTask,
  createClientId,
  getCapabilities,
  getCreditPacks,
  heartbeatDevice,
  listDevices,
  listLedger,
  listProducts,
  launchProduct,
  listModelCatalog,
  listTasks,
  loginCod,
  logoutCod,
  refreshAccount,
  purchaseCreditPack,
  registerDevice,
  resumeCodSession,
  searchKnowledge,
  sendChat,
  topup,
  updateRemoteTask,
  type CapabilityReport,
  type CodSession,
  type CreditPackState,
  type LedgerEntry,
  type ModelSourceInfo,
  type RemoteTask,
} from './api';
import { hasDesktopBridge, loadProject, openProject, readProjectFile } from './desktop';
import type { InspectorTab, ProjectSnapshot, WorkspaceMode } from './types';

const statusLabels: Record<TaskStatus, string> = {
  draft: '草稿', running: '运行中', waiting: '待确认', complete: '已完成', failed: '失败',
};
const emptyProject: ProjectSnapshot = { root: '', files: [], diff: '', selectedFile: null, selectedContent: '' };
type Overlay = 'login' | 'new-task' | 'account' | 'commands' | 'models' | null;
type AuthState = 'loading' | 'signed-out' | 'signed-in';
type ColorMode = 'light' | 'dark';
interface ChatMessage { id: string; role: 'user' | 'assistant'; content: string; mode?: 'live' | 'demo'; sourceLabel?: string; model?: string; inputTokens?: number; outputTokens?: number; createdAt: string }

function storageGet(key: string): string | null {
  try { return window.localStorage.getItem(key); } catch { return null; }
}
function storageSet(key: string, value: string): void {
  try { window.localStorage.setItem(key, value); } catch { /* Storage can be unavailable in private contexts. */ }
}
function initialColorMode(): ColorMode {
  const stored = storageGet('kai.color-mode.v1');
  if (stored === 'light' || stored === 'dark') return stored;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
function initialInspectorOpen(): boolean {
  return storageGet('cod.inspector.open') !== 'false';
}
function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) return '刚刚';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  return date.toLocaleDateString('zh-CN');
}
function devicePlatform(): DeviceRecord['platform'] {
  if (!hasDesktopBridge()) return window.matchMedia?.('(max-width: 560px)').matches ? 'mobile' : 'web';
  if (window.codDesktop?.platform === 'darwin') return 'macos';
  if (window.codDesktop?.platform === 'win32') return 'windows';
  return 'linux';
}

function Brand() {
  return <div className="brand" aria-label="COD"><div className="brand-mark"><span>C</span></div><div><strong>COD</strong><small>agent workspace</small></div></div>;
}
function ThemeToggle({ colorMode, onChange, className = '' }: { colorMode: ColorMode; onChange: (mode: ColorMode) => void; className?: string }) {
  const nextMode = colorMode === 'dark' ? 'light' : 'dark';
  return <button className={`icon-button theme-toggle ${className}`.trim()} title={`切换到${nextMode === 'dark' ? '深色' : '浅色'}模式`} aria-label={`切换到${nextMode === 'dark' ? '深色' : '浅色'}模式`} onClick={() => onChange(nextMode)}>{colorMode === 'dark' ? <Sun /> : <Moon />}</button>;
}
function StatusGlyph({ status }: { status: TaskStatus }) {
  if (status === 'running') return <CircleNotch className="spin status-running" weight="bold" />;
  if (status === 'waiting') return <Warning className="status-waiting" weight="fill" />;
  if (status === 'failed') return <Warning className="status-failed" weight="fill" />;
  if (status === 'complete') return <Check className="status-complete" weight="bold" />;
  return <ListChecks />;
}
function TaskList({ tasks, devices, activeId, onSelect }: { tasks: RemoteTask[]; devices: DeviceRecord[]; activeId: string | null; onSelect: (id: string) => void }) {
  if (!tasks.length) return <div className="sidebar-empty">没有匹配的任务</div>;
  return <nav className="task-list" aria-label="任务列表">{tasks.map((task) => (
    <button className={task.id === activeId ? 'task-row active' : 'task-row'} key={task.id} onClick={() => onSelect(task.id)}>
      <StatusGlyph status={task.status} />
      <span className="task-copy"><strong>{task.title}</strong><small>{devices.find((device) => device.id === task.deviceId)?.name ?? '未绑定设备'} <i>/</i> {formatTime(task.updatedAt)}</small></span>
      <span className={`task-status ${task.status}`}>{statusLabels[task.status]}</span>
    </button>
  ))}</nav>;
}
function FileTree({ files, selected, onSelect }: { files: WorkspaceFile[]; selected: string | null; onSelect: (file: WorkspaceFile) => void }) {
  return <div className="file-tree">{files.map((file) => <button key={file.path} className={selected === file.path ? 'file-row active' : 'file-row'} style={{ paddingLeft: `${12 + file.depth * 14}px` }} onClick={() => onSelect(file)}>{file.kind === 'directory' ? <Folder weight="fill" /> : <File />}<span>{file.name}</span></button>)}</div>;
}
function CodeBlock({ text }: { text: string }) {
  return <pre className="code-block">{text.split('\n').map((line, index) => {
    const type = line.startsWith('+') && !line.startsWith('+++') ? 'added' : line.startsWith('-') && !line.startsWith('---') ? 'removed' : '';
    return <code className={type} key={`${index}-${line}`}>{line || ' '}</code>;
  })}</pre>;
}
function Modal({ title, onClose, children, wide = false }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section className={`modal${wide ? ' modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}><header><strong>{title}</strong><button className="icon-button" title="关闭" onClick={onClose}><X /></button></header>{children}</section></div>;
}

function LoginForm({ capabilities, capabilityError, resumeConversation, onLogin }: { capabilities: CapabilityReport | null; capabilityError: string; resumeConversation: boolean; onLogin: (email: string, accessCode: string) => Promise<void> }) {
  const [email, setEmail] = useState('developer@kai.com');
  const [accessCode, setAccessCode] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setSubmitting(true); setError('');
    try { await onLogin(email, accessCode); } catch (nextError) { setError(nextError instanceof Error ? nextError.message : '登录失败'); } finally { setSubmitting(false); }
  };
  return <div className="login-form"><div className="login-copy"><span className="eyebrow">PRIVATE PILOT</span><h2>{resumeConversation ? '登录后继续对话' : '登录 COD'}</h2><p>{resumeConversation ? '你的消息已经保留。登录成功后，COD 会自动发送这条消息。' : '使用获批的 KAI 账号和试点访问码登录。'}</p></div>{capabilityError && <div className="notice error">{capabilityError}</div>}<form onSubmit={submit}><label>邮箱<input aria-label="邮箱" type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="username" required /></label><label>访问码<input aria-label="访问码" type="password" value={accessCode} onChange={(event) => setAccessCode(event.target.value)} autoComplete="current-password" required={capabilities?.authentication.accessCodeRequired ?? true} autoFocus /></label>{error && <div className="notice error">{error}</div>}<button className="primary-button" disabled={submitting}>{submitting ? <CircleNotch className="spin" /> : <Key />} {resumeConversation ? '登录并继续' : '登录'}</button></form><div className="capability-summary"><span className={capabilities?.ai.mode === 'live' ? 'live' : 'demo'}>模型：{capabilities?.ai.mode === 'live' ? '已连接' : capabilities?.ai.mode === 'demo' ? '演示模式' : '待检测'}</span><span>同步：{capabilities ? '可用' : '待检测'}</span></div></div>;
}

function ModelLibrary({ sources, error, signedIn, onLogin }: { sources: ModelSourceInfo[]; error: string; signedIn: boolean; onLogin: () => void }) {
  const [query, setQuery] = useState('');
  const normalizedQuery = query.trim().toLowerCase();
  const visibleSources = sources.map((source) => ({
    ...source,
    models: source.models.filter((model) => !normalizedQuery || `${source.label} ${model.label} ${model.id}`.toLowerCase().includes(normalizedQuery)),
  })).filter((source) => source.models.length > 0);
  const availableModels = sources.filter((source) => source.callable).reduce((total, source) => total + source.models.length, 0);
  const catalogModels = sources.reduce((total, source) => total + source.models.length, 0);
  const statusLabel = (source: ModelSourceInfo) => source.callable ? '当前可用' : source.status === 'catalog' ? '价格目录' : source.status === 'demo' ? '演示可用' : '暂不可用';
  const price = (cents: number) => `¥ ${(cents / 100).toFixed(2)}`;
  return <div className="model-library">
    <div className="model-library-intro"><div><span className="eyebrow">MODEL CATALOG</span><h2>模型与参考价格</h2><p>所有价格均为人民币，每百万 Token 计价。输入与输出价格分别展示，方便调用前预估成本。</p></div><div className="model-library-summary"><span><small>当前可用</small><strong>{availableModels}</strong></span><span><small>目录模型</small><strong>{catalogModels}</strong></span></div></div>
    <label className="model-search"><MagnifyingGlass /><input aria-label="搜索模型" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索模型或模型源" /></label>
    {error && <div className="notice error">{error}</div>}
    {!error && !sources.length && <div className="model-library-empty"><CircleNotch className="spin" /> 正在读取模型目录…</div>}
    {sources.length > 0 && !visibleSources.length && <div className="model-library-empty">没有匹配的模型</div>}
    <div className="model-source-list">{visibleSources.map((source) => <section className="model-source-card" key={source.id}><header><div><strong>{source.label}</strong><small>{source.note}</small></div><span className={source.callable ? 'available' : source.status}>{statusLabel(source)}</span></header><div className="model-table" role="table" aria-label={`${source.label} 模型价格`}><div className="model-row model-table-head" role="row"><span role="columnheader">模型</span><span role="columnheader">上下文</span><span role="columnheader">输入 / 百万</span><span role="columnheader">输出 / 百万</span><span role="columnheader">状态</span></div>{source.models.map((model) => <div className="model-row" role="row" key={model.id}><span role="cell"><strong>{model.label}</strong><small>{model.id}</small></span><span role="cell">{model.contextWindow > 0 ? model.contextWindow.toLocaleString('zh-CN') : '—'}</span><span role="cell" className="model-price">{price(model.inputPricePerMillionCents)}</span><span role="cell" className="model-price">{price(model.outputPricePerMillionCents)}</span><span role="cell"><i className={source.callable ? 'available' : 'unavailable'}>{source.callable ? '可调用' : '仅参考'}</i></span></div>)}</div></section>)}</div>
    <footer className="model-library-footer"><p>价格用于预算参考，实际扣费以请求产生的 Token 用量和钱包账单为准。</p>{!signedIn && <button className="primary-button" onClick={onLogin}><Key /> 登录后使用模型</button>}</footer>
  </div>;
}

export function App() {
  const [colorMode, setColorMode] = useState<ColorMode>(initialColorMode);
  const [authState, setAuthState] = useState<AuthState>('loading');
  const [capabilities, setCapabilities] = useState<CapabilityReport | null>(null);
  const [capabilityError, setCapabilityError] = useState('');
  const [modelCatalog, setModelCatalog] = useState<ModelSourceInfo[]>([]);
  const [modelCatalogError, setModelCatalogError] = useState('');
  const [session, setSession] = useState<CodSession | null>(null);
  const [tasks, setTasks] = useState<RemoteTask[]>([]);
  const [devices, setDevices] = useState<DeviceRecord[]>([]);
  const [currentDeviceId, setCurrentDeviceId] = useState('');
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [creditPacks, setCreditPacks] = useState<CreditPackState>({ packs: [], summary: { availableCents: 0, grants: [] } });
  const [purchasingPackId, setPurchasingPackId] = useState('');
  const [products, setProducts] = useState<ProductManifest[]>([]);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [targetDeviceId, setTargetDeviceId] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [mode, setMode] = useState<WorkspaceMode>('code');
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('changes');
  const [inspectorOpen, setInspectorOpen] = useState(initialInspectorOpen);
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [newTaskTitle, setNewTaskTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [command, setCommand] = useState('npm test');
  const [terminalOutput, setTerminalOutput] = useState('选择本机项目后可运行受控命令。');
  const [selectedSourceId, setSelectedSourceId] = useState('demo');
  const [selectedModel, setSelectedModel] = useState('coder-pro');
  const [knowledgeHits, setKnowledgeHits] = useState<KnowledgeHit[]>([]);
  const [knowledgeLoading, setKnowledgeLoading] = useState(false);
  const [notice, setNotice] = useState('');
  const [messagesByTask, setMessagesByTask] = useState<Record<string, ChatMessage[]>>({});
  const [pendingSend, setPendingSend] = useState<{ prompt: string; mode: WorkspaceMode } | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [agentStatus, setAgentStatus] = useState('就绪');
  const [pendingPermission, setPendingPermission] = useState<{ title: string; options: Array<{ optionId: string; name: string; kind: string }> } | null>(null);
  const [project, setProject] = useState<ProjectSnapshot>(emptyProject);
  const permissionResolver = useRef<((optionId: string | null) => void) | null>(null);
  const pendingSendRunner = useRef<(prompt: string, mode: WorkspaceMode) => void>(() => undefined);

  useEffect(() => {
    document.documentElement.dataset.colorMode = colorMode;
    document.documentElement.style.colorScheme = colorMode;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', colorMode === 'dark' ? '#0b1416' : '#fbfdfd');
    storageSet('kai.color-mode.v1', colorMode);
  }, [colorMode]);

  const activeTask = useMemo(() => tasks.find((task) => task.id === activeTaskId) ?? null, [tasks, activeTaskId]);
  const selectedSource = session?.sources.find((source) => source.id === selectedSourceId) ?? session?.sources[0] ?? null;
  const sourceModels = selectedSource?.models ?? [];
  const selectedModelInfo = sourceModels.find((model) => model.id === selectedModel) ?? sourceModels[0] ?? null;
  const activeMessages = activeTaskId ? messagesByTask[activeTaskId] ?? [] : [];
  const filteredTasks = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return query ? tasks.filter((task) => task.title.toLowerCase().includes(query) || statusLabels[task.status].includes(query)) : tasks;
  }, [tasks, searchQuery]);
  const changeCount = useMemo(() => project.diff.match(/^diff --git /gm)?.length ?? 0, [project.diff]);
  const projectName = project.root ? project.root.split(/[\\/]/).filter(Boolean).pop() ?? project.root : '未连接本机项目';

  const replaceTask = (next: RemoteTask) => setTasks((current) => current.map((task) => task.id === next.id ? next : task));
  const appendMessage = (taskId: string, message: ChatMessage) => setMessagesByTask((current) => {
    const messages = [...(current[taskId] ?? []), message];
    storageSet(`cod.messages.${taskId}`, JSON.stringify(messages.slice(-100)));
    return { ...current, [taskId]: messages };
  });

  const loadWorkspace = async (nextSession: CodSession) => {
    setModelCatalog(nextSession.sources);
    setModelCatalogError('');
    const [initialDevices, nextTasks, nextProducts, nextLedger, nextCreditPacks] = await Promise.all([listDevices(nextSession.token), listTasks(nextSession.token), listProducts(nextSession.token), listLedger(nextSession.token), getCreditPacks(nextSession.token)]);
    let nextDevices = initialDevices;
    const storedDeviceId = storageGet('cod.device.id');
    let currentDevice = nextDevices.find((device) => device.id === storedDeviceId);
    if (!currentDevice) {
      const platform = devicePlatform();
      currentDevice = await registerDevice(nextSession.token, hasDesktopBridge() ? `COD Desktop (${platform})` : `COD ${platform === 'mobile' ? 'Mobile' : 'Web'}`, platform);
      storageSet('cod.device.id', currentDevice.id);
      nextDevices = [...nextDevices, currentDevice];
    } else {
      currentDevice = await heartbeatDevice(nextSession.token, currentDevice.id);
      nextDevices = nextDevices.map((device) => device.id === currentDevice!.id ? currentDevice! : device);
    }
    setDevices(nextDevices); setTasks(nextTasks); setProducts(nextProducts); setLedger(nextLedger); setCreditPacks(nextCreditPacks);
    setCurrentDeviceId(currentDevice.id);
    setTargetDeviceId((current) => current || nextDevices.find((device) => device.status === 'online' && !['web', 'mobile'].includes(device.platform))?.id || currentDevice!.id);
    setActiveTaskId((current) => current && nextTasks.some((task) => task.id === current) ? current : nextTasks[0]?.id ?? null);
    const storedSourceId = storageGet('cod.model.source');
    const nextSource = nextSession.sources.find((source) => source.id === storedSourceId) ?? nextSession.sources.find((source) => source.callable) ?? nextSession.sources[0];
    setSelectedSourceId(nextSource?.id ?? 'demo');
    const storedModel = nextSource ? storageGet(`cod.model.${nextSource.id}`) : null;
    setSelectedModel(nextSource?.models.find((model) => model.id === storedModel)?.id ?? nextSource?.models[0]?.id ?? 'coder-pro');
  };

  useEffect(() => {
    let mounted = true;
    Promise.allSettled([getCapabilities(), listModelCatalog(), resumeCodSession()]).then(async ([capabilityResult, catalogResult, sessionResult]) => {
      if (!mounted) return;
      if (capabilityResult.status === 'fulfilled') setCapabilities(capabilityResult.value); else setCapabilityError('控制平面暂不可达，请检查网络或服务状态。');
      if (catalogResult.status === 'fulfilled') setModelCatalog(catalogResult.value); else setModelCatalogError('模型目录暂不可用，请稍后重试。');
      const nextSession = sessionResult.status === 'fulfilled' ? sessionResult.value : null;
      if (!nextSession) { setAuthState('signed-out'); return; }
      try { await loadWorkspace(nextSession); if (mounted) { setSession(nextSession); setAuthState('signed-in'); setOverlay(null); } }
      catch { if (mounted) { logoutCod(); setAuthState('signed-out'); } }
    });
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    if (!activeTaskId || messagesByTask[activeTaskId]) return;
    const raw = storageGet(`cod.messages.${activeTaskId}`);
    if (!raw) { setMessagesByTask((current) => ({ ...current, [activeTaskId]: [] })); return; }
    try { setMessagesByTask((current) => ({ ...current, [activeTaskId]: JSON.parse(raw) as ChatMessage[] })); }
    catch { setMessagesByTask((current) => ({ ...current, [activeTaskId]: [] })); }
  }, [activeTaskId, messagesByTask]);

  useEffect(() => {
    if (!session) return;
    const sync = async () => {
      try {
        const [nextTasks, nextDevices] = await Promise.all([listTasks(session.token), listDevices(session.token)]);
        setTasks(nextTasks); setDevices(nextDevices);
        const currentDeviceId = storageGet('cod.device.id');
        if (currentDeviceId) await heartbeatDevice(session.token, currentDeviceId);
      } catch { /* Keep the last synchronized snapshot and retry. */ }
    };
    const interval = window.setInterval(sync, 15_000);
    return () => window.clearInterval(interval);
  }, [session]);

  useEffect(() => {
    if (!hasDesktopBridge()) return;
    const recentRoot = storageGet('cod.project.root');
    if (recentRoot) loadProject(recentRoot).then((snapshot) => snapshot && setProject(snapshot)).catch(() => storageSet('cod.project.root', ''));
  }, []);

  const handleLogin = async (email: string, accessCode: string) => {
    const nextSession = await loginCod(email, accessCode);
    await loadWorkspace(nextSession); setSession(nextSession); setAuthState('signed-in'); setOverlay(null);
  };
  const handleLogout = () => { void window.codDesktop?.stopGoose(); logoutCod(); setSession(null); setTasks([]); setDevices([]); setCreditPacks({ packs: [], summary: { availableCents: 0, grants: [] } }); setCurrentDeviceId(''); setPendingSend(null); setOverlay(null); setAuthState('signed-out'); };
  const refreshWallet = async () => {
    if (!session) return;
    const [account, nextLedger, nextCreditPacks] = await Promise.all([refreshAccount(session.token), listLedger(session.token), getCreditPacks(session.token)]);
    setSession({ ...session, account }); setLedger(nextLedger); setCreditPacks(nextCreditPacks);
  };
  const handleTopup = async (amountCents: number) => {
    if (!session || !capabilities?.payments.topupEnabled) { setNotice('支付渠道尚未接入，当前不可充值。'); setOverlay('account'); return; }
    try { const account = await topup(session.token, amountCents); setSession({ ...session, account }); await refreshWallet(); setNotice(`已预存 ¥${(amountCents / 100).toFixed(2)} 试点额度。`); }
    catch (error) { setNotice(error instanceof Error ? error.message : '充值失败'); }
  };
  const handlePurchaseCreditPack = async (packId:string) => {
    if(!session||purchasingPackId)return;setPurchasingPackId(packId);
    try{const result=await purchaseCreditPack(session.token,packId);setSession({...session,account:result.account});setCreditPacks((current)=>({...current,summary:result.summary}));setLedger(await listLedger(session.token));setNotice(`${result.grant.name} 已到账，有效至 ${new Date(result.grant.expiresAt).toLocaleDateString('zh-CN')}。`);}
    catch(error){setNotice(error instanceof Error?error.message:'购买额度包失败');}
    finally{setPurchasingPackId('');}
  };
  const handleSourceChange = (sourceId: string) => {
    if (!session) return;
    const source = session.sources.find((item) => item.id === sourceId); if (!source) return;
    setSelectedSourceId(source.id); storageSet('cod.model.source', source.id);
    const storedModel = storageGet(`cod.model.${source.id}`); setSelectedModel(source.models.find((model) => model.id === storedModel)?.id ?? source.models[0]?.id ?? '');
    setNotice(source.note);
  };
  const handleModelChange = (modelId: string) => { setSelectedModel(modelId); storageSet(`cod.model.${selectedSourceId}`, modelId); };
  const handleCreateTask = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!session || !newTaskTitle.trim() || !targetDeviceId) return;
    try {
      const task = await createRemoteTask(session.token, newTaskTitle.trim(), targetDeviceId);
      setTasks((current) => [task, ...current]); setActiveTaskId(task.id); setNewTaskTitle(''); setOverlay(null); setSidebarOpen(false); setNotice('任务已创建并同步到目标设备。');
    } catch (error) { setNotice(error instanceof Error ? error.message : '创建任务失败'); }
  };
  const changeTaskStatus = async (task: RemoteTask, status: TaskStatus, outcome: { result?: string | null; error?: string | null } = {}): Promise<RemoteTask> => {
    if (!session) return task;
    const updated = await updateRemoteTask(session.token, task, status, outcome); replaceTask(updated); return updated;
  };
  const handleKnowledge = async () => {
    if (!session) { setOverlay('login'); return; }
    const query = prompt.trim() || activeTask?.title || '';
    if (!query) { setNotice('请先输入要检索的内容。'); return; }
    setKnowledgeLoading(true); setKnowledgeHits([]);
    try { const hits = await searchKnowledge(session.token, query); setKnowledgeHits(hits); if (!hits.length) setNotice('公司 Wiki 没有找到匹配结果。'); }
    catch (error) { setNotice(error instanceof Error ? error.message : 'Wiki 检索失败'); }
    finally { setKnowledgeLoading(false); }
  };
  const handleRemoteTask = async () => {
    if (!session) { setOverlay('login'); return; }
    if (!targetDeviceId) { setNotice('没有可用的目标设备。'); return; }
    const title = prompt.trim() || activeTask?.title;
    if (!title) { setOverlay('new-task'); return; }
    try { const task = await createRemoteTask(session.token, title, targetDeviceId); setTasks((current) => [task, ...current]); setActiveTaskId(task.id); setNotice(`已发送到 ${devices.find((device) => device.id === targetDeviceId)?.name ?? '目标设备'}。`); }
    catch (error) { setNotice(error instanceof Error ? error.message : '发送失败'); }
  };
  const handleProductLaunch = async (product: ProductManifest) => {
    if (!session) return;
    try {
      const launch = await launchProduct(session.token, product.id);
      window.open(launch.url, '_blank', 'noopener,noreferrer');
    } catch (error) { setNotice(error instanceof Error ? error.message : '产品打开失败'); }
  };
  const handleSend = async (requestedPrompt = prompt, requestedTask: RemoteTask | null = activeTask, requestedMode: WorkspaceMode = mode) => {
    const promptText = requestedPrompt.trim();
    if (!promptText || isSending) return;
    if (!session) { setPendingSend({ prompt: promptText, mode: requestedMode }); setOverlay('login'); return; }
    if (!selectedSource?.callable || !selectedModelInfo) { setNotice('当前模型源仅供查看目录，配置该源密钥后才能调用。'); return; }
    let task = requestedTask;
    if (task && task.deviceId !== currentDeviceId) { setNotice(`该任务应在 ${devices.find((device) => device.id === task!.deviceId)?.name ?? '目标设备'} 上执行`); return; }
    try {
      if (!task) {
        if (!currentDeviceId) throw new Error('当前设备尚未完成注册');
        task = await createRemoteTask(session.token, promptText.slice(0, 80), currentDeviceId);
        setTasks((current) => [task!, ...current]); setActiveTaskId(task.id);
      }
      if (task.status !== 'running') task = await changeTaskStatus(task, 'running');
      const submittedPrompt = promptText;
      const taskMessages = messagesByTask[task.id] ?? [];
      const conversationMessages = [
        ...taskMessages.slice(-19).map(({ role, content }) => ({ role, content })),
        { role: 'user' as const, content: submittedPrompt },
      ];
      appendMessage(task.id, { id: createClientId(), role: 'user', content: submittedPrompt, createdAt: new Date().toISOString() });
      setPrompt(''); setIsSending(true); setAgentStatus('正在执行'); setNotice('');
      let reply = '';
      let replyMode: 'live' | 'demo' = capabilities?.ai.mode === 'demo' ? 'demo' : 'live';
      const acpUrl = requestedMode === 'code' ? await window.codDesktop?.getGooseAcpUrl({ token: session.token, sourceId: selectedSource.id, modelId: selectedModelInfo.id }) : null;
      if (requestedMode === 'code' && hasDesktopBridge() && project.root && acpUrl) {
        const { runGooseTask } = await import('./goose');
        setAgentStatus('连接本机 Goose');
        const contextualPrompt = conversationMessages.length === 1 ? submittedPrompt : `Continue this conversation using the current project.\n\n${conversationMessages.map((message) => `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.content}`).join('\n\n')}`;
        reply = await runGooseTask({ acpUrl, cwd: project.root, prompt: contextualPrompt, onUpdate: (update) => { if (update.kind === 'message') reply += update.text; if (update.kind === 'tool' || update.kind === 'status') setAgentStatus(update.text); }, requestPermission: (request) => new Promise((resolve) => { permissionResolver.current = resolve; setPendingPermission({ title: request.toolCall.title ?? '工具权限请求', options: request.options }); }) });
        if (!reply) reply = 'Goose 已完成任务，请在右侧刷新文件与 Diff。';
      } else {
        if (requestedMode === 'code' && !hasDesktopBridge()) setNotice('Web 端仅提供代码问答；修改本机文件请使用 COD Desktop。');
        if (!selectedSource?.callable || !selectedModelInfo) throw new Error('当前模型源仅供查看目录，配置该源密钥后才能调用。');
        const result = await sendChat(session.token, selectedSource.id, selectedModelInfo.id, conversationMessages); reply = result.content; replyMode = result.mode;
        appendMessage(task.id, { id: createClientId(), role: 'assistant', content: reply, mode: replyMode, sourceLabel: selectedSource.label, model: selectedModelInfo.id, inputTokens: result.inputTokens, outputTokens: result.outputTokens, createdAt: new Date().toISOString() });
      }
      if (requestedMode === 'code' && hasDesktopBridge() && project.root) appendMessage(task.id, { id: createClientId(), role: 'assistant', content: reply, mode: replyMode, sourceLabel: selectedSource.label, model: selectedModelInfo.id, createdAt: new Date().toISOString() });
      if (task.status === 'running' || task.status === 'waiting') task = await changeTaskStatus(task, 'complete', { result: reply, error: null });
      setAgentStatus('已完成'); await refreshWallet();
      if (hasDesktopBridge() && project.root) { const snapshot = await loadProject(project.root); if (snapshot) setProject(snapshot); }
    } catch (error) {
      setAgentStatus('执行失败'); setNotice(error instanceof Error ? error.message : 'COD 执行失败');
      if (task && session && (task.status === 'draft' || task.status === 'running' || task.status === 'waiting')) { try { await changeTaskStatus(task, 'failed', { error: error instanceof Error ? error.message : 'COD 执行失败' }); } catch { /* Preserve the original error. */ } }
    } finally { setIsSending(false); }
  };
  pendingSendRunner.current = (nextPrompt, nextMode) => { void handleSend(nextPrompt, null, nextMode); };
  useEffect(() => {
    if (!session || !pendingSend || isSending) return;
    const next = pendingSend;
    setPendingSend(null);
    pendingSendRunner.current(next.prompt, next.mode);
  }, [session, pendingSend, isSending]);
  const executeSynchronizedTask = (task: RemoteTask) => {
    if (task.deviceId !== currentDeviceId) { setNotice('请在任务指定的目标设备上执行。'); return; }
    if (hasDesktopBridge() && !project.root) { setNotice('请先在 COD Desktop 中选择该任务要操作的项目。'); return; }
    const instruction = task.status === 'draft' ? task.title : prompt.trim() || task.title;
    void handleSend(instruction, task, hasDesktopBridge() ? 'code' : 'chat');
  };
  const completeSynchronizedTask = (task: RemoteTask) => {
    if (task.deviceId !== currentDeviceId) { setNotice('请在任务指定的目标设备上更新状态。'); return; }
    void changeTaskStatus(task, 'complete').catch((error) => setNotice(error.message));
  };
  const resolvePermission = (optionId: string | null) => { permissionResolver.current?.(optionId); permissionResolver.current = null; setPendingPermission(null); };
  const handleOpenProject = async () => {
    if (!hasDesktopBridge()) { setNotice('Web 端不能读取服务器或本机文件。请在 COD Desktop 中选择项目。'); return; }
    try { const snapshot = await openProject(); if (snapshot) { setProject(snapshot); storageSet('cod.project.root', snapshot.root); } }
    catch (error) { setNotice(error instanceof Error ? error.message : '项目打开失败'); }
  };
  const refreshProject = async () => {
    if (!hasDesktopBridge() || !project.root) { setNotice('请先在 COD Desktop 中选择项目。'); return; }
    try { const snapshot = await loadProject(project.root); if (snapshot) setProject((current) => ({ ...snapshot, selectedFile: current.selectedFile, selectedContent: current.selectedContent })); }
    catch (error) { setNotice(error instanceof Error ? error.message : '项目刷新失败'); }
  };
  const handleFileSelect = async (file: WorkspaceFile) => {
    if (file.kind !== 'file' || !project.root) return;
    try { const content = await readProjectFile(project.root, file.path); setProject((current) => ({ ...current, selectedFile: file.path, selectedContent: content })); }
    catch (error) { setNotice(error instanceof Error ? error.message : '文件读取失败'); }
  };
  const handleRun = async () => {
    if (!window.codDesktop || !project.root) { setNotice('Web 端不会执行或伪造终端命令；请使用 COD Desktop 并选择项目。'); return; }
    setTerminalOutput(`$ ${command}\n执行中...`);
    const result = await window.codDesktop.runCommand(project.root, command);
    setTerminalOutput(`$ ${result.command}\n${result.output}\nexit ${result.exitCode ?? 'unknown'}`);
  };
  const toggleInspector = () => setInspectorOpen((current) => {
    const next = !current;
    storageSet('cod.inspector.open', String(next));
    return next;
  });

  return <div className={`app-shell${inspectorOpen ? '' : ' inspector-hidden'}`}>
    <aside className="rail"><Brand /><div className="rail-actions"><button className={`icon-button ${mode === 'code' ? 'active' : ''}`} title="任务" onClick={() => { setMode('code'); setSidebarOpen(true); }}><ListChecks weight="fill" /></button><button className={`icon-button ${mode === 'chat' ? 'active' : ''}`} title="普通对话" onClick={() => setMode('chat')}><ChatCircleDots /></button><button className="icon-button" title="模型库" onClick={() => setOverlay('models')}><Stack /></button><button className="icon-button" title="命令面板" onClick={() => setOverlay('commands')}><Command /></button>{products.map((product) => <button className="icon-button" title={product.name} key={product.id} onClick={() => void handleProductLaunch(product)}><ArrowSquareOut /></button>)}</div><div className="rail-footer"><ThemeToggle colorMode={colorMode} onChange={setColorMode} /><button className="icon-button" title={session ? '账户' : '登录'} onClick={() => setOverlay(session ? 'account' : 'login')}><UserCircle /></button></div></aside>
    {sidebarOpen && <button className="sidebar-scrim" aria-label="关闭任务栏" onClick={() => setSidebarOpen(false)} />}
    <aside className={`sidebar ${sidebarOpen ? 'open' : ''}`}><div className="sidebar-head"><div><small>工作区</small><strong>{mode === 'code' ? '代码任务' : '对话'}</strong></div><button className="new-task" onClick={() => setOverlay(session ? 'new-task' : 'login')}><Plus weight="bold" /> 新任务</button></div><div className="search"><MagnifyingGlass /><input aria-label="搜索任务" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="搜索任务或状态" /></div><TaskList tasks={filteredTasks} devices={devices} activeId={activeTaskId} onSelect={(id) => { setActiveTaskId(id); setSidebarOpen(false); }} /><div className="sidebar-bottom">{notice && <div className="remote-notice">{notice}</div>}<button className="project-switch" onClick={handleOpenProject}><span className="project-icon"><Folder weight="fill" /></span><span><small>当前项目</small><strong>{projectName}</strong></span><CaretDown /></button><div className="balance-preview"><Lightning weight="fill" /><span><small>可用使用额度</small><strong>{session ? `¥ ${((session.account.balanceCents + creditPacks.summary.availableCents) / 100).toFixed(2)}` : '登录后查看'}</strong></span><button onClick={() => setOverlay(session ? 'account' : 'login')}>{session ? '额度包' : '登录'}</button></div></div></aside>
    <main className="workspace"><header className="workspace-header"><div className="task-heading"><button className="mobile-only icon-button" title="打开任务栏" onClick={() => setSidebarOpen(true)}><SidebarSimple /></button><div><h1>{activeTask?.title ?? (session ? '新建或选择任务' : '新对话')}</h1><p>{project.root || (authState === 'loading' ? '正在连接 COD…' : session ? 'Web 远程工作区' : '输入消息即可开始')}</p></div></div><div className="header-actions">{activeTask && <span className={`header-status ${activeTask.status}`}>{statusLabels[activeTask.status]}</span>}<div className="mode-switch" aria-label="工作模式"><button className={mode === 'code' ? 'active' : ''} onClick={() => setMode('code')}><Code /> 代码</button><button className={mode === 'chat' ? 'active' : ''} onClick={() => setMode('chat')}><ChatCircleDots /> 对话</button></div><select className="source-picker" aria-label="模型源" value={selectedSource?.id ?? ''} onChange={(event) => handleSourceChange(event.target.value)} disabled={!session}><option value="">{authState === 'loading' ? '正在连接…' : '登录后选择模型源'}</option>{session?.sources.map((source) => <option key={source.id} value={source.id}>{source.label} · {source.callable ? '已连接' : source.status === 'catalog' ? '目录' : '不可用'}</option>)}</select><select className="model-picker" aria-label="模型" value={selectedModelInfo?.id ?? ''} onChange={(event) => handleModelChange(event.target.value)} disabled={!session || !sourceModels.length}><option value="">登录后选择模型</option>{sourceModels.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}</select><button className={`icon-button inspector-toggle${inspectorOpen ? ' active' : ''}`} title={inspectorOpen ? '隐藏右侧面板' : '显示右侧面板'} onClick={toggleInspector}><SidebarSimple /></button></div></header>
      <section className="conversation"><div className="conversation-scroll">{!activeTask && <div className="empty-state"><div className="agent-avatar"><span>C</span></div><h2>{session ? '从一个真实任务开始' : '有什么可以帮你？'}</h2><p>{session ? '新建任务后，状态、目标设备和执行结果会同步保存。' : '直接输入你的第一条消息；发送时再登录，内容不会丢失。'}</p>{session && <button className="primary-button" onClick={() => setOverlay('new-task')}><Plus /> 新建任务</button>}</div>}{activeTask && !activeMessages.length && !activeTask.result && !activeTask.error && <div className="empty-state compact"><StatusGlyph status={activeTask.status} /><h2>{activeTask.title}</h2><p>任务已同步到 {devices.find((device) => device.id === activeTask.deviceId)?.name ?? '目标设备'}。输入内容开始执行。</p></div>}{activeTask && !activeMessages.length && (activeTask.result || activeTask.error) && <article className="agent-message"><div className="agent-avatar"><span>C</span></div><div><header><strong>{activeTask.error ? '远程任务失败' : '远程任务结果'}</strong></header><p>{activeTask.error ?? activeTask.result}</p><small>{formatTime(activeTask.updatedAt)}</small></div></article>}{activeMessages.map((message) => message.role === 'user' ? <article className="user-message" key={message.id}><p>{message.content}</p><small>{formatTime(message.createdAt)}</small></article> : <article className="agent-message" key={message.id}><div className="agent-avatar"><span>C</span></div><div><header><strong>COD Agent</strong>{message.mode === 'demo' && <span className="demo-chip">演示响应</span>}{message.sourceLabel && <span className="source-chip">{message.sourceLabel} · {message.model}{message.inputTokens !== undefined && message.outputTokens !== undefined ? ` · 输入 ${message.inputTokens.toLocaleString('zh-CN')} / 输出 ${message.outputTokens.toLocaleString('zh-CN')} Token` : ''}</span>}</header><p>{message.content}</p><small>{formatTime(message.createdAt)}</small></div></article>)}{isSending && <div className="agent-intro"><div className="agent-avatar"><span>C</span></div><div><strong>COD Agent</strong><small>{agentStatus}</small></div><span className="live-chip"><CircleNotch className="spin" /> running</span></div>}{pendingPermission && <div className="live-permission"><strong>{pendingPermission.title}</strong><p>Goose 请求执行权限，请确认本次操作。</p><div>{pendingPermission.options.map((option) => <button className={option.kind.startsWith('allow') ? 'approve' : ''} key={option.optionId} onClick={() => resolvePermission(option.optionId)}>{option.name}</button>)}<button onClick={() => resolvePermission(null)}>取消</button></div></div>}</div>
        <div className="composer-wrap">
          {activeTask && <div className="task-actions">{(activeTask.status === 'draft' || activeTask.status === 'failed' || activeTask.status === 'complete') && <button onClick={() => executeSynchronizedTask(activeTask)}><Play /> {activeTask.status === 'failed' ? '重试任务' : activeTask.status === 'complete' ? '继续任务' : '执行任务'}</button>}{(activeTask.status === 'running' || activeTask.status === 'waiting') && <button onClick={() => completeSynchronizedTask(activeTask)}><Check /> 标记完成</button>}</div>}
          <div className="context-strip"><span><Folder weight="fill" /> {projectName}</span><span><GitDiff /> {changeCount} 个改动</span><span><ShieldCheck /> 受控模式</span>{selectedSource && <span><Lightning weight="fill" /> {selectedSource.paymentDirection}</span>}{selectedModelInfo && <span>输入 ¥{(selectedModelInfo.inputPricePerMillionCents / 100).toFixed(2)} / 输出 ¥{(selectedModelInfo.outputPricePerMillionCents / 100).toFixed(2)} 每百万 Token</span>}<button onClick={handleKnowledge} disabled={knowledgeLoading}>{knowledgeLoading ? <CircleNotch className="spin" /> : <MagnifyingGlass />} 公司 Wiki</button><button onClick={handleRemoteTask}><PaperPlaneTilt /> 发送到设备</button></div>
          {notice && <div className="remote-notice"><span>{notice}</span><button title="关闭提示" onClick={() => setNotice('')}><X /></button></div>}
          {knowledgeHits.length > 0 && <div className="knowledge-strip">{knowledgeHits.map((hit) => <a href={hit.url} target="_blank" rel="noreferrer" key={hit.id}><strong>{hit.title}</strong><span>{hit.excerpt}</span></a>)}</div>}
          <div className="composer"><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void handleSend(); }} placeholder={mode === 'code' ? '让 COD 修改、检查或解释这个项目...' : '问 COD 任何问题...'} /><div className="composer-footer"><button className="composer-tool" title="查看项目文件" onClick={() => { if (hasDesktopBridge()) setInspectorTab('files'); else setNotice('项目文件仅在 COD Desktop 中可用。'); }}><Plus /></button><span>⌘ ↵ 发送</span><button className="send" title="发送" disabled={!prompt.trim() || isSending || Boolean(session && !selectedSource?.callable && !(mode === 'code' && hasDesktopBridge() && project.root))} onClick={() => void handleSend()}>{isSending ? <CircleNotch className="spin" /> : <PaperPlaneTilt weight="fill" />}</button></div></div>
        </div></section>
    </main>
    {inspectorOpen && <aside className="inspector"><div className="inspector-tabs"><button className={inspectorTab === 'changes' ? 'active' : ''} onClick={() => setInspectorTab('changes')}><GitDiff /> 改动</button><button className={inspectorTab === 'files' ? 'active' : ''} onClick={() => setInspectorTab('files')}><Folder /> 文件</button><button className={inspectorTab === 'terminal' ? 'active' : ''} onClick={() => setInspectorTab('terminal')}><TerminalWindow /> 终端</button><button className="inspector-close" title="隐藏右侧面板" onClick={toggleInspector}><X /></button></div><div className="inspector-body">{inspectorTab === 'changes' && <><div className="panel-title"><span><GitDiff /> 未提交改动</span><button title="刷新" onClick={refreshProject}><ArrowClockwise /></button></div>{project.root ? <CodeBlock text={project.diff || '当前项目没有未提交改动。'} /> : <div className="panel-empty">Web 端不伪造 Diff。请在 COD Desktop 中选择本机项目。</div>}</>}{inspectorTab === 'files' && <>{project.root ? <><div className="panel-title"><span><Folder /> 项目文件</span><small>{project.files.length}</small></div><FileTree files={project.files} selected={project.selectedFile} onSelect={handleFileSelect} />{project.selectedFile && <div className="file-preview"><strong>{project.selectedFile}</strong><CodeBlock text={project.selectedContent} /></div>}</> : <div className="panel-empty">本机文件仅在 COD Desktop 中可用。</div>}</>}{inspectorTab === 'terminal' && <>{window.codDesktop && project.root ? <><div className="panel-title"><span><TerminalWindow /> 本地终端</span><small>desktop</small></div><div className="terminal"><pre>{terminalOutput}</pre><div className="terminal-command"><span>$</span><input aria-label="终端命令" value={command} onChange={(event) => setCommand(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && handleRun()} /><button onClick={handleRun}>运行</button></div></div></> : <div className="panel-empty">Web 端不会执行或伪造终端结果。请使用 COD Desktop。</div>}</>}</div></aside>}
    {overlay === 'login' && <Modal title={pendingSend ? '登录后继续' : '登录 COD'} onClose={() => { setPendingSend(null); setOverlay(null); }}><LoginForm capabilities={capabilities} capabilityError={capabilityError} resumeConversation={Boolean(pendingSend)} onLogin={handleLogin} /></Modal>}
    {overlay === 'models' && <Modal title="模型库" wide onClose={() => setOverlay(null)}><ModelLibrary sources={modelCatalog} error={modelCatalogError} signedIn={Boolean(session)} onLogin={() => setOverlay('login')} /></Modal>}
    {overlay === 'new-task' && session && <Modal title="新建任务" onClose={() => setOverlay(null)}><form className="modal-form" onSubmit={handleCreateTask}><label>任务标题<input aria-label="任务标题" value={newTaskTitle} onChange={(event) => setNewTaskTitle(event.target.value)} placeholder="例如：审计登录流程" required autoFocus /></label><label>目标设备<select aria-label="目标设备" value={targetDeviceId} onChange={(event) => setTargetDeviceId(event.target.value)} required>{devices.map((device) => <option key={device.id} value={device.id}>{device.name} · {device.status}</option>)}</select></label><button className="primary-button" disabled={!newTaskTitle.trim() || !targetDeviceId}><Plus /> 创建并同步</button></form></Modal>}
    {overlay === 'account' && session && <Modal title="钱包与额度包" wide onClose={() => setOverlay(null)}><div className="account-panel">
      <div className="balance-grid"><div className="account-balance"><small>钱包余额 · 永久有效</small><strong>¥ {(session.account.balanceCents / 100).toFixed(2)}</strong><span>{session.account.displayName} · {session.account.plan}</span></div><div className="account-balance credit"><small>可用使用额度 · 优先扣减</small><strong>¥ {(creditPacks.summary.availableCents / 100).toFixed(2)}</strong><span>{creditPacks.summary.grants.filter((grant) => grant.status === 'active').length} 个有效批次</span></div></div>
      <section className="credit-pack-section"><header><div><strong>购买 180 天额度包</strong><small>使用钱包余额购买；额度不可退回钱包，调用时按最早到期顺序消耗。</small></div></header><div className="credit-pack-grid">{creditPacks.packs.map((pack) => <article key={pack.id}><span>{pack.bonusPercent ? `赠 ${pack.bonusPercent}%` : '基础档'}</span><strong>{pack.name}</strong><b>¥ {(pack.creditCents / 100).toFixed(0)} <small>使用额度</small></b><p>钱包支付 ¥{(pack.priceCents / 100).toFixed(0)} · {pack.validityDays} 天</p><button disabled={Boolean(purchasingPackId) || session.account.balanceCents < pack.priceCents} onClick={() => void handlePurchaseCreditPack(pack.id)}>{purchasingPackId === pack.id ? <CircleNotch className="spin" /> : <Lightning weight="fill" />} {session.account.balanceCents < pack.priceCents ? '钱包余额不足' : '立即购买'}</button></article>)}</div></section>
      {creditPacks.summary.grants.length > 0 && <section className="credit-grants"><header><strong>额度批次</strong><small>试用金 30 天；购买额度包 180 天</small></header>{creditPacks.summary.grants.map((grant) => <div key={grant.id}><span><strong>{grant.name}</strong><small>{grant.status === 'expired' ? '已过期' : grant.status === 'depleted' ? '已用完' : `有效至 ${new Date(grant.expiresAt).toLocaleDateString('zh-CN')}`}</small></span><b className={grant.status}>¥ {(grant.remainingCents / 100).toFixed(2)} / ¥ {(grant.originalCents / 100).toFixed(2)}</b></div>)}</section>}
      <div className="service-grid"><span>模型网关<strong className={capabilities?.ai.mode === 'live' ? 'live' : 'demo'}>{capabilities?.ai.mode === 'live' ? '已连接' : capabilities?.ai.mode === 'demo' ? '演示模式' : '不可用'}</strong></span><span>扣费顺序<strong>临期额度 → 钱包</strong></span><span>钱包方式<strong>{capabilities?.payments.mode === 'verified-webhook' ? '已验证支付回调' : capabilities?.payments.mode === 'pilot-credit' ? '试点预存' : '未接入'}</strong></span><span>支付方向<strong>{selectedSource?.paymentDirection ?? '未选择'}</strong></span></div>
      {capabilities?.payments.topupEnabled && <div className="topup-panel"><div><strong>预存试点钱包</strong><small>仅用于本轮产品与计费闭环测试，不代表真实支付已到账。</small></div><div><button onClick={() => handleTopup(1000)}>+ ¥10</button><button onClick={() => handleTopup(5000)}>+ ¥50</button><button onClick={() => handleTopup(10000)}>+ ¥100</button></div></div>}
      <div className="ledger"><header><strong>最近流水</strong><button onClick={refreshWallet}><ArrowClockwise /> 刷新</button></header>{ledger.length ? ledger.map((entry) => <div key={entry.id}><span>{entry.type === 'usage' ? `${entry.model ?? '模型'} 用量` : entry.type === 'pack_purchase' ? `购买 ${entry.reference}` : entry.type === 'trial_credit' ? '新用户试用金' : entry.type === 'credit_grant' ? `${entry.reference} 到账` : '钱包预存'}<small>{entry.paymentDirection ?? entry.reference} · {formatTime(entry.createdAt)}{entry.type === 'usage' && entry.creditAmountCents !== 0 ? ` · 额度包 ¥${Math.abs(entry.creditAmountCents / 100).toFixed(2)}` : ''}{entry.type === 'usage' && entry.walletAmountCents !== 0 ? ` · 钱包 ¥${Math.abs(entry.walletAmountCents / 100).toFixed(2)}` : ''}</small></span><strong className={entry.amountCents < 0 ? 'negative' : 'positive'}>{entry.amountCents > 0 ? '+' : ''}¥ {(entry.amountCents / 100).toFixed(2)}</strong></div>) : <p>暂无流水</p>}</div><button className="secondary-button" onClick={handleLogout}><SignOut /> 退出登录</button>
    </div></Modal>}
    {overlay === 'commands' && <Modal title="命令面板" onClose={() => setOverlay(null)}><div className="command-list"><button onClick={() => setOverlay(session ? 'new-task' : 'login')}><Plus /><span><strong>新建任务</strong><small>创建并同步到设备</small></span></button><button onClick={() => { setMode('code'); setOverlay(null); }}><Code /><span><strong>代码模式</strong><small>进入项目与 Agent 工作区</small></span></button><button onClick={() => { setMode('chat'); setOverlay(null); }}><ChatCircleDots /><span><strong>普通对话</strong><small>使用选定模型提问</small></span></button><button onClick={() => setOverlay('models')}><Stack /><span><strong>模型库</strong><small>查看可用模型与每百万 Token 价格</small></span></button><button onClick={() => { setInspectorTab('terminal'); setOverlay(null); }}><TerminalWindow /><span><strong>打开终端</strong><small>{hasDesktopBridge() ? '运行受控本机命令' : '仅桌面端可用'}</small></span></button><button onClick={() => setOverlay(session ? 'account' : 'login')}><UserCircle /><span><strong>账户与服务状态</strong><small>余额、流水和接入状态</small></span></button></div></Modal>}
  </div>;
}
