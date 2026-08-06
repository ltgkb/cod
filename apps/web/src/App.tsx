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
  PaperPlaneTilt,
  Play,
  Plus,
  ShieldCheck,
  SidebarSimple,
  SignOut,
  TerminalWindow,
  UserCircle,
  Warning,
  X,
} from '@phosphor-icons/react';
import type { DeviceRecord, KnowledgeHit, ProductManifest, TaskStatus, WorkspaceFile } from '@cod/contracts';
import {
  createRemoteTask,
  getCapabilities,
  heartbeatDevice,
  listDevices,
  listLedger,
  listProducts,
  listTasks,
  loginCod,
  logoutCod,
  refreshAccount,
  registerDevice,
  resumeCodSession,
  searchKnowledge,
  sendChat,
  topup,
  updateRemoteTask,
  type CapabilityReport,
  type CodSession,
  type LedgerEntry,
  type RemoteTask,
} from './api';
import { hasDesktopBridge, loadProject, openProject, readProjectFile } from './desktop';
import type { InspectorTab, ProjectSnapshot, WorkspaceMode } from './types';

const statusLabels: Record<TaskStatus, string> = {
  draft: '草稿', running: '运行中', waiting: '待确认', complete: '已完成', failed: '失败',
};
const emptyProject: ProjectSnapshot = { root: '', files: [], diff: '', selectedFile: null, selectedContent: '' };
type Overlay = 'new-task' | 'account' | 'commands' | null;
type AuthState = 'loading' | 'signed-out' | 'signed-in';
interface ChatMessage { id: string; role: 'user' | 'assistant'; content: string; mode?: 'live' | 'demo'; createdAt: string }

function storageGet(key: string): string | null {
  try { return window.localStorage.getItem(key); } catch { return null; }
}
function storageSet(key: string, value: string): void {
  try { window.localStorage.setItem(key, value); } catch { /* Storage can be unavailable in private contexts. */ }
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
function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section className="modal" role="dialog" aria-modal="true" aria-label={title}><header><strong>{title}</strong><button className="icon-button" title="关闭" onClick={onClose}><X /></button></header>{children}</section></div>;
}

function LoginScreen({ capabilities, capabilityError, onLogin }: { capabilities: CapabilityReport | null; capabilityError: string; onLogin: (email: string, accessCode: string) => Promise<void> }) {
  const [email, setEmail] = useState('developer@kai.com');
  const [accessCode, setAccessCode] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setSubmitting(true); setError('');
    try { await onLogin(email, accessCode); } catch (nextError) { setError(nextError instanceof Error ? nextError.message : '登录失败'); } finally { setSubmitting(false); }
  };
  return <main className="login-shell"><section className="login-card"><Brand /><div className="login-copy"><span className="eyebrow">PRIVATE PILOT</span><h1>进入 COD 工作区</h1><p>使用获批的 KAI 账号和试点访问码登录。会话仅保存在当前设备。</p></div>{capabilityError && <div className="notice error">{capabilityError}</div>}<form onSubmit={submit}><label>邮箱<input aria-label="邮箱" type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="username" required /></label><label>访问码<input aria-label="访问码" type="password" value={accessCode} onChange={(event) => setAccessCode(event.target.value)} autoComplete="current-password" required={capabilities?.authentication.accessCodeRequired ?? true} /></label>{error && <div className="notice error">{error}</div>}<button className="primary-button" disabled={submitting}>{submitting ? <CircleNotch className="spin" /> : <Key />} 登录</button></form><div className="capability-summary"><span className={capabilities?.ai.mode === 'live' ? 'live' : 'demo'}>模型：{capabilities?.ai.mode === 'live' ? '已连接' : capabilities?.ai.mode === 'demo' ? '演示模式' : '待检测'}</span><span>同步：{capabilities ? '可用' : '待检测'}</span></div></section></main>;
}

export function App() {
  const [authState, setAuthState] = useState<AuthState>('loading');
  const [capabilities, setCapabilities] = useState<CapabilityReport | null>(null);
  const [capabilityError, setCapabilityError] = useState('');
  const [session, setSession] = useState<CodSession | null>(null);
  const [tasks, setTasks] = useState<RemoteTask[]>([]);
  const [devices, setDevices] = useState<DeviceRecord[]>([]);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [products, setProducts] = useState<ProductManifest[]>([]);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [targetDeviceId, setTargetDeviceId] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [mode, setMode] = useState<WorkspaceMode>('code');
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('changes');
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [newTaskTitle, setNewTaskTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [command, setCommand] = useState('npm test');
  const [terminalOutput, setTerminalOutput] = useState('选择本机项目后可运行受控命令。');
  const [selectedModel, setSelectedModel] = useState('coder-pro');
  const [knowledgeHits, setKnowledgeHits] = useState<KnowledgeHit[]>([]);
  const [knowledgeLoading, setKnowledgeLoading] = useState(false);
  const [notice, setNotice] = useState('');
  const [messagesByTask, setMessagesByTask] = useState<Record<string, ChatMessage[]>>({});
  const [isSending, setIsSending] = useState(false);
  const [agentStatus, setAgentStatus] = useState('就绪');
  const [pendingPermission, setPendingPermission] = useState<{ title: string; options: Array<{ optionId: string; name: string; kind: string }> } | null>(null);
  const [project, setProject] = useState<ProjectSnapshot>(emptyProject);
  const permissionResolver = useRef<((optionId: string | null) => void) | null>(null);

  const activeTask = useMemo(() => tasks.find((task) => task.id === activeTaskId) ?? null, [tasks, activeTaskId]);
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
    const [initialDevices, nextTasks, nextProducts, nextLedger] = await Promise.all([listDevices(nextSession.token), listTasks(nextSession.token), listProducts(nextSession.token), listLedger(nextSession.token)]);
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
    setDevices(nextDevices); setTasks(nextTasks); setProducts(nextProducts); setLedger(nextLedger);
    setTargetDeviceId((current) => current || nextDevices.find((device) => device.status === 'online' && !['web', 'mobile'].includes(device.platform))?.id || currentDevice!.id);
    setActiveTaskId((current) => current && nextTasks.some((task) => task.id === current) ? current : nextTasks[0]?.id ?? null);
    setSelectedModel(nextSession.models[0]?.id ?? 'coder-pro');
  };

  useEffect(() => {
    let mounted = true;
    Promise.allSettled([getCapabilities(), resumeCodSession()]).then(async ([capabilityResult, sessionResult]) => {
      if (!mounted) return;
      if (capabilityResult.status === 'fulfilled') setCapabilities(capabilityResult.value); else setCapabilityError('控制平面暂不可达，请检查网络或服务状态。');
      const nextSession = sessionResult.status === 'fulfilled' ? sessionResult.value : null;
      if (!nextSession) { setAuthState('signed-out'); return; }
      try { await loadWorkspace(nextSession); if (mounted) { setSession(nextSession); setAuthState('signed-in'); } }
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
    await loadWorkspace(nextSession); setSession(nextSession); setAuthState('signed-in');
  };
  const handleLogout = () => { logoutCod(); setSession(null); setTasks([]); setDevices([]); setOverlay(null); setAuthState('signed-out'); };
  const refreshWallet = async () => {
    if (!session) return;
    const [account, nextLedger] = await Promise.all([refreshAccount(session.token), listLedger(session.token)]);
    setSession({ ...session, account }); setLedger(nextLedger);
  };
  const handleTopup = async () => {
    if (!session || !capabilities?.payments.topupEnabled) { setNotice('支付渠道尚未接入，当前不可充值。'); setOverlay('account'); return; }
    try { const account = await topup(session.token, 1000); setSession({ ...session, account }); await refreshWallet(); }
    catch (error) { setNotice(error instanceof Error ? error.message : '充值失败'); }
  };
  const handleCreateTask = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!session || !newTaskTitle.trim() || !targetDeviceId) return;
    try {
      const task = await createRemoteTask(session.token, newTaskTitle.trim(), targetDeviceId);
      setTasks((current) => [task, ...current]); setActiveTaskId(task.id); setNewTaskTitle(''); setOverlay(null); setSidebarOpen(false); setNotice('任务已创建并同步到目标设备。');
    } catch (error) { setNotice(error instanceof Error ? error.message : '创建任务失败'); }
  };
  const changeTaskStatus = async (task: RemoteTask, status: TaskStatus): Promise<RemoteTask> => {
    if (!session) return task;
    const updated = await updateRemoteTask(session.token, task, status); replaceTask(updated); return updated;
  };
  const handleKnowledge = async () => {
    if (!session) return;
    const query = prompt.trim() || activeTask?.title || '';
    if (!query) { setNotice('请先输入要检索的内容。'); return; }
    setKnowledgeLoading(true); setKnowledgeHits([]);
    try { const hits = await searchKnowledge(session.token, query); setKnowledgeHits(hits); if (!hits.length) setNotice('公司 Wiki 没有找到匹配结果。'); }
    catch (error) { setNotice(error instanceof Error ? error.message : 'Wiki 检索失败'); }
    finally { setKnowledgeLoading(false); }
  };
  const handleRemoteTask = async () => {
    if (!session || !targetDeviceId) { setNotice('没有可用的目标设备。'); return; }
    const title = prompt.trim() || activeTask?.title;
    if (!title) { setOverlay('new-task'); return; }
    try { const task = await createRemoteTask(session.token, title, targetDeviceId); setTasks((current) => [task, ...current]); setActiveTaskId(task.id); setNotice(`已发送到 ${devices.find((device) => device.id === targetDeviceId)?.name ?? '目标设备'}。`); }
    catch (error) { setNotice(error instanceof Error ? error.message : '发送失败'); }
  };
  const handleSend = async () => {
    if (!prompt.trim() || !session || isSending) return;
    let task = activeTask;
    try {
      if (!task) {
        if (!targetDeviceId) throw new Error('没有可用的目标设备');
        task = await createRemoteTask(session.token, prompt.trim().slice(0, 80), targetDeviceId);
        setTasks((current) => [task!, ...current]); setActiveTaskId(task.id);
      }
      if (task.status !== 'running') task = await changeTaskStatus(task, 'running');
      const submittedPrompt = prompt.trim();
      appendMessage(task.id, { id: crypto.randomUUID(), role: 'user', content: submittedPrompt, createdAt: new Date().toISOString() });
      setPrompt(''); setIsSending(true); setAgentStatus('正在执行'); setNotice('');
      let reply = '';
      let replyMode: 'live' | 'demo' = capabilities?.ai.mode === 'demo' ? 'demo' : 'live';
      const acpUrl = mode === 'code' ? await window.codDesktop?.getGooseAcpUrl() : null;
      if (mode === 'code' && hasDesktopBridge() && project.root && acpUrl) {
        const { runGooseTask } = await import('./goose');
        setAgentStatus('连接本机 Goose');
        reply = await runGooseTask({ acpUrl, cwd: project.root, prompt: submittedPrompt, onUpdate: (update) => { if (update.kind === 'message') reply += update.text; if (update.kind === 'tool' || update.kind === 'status') setAgentStatus(update.text); }, requestPermission: (request) => new Promise((resolve) => { permissionResolver.current = resolve; setPendingPermission({ title: request.toolCall.title ?? '工具权限请求', options: request.options }); }) });
        if (!reply) reply = 'Goose 已完成任务，请在右侧刷新文件与 Diff。';
      } else {
        if (mode === 'code' && !hasDesktopBridge()) setNotice('Web 端仅提供代码问答；修改本机文件请使用 COD Desktop。');
        const result = await sendChat(session.token, selectedModel, submittedPrompt); reply = result.content; replyMode = result.mode;
      }
      appendMessage(task.id, { id: crypto.randomUUID(), role: 'assistant', content: reply, mode: replyMode, createdAt: new Date().toISOString() });
      if (task.status === 'running' || task.status === 'waiting') task = await changeTaskStatus(task, 'complete');
      setAgentStatus('已完成'); await refreshWallet();
      if (hasDesktopBridge() && project.root) { const snapshot = await loadProject(project.root); if (snapshot) setProject(snapshot); }
    } catch (error) {
      setAgentStatus('执行失败'); setNotice(error instanceof Error ? error.message : 'COD 执行失败');
      if (task && session && (task.status === 'draft' || task.status === 'running' || task.status === 'waiting')) { try { await changeTaskStatus(task, 'failed'); } catch { /* Preserve the original error. */ } }
    } finally { setIsSending(false); }
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

  if (authState === 'loading') return <main className="loading-shell"><Brand /><CircleNotch className="spin" /><span>正在连接控制平面…</span></main>;
  if (authState === 'signed-out' || !session) return <LoginScreen capabilities={capabilities} capabilityError={capabilityError} onLogin={handleLogin} />;

  return <div className="app-shell">
    <aside className="rail"><Brand /><div className="rail-actions"><button className={`icon-button ${mode === 'code' ? 'active' : ''}`} title="任务" onClick={() => { setMode('code'); setSidebarOpen(true); }}><ListChecks weight="fill" /></button><button className={`icon-button ${mode === 'chat' ? 'active' : ''}`} title="普通对话" onClick={() => setMode('chat')}><ChatCircleDots /></button><button className="icon-button" title="命令面板" onClick={() => setOverlay('commands')}><Command /></button>{products.map((product) => <button className="icon-button" title={product.name} key={product.id} onClick={() => window.open(product.launchUrl, '_blank', 'noopener,noreferrer')}><ArrowSquareOut /></button>)}</div><div className="rail-footer"><button className="icon-button" title="账户" onClick={() => setOverlay('account')}><UserCircle /></button></div></aside>
    {sidebarOpen && <button className="sidebar-scrim" aria-label="关闭任务栏" onClick={() => setSidebarOpen(false)} />}
    <aside className={`sidebar ${sidebarOpen ? 'open' : ''}`}><div className="sidebar-head"><div><small>工作区</small><strong>{mode === 'code' ? '代码任务' : '对话'}</strong></div><button className="new-task" onClick={() => setOverlay('new-task')}><Plus weight="bold" /> 新任务</button></div><div className="search"><MagnifyingGlass /><input aria-label="搜索任务" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="搜索任务或状态" /></div><TaskList tasks={filteredTasks} devices={devices} activeId={activeTaskId} onSelect={(id) => { setActiveTaskId(id); setSidebarOpen(false); }} /><div className="sidebar-bottom">{notice && <div className="remote-notice">{notice}</div>}<button className="project-switch" onClick={handleOpenProject}><span className="project-icon"><Folder weight="fill" /></span><span><small>当前项目</small><strong>{projectName}</strong></span><CaretDown /></button><div className="balance-preview"><Lightning weight="fill" /><span><small>KAI Token</small><strong>¥ {(session.account.balanceCents / 100).toFixed(2)}</strong></span><button onClick={handleTopup}>{capabilities?.payments.topupEnabled ? '充值' : '明细'}</button></div></div></aside>
    <main className="workspace"><header className="workspace-header"><div className="task-heading"><button className="mobile-only icon-button" title="打开任务栏" onClick={() => setSidebarOpen(true)}><SidebarSimple /></button><div><h1>{activeTask?.title ?? '新建或选择任务'}</h1><p>{project.root || 'Web 远程工作区'}</p></div></div><div className="header-actions">{activeTask && <span className={`header-status ${activeTask.status}`}>{statusLabels[activeTask.status]}</span>}<div className="mode-switch" aria-label="工作模式"><button className={mode === 'code' ? 'active' : ''} onClick={() => setMode('code')}><Code /> 代码</button><button className={mode === 'chat' ? 'active' : ''} onClick={() => setMode('chat')}><ChatCircleDots /> 对话</button></div><select className="model-picker" aria-label="模型" value={selectedModel} onChange={(event) => setSelectedModel(event.target.value)}>{session.models.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}</select></div></header>
      <section className="conversation"><div className="conversation-scroll">{!activeTask && <div className="empty-state"><div className="agent-avatar"><span>C</span></div><h2>从一个真实任务开始</h2><p>新建任务后，状态、目标设备和执行结果会同步保存。</p><button className="primary-button" onClick={() => setOverlay('new-task')}><Plus /> 新建任务</button></div>}{activeTask && !activeMessages.length && <div className="empty-state compact"><StatusGlyph status={activeTask.status} /><h2>{activeTask.title}</h2><p>任务已同步到 {devices.find((device) => device.id === activeTask.deviceId)?.name ?? '目标设备'}。输入内容开始执行。</p></div>}{activeMessages.map((message) => message.role === 'user' ? <article className="user-message" key={message.id}><p>{message.content}</p><small>{formatTime(message.createdAt)}</small></article> : <article className="agent-message" key={message.id}><div className="agent-avatar"><span>C</span></div><div><header><strong>COD Agent</strong>{message.mode === 'demo' && <span className="demo-chip">演示响应</span>}</header><p>{message.content}</p><small>{formatTime(message.createdAt)}</small></div></article>)}{isSending && <div className="agent-intro"><div className="agent-avatar"><span>C</span></div><div><strong>COD Agent</strong><small>{agentStatus}</small></div><span className="live-chip"><CircleNotch className="spin" /> running</span></div>}{pendingPermission && <div className="live-permission"><strong>{pendingPermission.title}</strong><p>Goose 请求执行权限，请确认本次操作。</p><div>{pendingPermission.options.map((option) => <button className={option.kind.startsWith('allow') ? 'approve' : ''} key={option.optionId} onClick={() => resolvePermission(option.optionId)}>{option.name}</button>)}<button onClick={() => resolvePermission(null)}>取消</button></div></div>}</div>
        <div className="composer-wrap">{activeTask && <div className="task-actions">{(activeTask.status === 'draft' || activeTask.status === 'failed' || activeTask.status === 'complete') && <button onClick={() => changeTaskStatus(activeTask, 'running').catch((error) => setNotice(error.message))}><Play /> {activeTask.status === 'failed' ? '重试任务' : activeTask.status === 'complete' ? '继续任务' : '开始任务'}</button>}{(activeTask.status === 'running' || activeTask.status === 'waiting') && <button onClick={() => changeTaskStatus(activeTask, 'complete').catch((error) => setNotice(error.message))}><Check /> 标记完成</button>}</div>}<div className="context-strip"><span><Folder weight="fill" /> {projectName}</span><span><GitDiff /> {changeCount} 个改动</span><span><ShieldCheck /> 受控模式</span><button onClick={handleKnowledge} disabled={knowledgeLoading}>{knowledgeLoading ? <CircleNotch className="spin" /> : <MagnifyingGlass />} 公司 Wiki</button><button onClick={handleRemoteTask}><PaperPlaneTilt /> 发送到设备</button></div>{notice && <div className="remote-notice"><span>{notice}</span><button title="关闭提示" onClick={() => setNotice('')}><X /></button></div>}{knowledgeHits.length > 0 && <div className="knowledge-strip">{knowledgeHits.map((hit) => <a href={hit.url} target="_blank" rel="noreferrer" key={hit.id}><strong>{hit.title}</strong><span>{hit.excerpt}</span></a>)}</div>}<div className="composer"><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) handleSend(); }} placeholder={mode === 'code' ? '让 COD 修改、检查或解释这个项目...' : '问 COD 任何问题...'} /><div className="composer-footer"><button className="composer-tool" title="查看项目文件" onClick={() => { if (hasDesktopBridge()) setInspectorTab('files'); else setNotice('项目文件仅在 COD Desktop 中可用。'); }}><Plus /></button><span>⌘ ↵ 发送</span><button className="send" title="发送" disabled={!prompt.trim() || isSending} onClick={handleSend}>{isSending ? <CircleNotch className="spin" /> : <PaperPlaneTilt weight="fill" />}</button></div></div></div></section>
    </main>
    <aside className="inspector"><div className="inspector-tabs"><button className={inspectorTab === 'changes' ? 'active' : ''} onClick={() => setInspectorTab('changes')}><GitDiff /> 改动</button><button className={inspectorTab === 'files' ? 'active' : ''} onClick={() => setInspectorTab('files')}><Folder /> 文件</button><button className={inspectorTab === 'terminal' ? 'active' : ''} onClick={() => setInspectorTab('terminal')}><TerminalWindow /> 终端</button></div><div className="inspector-body">{inspectorTab === 'changes' && <><div className="panel-title"><span><GitDiff /> 未提交改动</span><button title="刷新" onClick={refreshProject}><ArrowClockwise /></button></div>{project.root ? <CodeBlock text={project.diff || '当前项目没有未提交改动。'} /> : <div className="panel-empty">Web 端不伪造 Diff。请在 COD Desktop 中选择本机项目。</div>}</>}{inspectorTab === 'files' && <>{project.root ? <><div className="panel-title"><span><Folder /> 项目文件</span><small>{project.files.length}</small></div><FileTree files={project.files} selected={project.selectedFile} onSelect={handleFileSelect} />{project.selectedFile && <div className="file-preview"><strong>{project.selectedFile}</strong><CodeBlock text={project.selectedContent} /></div>}</> : <div className="panel-empty">本机文件仅在 COD Desktop 中可用。</div>}</>}{inspectorTab === 'terminal' && <>{window.codDesktop && project.root ? <><div className="panel-title"><span><TerminalWindow /> 本地终端</span><small>desktop</small></div><div className="terminal"><pre>{terminalOutput}</pre><div className="terminal-command"><span>$</span><input aria-label="终端命令" value={command} onChange={(event) => setCommand(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && handleRun()} /><button onClick={handleRun}>运行</button></div></div></> : <div className="panel-empty">Web 端不会执行或伪造终端结果。请使用 COD Desktop。</div>}</>}</div></aside>
    {overlay === 'new-task' && <Modal title="新建任务" onClose={() => setOverlay(null)}><form className="modal-form" onSubmit={handleCreateTask}><label>任务标题<input aria-label="任务标题" value={newTaskTitle} onChange={(event) => setNewTaskTitle(event.target.value)} placeholder="例如：审计登录流程" required autoFocus /></label><label>目标设备<select aria-label="目标设备" value={targetDeviceId} onChange={(event) => setTargetDeviceId(event.target.value)} required>{devices.map((device) => <option key={device.id} value={device.id}>{device.name} · {device.status}</option>)}</select></label><button className="primary-button" disabled={!newTaskTitle.trim() || !targetDeviceId}><Plus /> 创建并同步</button></form></Modal>}
    {overlay === 'account' && <Modal title="账户与服务状态" onClose={() => setOverlay(null)}><div className="account-panel"><div className="account-balance"><small>可用余额</small><strong>¥ {(session.account.balanceCents / 100).toFixed(2)}</strong><span>{session.account.displayName} · {session.account.plan}</span></div><div className="service-grid"><span>模型<strong className={capabilities?.ai.mode === 'live' ? 'live' : 'demo'}>{capabilities?.ai.mode === 'live' ? '已连接' : capabilities?.ai.mode === 'demo' ? '演示模式' : '不可用'}</strong></span><span>Wiki<strong className={capabilities?.knowledge.mode === 'live' ? 'live' : 'demo'}>{capabilities?.knowledge.mode === 'live' ? '已连接' : '演示数据'}</strong></span><span>支付<strong>{capabilities?.payments.topupEnabled ? '可用' : '未接入'}</strong></span><span>任务同步<strong className="live">已连接</strong></span></div><div className="ledger"><header><strong>最近流水</strong><button onClick={refreshWallet}><ArrowClockwise /> 刷新</button></header>{ledger.length ? ledger.map((entry) => <div key={entry.id}><span>{entry.type === 'usage' ? '模型用量' : '充值'}<small>{entry.reference} · {formatTime(entry.createdAt)}</small></span><strong className={entry.amountCents < 0 ? 'negative' : 'positive'}>{entry.amountCents > 0 ? '+' : ''}¥ {(entry.amountCents / 100).toFixed(2)}</strong></div>) : <p>暂无流水</p>}</div><button className="secondary-button" onClick={handleLogout}><SignOut /> 退出登录</button></div></Modal>}
    {overlay === 'commands' && <Modal title="命令面板" onClose={() => setOverlay(null)}><div className="command-list"><button onClick={() => { setOverlay('new-task'); }}><Plus /><span><strong>新建任务</strong><small>创建并同步到设备</small></span></button><button onClick={() => { setMode('code'); setOverlay(null); }}><Code /><span><strong>代码模式</strong><small>进入项目与 Agent 工作区</small></span></button><button onClick={() => { setMode('chat'); setOverlay(null); }}><ChatCircleDots /><span><strong>普通对话</strong><small>使用选定模型提问</small></span></button><button onClick={() => { setInspectorTab('terminal'); setOverlay(null); }}><TerminalWindow /><span><strong>打开终端</strong><small>{hasDesktopBridge() ? '运行受控本机命令' : '仅桌面端可用'}</small></span></button><button onClick={() => setOverlay('account')}><UserCircle /><span><strong>账户与服务状态</strong><small>余额、流水和接入状态</small></span></button></div></Modal>}
  </div>;
}
