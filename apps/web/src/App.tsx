import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import QRCode from 'qrcode';
import { ArrowClockwise } from '@phosphor-icons/react/ArrowClockwise';
import { ArrowSquareOut } from '@phosphor-icons/react/ArrowSquareOut';
import { Buildings } from '@phosphor-icons/react/Buildings';
import { CaretDown } from '@phosphor-icons/react/CaretDown';
import { ChatCircleDots } from '@phosphor-icons/react/ChatCircleDots';
import { Check } from '@phosphor-icons/react/Check';
import { CircleNotch } from '@phosphor-icons/react/CircleNotch';
import { Code } from '@phosphor-icons/react/Code';
import { Command } from '@phosphor-icons/react/Command';
import { CreditCard } from '@phosphor-icons/react/CreditCard';
import { File } from '@phosphor-icons/react/File';
import { Folder } from '@phosphor-icons/react/Folder';
import { GitDiff } from '@phosphor-icons/react/GitDiff';
import { Handshake } from '@phosphor-icons/react/Handshake';
import { HardDrives } from '@phosphor-icons/react/HardDrives';
import { Key } from '@phosphor-icons/react/Key';
import { Lightning } from '@phosphor-icons/react/Lightning';
import { ListChecks } from '@phosphor-icons/react/ListChecks';
import { MagnifyingGlass } from '@phosphor-icons/react/MagnifyingGlass';
import { Moon } from '@phosphor-icons/react/Moon';
import { PaperPlaneTilt } from '@phosphor-icons/react/PaperPlaneTilt';
import { Play } from '@phosphor-icons/react/Play';
import { Plus } from '@phosphor-icons/react/Plus';
import { ShieldCheck } from '@phosphor-icons/react/ShieldCheck';
import { SidebarSimple } from '@phosphor-icons/react/SidebarSimple';
import { SignOut } from '@phosphor-icons/react/SignOut';
import { Stack } from '@phosphor-icons/react/Stack';
import { Stop } from '@phosphor-icons/react/Stop';
import { Storefront } from '@phosphor-icons/react/Storefront';
import { Sun } from '@phosphor-icons/react/Sun';
import { TerminalWindow } from '@phosphor-icons/react/TerminalWindow';
import { UserCircle } from '@phosphor-icons/react/UserCircle';
import { Warning } from '@phosphor-icons/react/Warning';
import { X } from '@phosphor-icons/react/X';
import type { DeviceRecord, KnowledgeHit, ProductManifest, TaskStatus, WorkspaceFile } from '@cod/contracts';
import {
  cancelRemoteTask,
  createRemoteTask,
  createComputeRequest,
  createClientId,
  createPaymentOrder,
  getCapabilities,
  getCreditPacks,
  getPaymentOrder,
  getReferralSummary,
  getTaskExecutionLease,
  heartbeatDevice,
  listDevices,
  listComputeOffers,
  listComputeRequests,
  listLedger,
  listProducts,
  launchProduct,
  listModelCatalog,
  listTasks,
  loginCod,
  logoutCod,
  observeCodSessionInvalidated,
  refreshAccount,
  purchaseCreditPack,
  persistCodSession,
  registerDevice,
  registerCod,
  resumeCodSession,
  searchKnowledge,
  sendChat,
  topup,
  updateRemoteTask,
  type CapabilityReport,
  ApiError,
  type CodSession,
  type ComputeOffer,
  type ComputeRequest,
  type ComputeRequestInput,
  type CreditPackState,
  type LedgerEntry,
  type PaymentCheckout,
  type PaymentOrder,
  type PublicModelSourceInfo,
  type RemoteTask,
  type ReferralSummary,
} from './api';
import { hasDesktopBridge, loadProject, openProject, readProjectFile } from './desktop';
import { chatFailureMessage } from './chat-errors';
import { filterModelCatalog, groupModelCatalog } from './model-catalog';
import {
  permissionOptionLabel,
  permissionOptionsRequirePersistentWarning,
  persistentPermissionWarning,
  presentPermissionOptions,
  summarizePermissionToolCall,
  type PermissionToolSummary,
} from './permissions';
import { MarkdownContent } from './presentation';
import { copyCodText, getCodRuntime, observeCodTopmostUiClose, openCodExternalUrl } from './runtime';
import type { InspectorTab, ProjectSnapshot, WorkspaceMode } from './types';

const statusLabels: Record<TaskStatus, string> = {
  draft: '草稿', running: '运行中', waiting: '待确认', complete: '已完成', failed: '失败', cancelled: '已终止',
};
const emptyProject: ProjectSnapshot = { root: '', files: [], diff: '', selectedFile: null, selectedContent: '' };
type Overlay = 'login' | 'new-task' | 'account' | 'commands' | 'models' | 'compute' | null;
type AuthState = 'loading' | 'signed-out' | 'signed-in';
type ColorMode = 'light' | 'dark';
interface ComparisonResult { sourceId: string; sourceLabel: string; model: string; modelId?: string; content: string; inputTokens?: number; outputTokens?: number; durationMs: number; error?: string }
interface ChatMessage { id: string; role: 'user' | 'assistant' | 'comparison'; content: string; mode?: 'live' | 'demo'; sourceLabel?: string; model?: string; inputTokens?: number; outputTokens?: number; usageEstimated?: boolean; fallbackUsed?: boolean; failed?: boolean; cancelled?: boolean; retryPrompt?: string; comparisonResults?: ComparisonResult[]; selectedComparisonKey?: string; createdAt: string }
interface ActiveRun { taskId:string; controller:AbortController; cancelled:boolean; leaseAcquired:boolean; finalizing:boolean; terminalCommitted:boolean; mode:WorkspaceMode }
interface ComputeDraft {
  tab: ComputeRequestInput['kind']; offerId: string; company: string; contactName: string; contactPhone: string;
  city: string; gpuModel: string; quantity: number; durationHours: number; termMonths: number; requirements: string;
}

const initialComputeDraft: ComputeDraft = { tab: 'rental', offerId: '', company: '', contactName: '', contactPhone: '', city: '', gpuModel: 'NVIDIA H100 80GB', quantity: 1, durationHours: 100, termMonths: 24, requirements: '' };

function comparisonResultKey(result: ComparisonResult): string {
  return `${result.sourceId}::${result.modelId ?? result.model}`;
}

function sanitizeChatHistory(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter((message) => message.role === 'comparison' ? Boolean(message.comparisonResults?.length) : typeof message.content === 'string' && message.content.trim().length > 0);
}

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
function isTaskCancellation(error:unknown):boolean{
  return error instanceof ApiError&&error.code==='task_cancelled'||error instanceof DOMException&&error.name==='AbortError'||error instanceof Error&&error.name==='AbortError';
}
function devicePlatform(): DeviceRecord['platform'] {
  if (getCodRuntime().hostPlatform) return 'mobile';
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
  if (status === 'cancelled') return <Stop className="status-cancelled" weight="fill" />;
  if (status === 'complete') return <Check className="status-complete" weight="bold" />;
  return <ListChecks />;
}
function PermissionRequestSummary({ summary, showPersistentWarning }: { summary: PermissionToolSummary; showPersistentWarning: boolean }) {
  return <span className="permission-summary">
    <span className="permission-summary-title">{summary.title}</span>
    <span className="permission-summary-details">
      <span><b>工具类型</b><i>{summary.kindLabel}</i></span>
      {summary.command && <span><b>命令 / 参数</b><code>{summary.command}</code></span>}
      {summary.paths.length > 0 && <span><b>影响路径</b><i className="permission-paths">{summary.paths.map((path) => <code key={path}>{path}</code>)}</i></span>}
      <span><b>操作摘要</b><i>{summary.detail}</i></span>
    </span>
    {showPersistentWarning && <span className="permission-persistent-warning">{persistentPermissionWarning}</span>}
  </span>;
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
  const modalRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const modal = modalRef.current;
    if (!modal) return undefined;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusableElements = () => [...modal.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
      .filter((element) => !element.hasAttribute('disabled') && element.getAttribute('aria-hidden') !== 'true' && !element.closest('[hidden]'));
    if (!(document.activeElement instanceof Node) || !modal.contains(document.activeElement)) (focusableElements()[0] ?? modal).focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = focusableElements();
      if (!focusable.length) { event.preventDefault(); modal.focus(); return; }
      const first = focusable[0]!; const last = focusable[focusable.length - 1]!;
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !(active instanceof Node) || !modal.contains(active))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (active === last || !(active instanceof Node) || !modal.contains(active))) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [onClose]);
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section ref={modalRef} className={`modal${wide ? ' modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}><header><strong>{title}</strong><button className="icon-button" title="关闭" onClick={onClose}><X /></button></header>{children}</section></div>;
}

function LoginForm({ capabilities, capabilityError, resumeConversation, onLogin, onRegister }: { capabilities: CapabilityReport | null; capabilityError: string; resumeConversation: boolean; onLogin: (email: string, password: string) => Promise<void>; onRegister:(input:{email:string;password:string;inviteCode?:string;legacyAccessCode?:string})=>Promise<void> }) {
  const [mode,setMode]=useState<'login'|'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword,setConfirmPassword]=useState('');
  const [inviteCode,setInviteCode]=useState('');
  const [legacyAccessCode,setLegacyAccessCode]=useState('');
  const [showLegacyMigration,setShowLegacyMigration]=useState(false);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const registrationAvailable=capabilities?.authentication.registrationEnabled===true;
  const legacyMigrationAvailable=!registrationAvailable&&capabilities?.authentication.legacyMigrationEnabled===true;
  const enrollmentAvailable=registrationAvailable||legacyMigrationAvailable;
  const migrationMode=mode==='register'&&legacyMigrationAvailable;
  const inviteRequired=capabilities?.authentication.inviteCodeRequired===true;
  useEffect(()=>{if(!enrollmentAvailable&&mode==='register'){setMode('login');setPassword('');setConfirmPassword('');setLegacyAccessCode('');}},[enrollmentAvailable,mode]);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setSubmitting(true); setError('');
    try {
      if(mode==='login')await onLogin(email,password);
      else{
        if(!enrollmentAvailable)throw new Error('当前暂未开放账号注册或迁移');
        if(password!==confirmPassword)throw new Error('两次输入的密码不一致');
        await onRegister({email,password,inviteCode:registrationAvailable?inviteCode.trim()||undefined:undefined,legacyAccessCode:migrationMode||showLegacyMigration?legacyAccessCode||undefined:undefined});
      }
    } catch (nextError) {
      if(nextError instanceof ApiError&&nextError.code==='legacy_migration_required')setShowLegacyMigration(true);
      setError(nextError instanceof Error ? nextError.message : mode==='login'?'登录失败':'注册失败');
    } finally { setSubmitting(false); }
  };
  const switchMode=(next:'login'|'register')=>{setMode(next);setPassword('');setConfirmPassword('');setError('');setShowLegacyMigration(false);setLegacyAccessCode('');};
  const actionName=mode==='login'?'登录':migrationMode?'迁移':'注册';
  return <div className="login-form">
    <div className={`auth-tabs${enrollmentAvailable?'':' single'}`} role="tablist">
      <button type="button" role="tab" aria-selected={mode==='login'} className={mode==='login'?'active':''} onClick={()=>switchMode('login')}>密码登录</button>
      {enrollmentAvailable&&<button type="button" role="tab" aria-selected={mode==='register'} className={mode==='register'?'active':''} onClick={()=>switchMode('register')}>{migrationMode?'旧账号迁移':legacyMigrationAvailable?'旧账号迁移':'注册账号'}</button>}
    </div>
    <div className="login-copy">
      <span className="eyebrow">KAI ACCOUNT</span>
      <h2>{resumeConversation?`${actionName}后继续对话`:mode==='login'?'登录 COD':migrationMode?'迁移旧账号':'注册 COD'}</h2>
      <p>{resumeConversation?'登录窗口保持打开期间会保留这条消息；认证成功后会自动发送。':mode==='login'?(registrationAvailable?'使用邮箱和密码登录。':legacyMigrationAvailable?'已有账号可直接登录；旧试点账号可完成一次性迁移。':'当前仅开放已有账号登录。'):migrationMode?'使用旧试点访问码为原账号设置新密码；迁移仅可完成一次。':`注册即获 ¥10 试用金，有效期 30 天。${inviteRequired?'需要有效邀请码。':'邀请码选填，用于绑定邀请人与后续返佣。'}`}</p>
    </div>
    {capabilityError&&<div className="notice error">{capabilityError}</div>}
    <form onSubmit={submit}>
      <label>邮箱<input aria-label="邮箱" name="email" type="email" value={email} onChange={(event)=>setEmail(event.target.value)} autoComplete="username" required autoFocus /></label>
      <label>密码<input key={`password-${mode}`} aria-label="密码" name={mode==='login'?'loginPassword':'newPassword'} type="password" value={password} onChange={(event)=>setPassword(event.target.value)} autoComplete={mode==='login'?'current-password':'new-password'} minLength={10} maxLength={128} required /></label>
      {mode==='register'&&<>
        <label>确认密码<input key="confirm-register-password" aria-label="确认密码" name="confirmPassword" type="password" value={confirmPassword} onChange={(event)=>setConfirmPassword(event.target.value)} autoComplete="new-password" minLength={10} maxLength={128} required /></label>
        {registrationAvailable&&<label>邀请码 <small>{inviteRequired?'必填':'选填'}</small><input aria-label="邀请码" name="inviteCode" value={inviteCode} onChange={(event)=>setInviteCode(event.target.value.toUpperCase())} autoComplete="off" maxLength={32} placeholder="例如 KAI-XXXXXXXXXX" required={inviteRequired} /></label>}
        {(migrationMode||showLegacyMigration)&&<label>旧试点访问码 <small>仅迁移一次</small><input key="legacy-access-code" aria-label="旧试点访问码" name="legacyAccessCode" type="password" value={legacyAccessCode} onChange={(event)=>setLegacyAccessCode(event.target.value)} autoComplete="off" maxLength={256} required /></label>}
        <p className="password-hint">密码须为 10-128 位，并同时包含字母和数字。{migrationMode?'迁移成功后请使用新密码登录。':'邀请关系注册后不可自行更改。'}</p>
      </>}
      {error&&<div className="notice error" role="alert">{error}</div>}
      <button type="submit" className="primary-button" disabled={submitting}>{submitting?<CircleNotch className="spin" />:<Key />} {resumeConversation?`${actionName}并继续`:mode==='login'?'登录':migrationMode?'迁移旧账号':'注册并领取试用金'}</button>
    </form>
    <div className="capability-summary"><span className={capabilities?.ai.mode==='live'?'live':'demo'}>模型：{capabilities?.ai.mode==='live'?'已连接':capabilities?.ai.mode==='demo'?'演示模式':'待检测'}</span><span>认证：邮箱密码</span></div>
  </div>;
}

function ModelLibrary({ sources, error, signedIn, onLogin }: { sources: PublicModelSourceInfo[]; error: string; signedIn: boolean; onLogin: () => void }) {
  const [query, setQuery] = useState('');
  const groupedModels = useMemo(() => groupModelCatalog(sources), [sources]);
  const visibleModels = useMemo(() => filterModelCatalog(groupedModels, query), [groupedModels, query]);
  const availableModels = groupedModels.filter((group) => group.callable).length;
  const availableSources = sources.filter((source) => source.callable).length;
  const price = (cents: number) => `¥ ${(cents / 100).toFixed(2)}`;
  return <div className="model-library">
    <div className="model-library-intro"><div><span className="eyebrow">MODEL CATALOG</span><h2>模型与参考价格</h2><p>所有价格均为人民币，每百万 Token 计价。相同模型与价格合并展示，来源仍可搜索。</p></div><div className="model-library-summary"><span><small>可用模型</small><strong>{availableModels}</strong></span><span><small>价格条目</small><strong>{groupedModels.length}</strong></span><span><small>服务来源</small><strong>{sources.length}</strong></span></div></div>
    <label className="model-search"><MagnifyingGlass /><input aria-label="搜索模型" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索模型或模型源" /></label>
    {error && <div className="notice error">{error}</div>}
    {!error && !sources.length && <div className="model-library-empty"><CircleNotch className="spin" /> 正在读取模型目录…</div>}
    {sources.length > 0 && !visibleModels.length && <div className="model-library-empty">没有匹配的模型</div>}
    {visibleModels.length > 0 && <div className="model-source-list"><section className="model-source-card"><header><div><strong>统一价格目录</strong><small>{sources.length} 个服务来源；重复模型已合并，价格差异会保留为独立条目。</small></div><span className={availableSources ? 'available' : 'unavailable'}>{availableSources ? `${availableSources} 个来源可用` : '暂不可用'}</span></header><div className="model-table" role="table" aria-label="COD 模型价格"><div className="model-row model-table-head" role="row"><span role="columnheader">模型</span><span role="columnheader">上下文</span><span role="columnheader">输入 / 百万</span><span role="columnheader">输出 / 百万</span><span role="columnheader">可用来源</span></div>{visibleModels.map((group) => { const callableSources = group.sources.filter((source) => source.callable); const sourcePreview = callableSources.slice(0, 2).map((source) => source.label).join(' / '); return <div className="model-row" role="row" key={group.key}><span role="cell"><strong>{group.model.label}</strong><small>{group.model.id}</small></span><span role="cell">{group.model.contextWindow > 0 ? group.model.contextWindow.toLocaleString('zh-CN') : '暂无'}</span><span role="cell" className="model-price">{price(group.model.inputPricePerMillionCents)}</span><span role="cell" className="model-price">{price(group.model.outputPricePerMillionCents)}</span><span role="cell"><i className={group.callable ? 'available' : 'unavailable'}>{group.callable ? '可调用' : '仅参考'}</i>{sourcePreview && <small className="source-preview">{callableSources.length} 个来源 · {sourcePreview}{callableSources.length > 2 ? ' 等' : ''}</small>}</span></div>; })}</div></section></div>}
    <footer className="model-library-footer"><p>当前所有展示来源统一由 ai.kai.com 实际调用；来源用于界面选择和业务归因。价格按实际 Token 用量结算。</p>{!signedIn && <button className="primary-button" onClick={onLogin}><Key /> 登录后使用模型</button>}</footer>
  </div>;
}

function ComputeMarket({ offers, requests, signedIn, draft, onDraftChange, onLogin, onSubmit }: { offers: ComputeOffer[]; requests: ComputeRequest[]; signedIn: boolean; draft: ComputeDraft; onDraftChange: (draft: ComputeDraft) => void; onLogin: () => void; onSubmit: (input: ComputeRequestInput) => Promise<void> }) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const { tab, offerId, company, contactName, contactPhone, city, gpuModel, quantity, durationHours, termMonths, requirements } = draft;
  const updateDraft = (next: Partial<ComputeDraft>) => onDraftChange({ ...draft, ...next });
  const selectedOffer = offers.find((offer) => offer.id === offerId) ?? offers[0];
  const unitLabel: Record<ComputeOffer['priceUnit'], string> = { 'card-hour': '卡时', 'server-hour': '整机时', month: '月', quote: '询价' };
  const statusLabel: Record<ComputeRequest['status'], string> = { submitted: '已提交', contacting: '联系中', quoted: '已报价', closed: '已关闭' };
  const chooseOffer = (offer: ComputeOffer) => updateDraft({ tab: 'rental', offerId: offer.id, gpuModel: offer.gpuModel, quantity: offer.gpuCount, durationHours: offer.minimumUnits });
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!signedIn) { onLogin(); return; }
    setSubmitting(true); setError('');
    try {
      await onSubmit({ kind: tab, offerId: tab === 'rental' ? selectedOffer?.id ?? null : null, company, contactName, contactPhone, city, gpuModel, quantity, durationHours: tab === 'rental' ? durationHours : null, termMonths: tab === 'installment' ? termMonths : null, requirements });
      updateDraft({ requirements: '' });
    } catch (nextError) { setError(nextError instanceof Error ? nextError.message : '提交失败，请稍后重试'); }
    finally { setSubmitting(false); }
  };
  return <div className="compute-market">
    <section className="compute-hero"><div><span className="eyebrow">COD COMPUTE EXCHANGE</span><h2>把 GPU 变成可交易的卡时</h2><p>机房直供 H100，同时开放闲置算力上架、企业求购和显卡分期申请。首版由人工核验库存、网络与交付窗口，确认后报价成交。</p></div><div className="compute-hero-metrics"><span><strong>H100</strong><small>机房直供</small></span><span><strong>卡时</strong><small>按需起租</small></span><span><strong>SLA</strong><small>成交前确认</small></span></div></section>
    <div className="compute-offers">{offers.map((offer) => <article className={selectedOffer?.id === offer.id && tab === 'rental' ? 'selected' : ''} key={offer.id}><header><span className={offer.availability}>{offer.availability === 'ready' ? '可预约' : offer.availability === 'limited' ? '库存紧张' : '企业询价'}</span>{offer.verified && <i><ShieldCheck weight="fill" /> 已核验</i>}</header><HardDrives weight="duotone" /><h3>{offer.title}</h3><p>{offer.gpuModel} · {offer.gpuCount} 卡 · {offer.gpuMemoryGb}GB/卡</p><strong>{offer.priceCents === null ? '企业询价' : `¥${(offer.priceCents / 100).toFixed(2)}`}<small>{offer.priceCents === null ? '' : ` / ${unitLabel[offer.priceUnit]}起`}</small></strong><dl><div><dt>区域</dt><dd>{offer.region}</dd></div><div><dt>交付</dt><dd>{offer.delivery}</dd></div><div><dt>网络</dt><dd>{offer.network}</dd></div></dl><footer>{offer.tags.map((tag) => <span key={tag}>{tag}</span>)}</footer><button type="button" onClick={() => chooseOffer(offer)}>预约锁卡</button></article>)}</div>
    <section className="compute-deal"><nav aria-label="算力业务类型"><button type="button" className={tab === 'rental' ? 'active' : ''} onClick={() => updateDraft({ tab: 'rental' })}><HardDrives />租算力</button><button type="button" className={tab === 'supply' ? 'active' : ''} onClick={() => updateDraft({ tab: 'supply' })}><Storefront />上架闲置卡</button><button type="button" className={tab === 'installment' ? 'active' : ''} onClick={() => updateDraft({ tab: 'installment' })}><CreditCard />显卡分期</button></nav><form onSubmit={submit} noValidate={!signedIn}>
      <div className="compute-form-head"><div>{tab === 'rental' ? <HardDrives /> : tab === 'supply' ? <Buildings /> : <Handshake />}</div><span><strong>{tab === 'rental' ? '提交租赁需求' : tab === 'supply' ? '成为算力供方' : '申请设备融资方案'}</strong><small>{tab === 'rental' ? '确认库存与交付环境后出具正式报价' : tab === 'supply' ? '机房、卡况、网络与产权核验通过后上架' : 'COD 仅撮合申请，不自行授信或放款'}</small></span></div>
      {tab === 'rental' && <label className="compute-wide">算力商品<select aria-label="算力商品" value={selectedOffer?.id ?? ''} onChange={(event) => { const offer = offers.find((item) => item.id === event.target.value); if (offer) chooseOffer(offer); }}>{offers.map((offer) => <option key={offer.id} value={offer.id}>{offer.title} · {offer.priceCents === null ? '询价' : `¥${(offer.priceCents / 100).toFixed(2)}/${unitLabel[offer.priceUnit]}`}</option>)}</select></label>}
      <label>企业 / 团队<input aria-label="企业或团队" value={company} onChange={(event) => updateDraft({ company: event.target.value })} required minLength={2} maxLength={120} placeholder="公司或团队名称" /></label><label>联系人<input aria-label="联系人" value={contactName} onChange={(event) => updateDraft({ contactName: event.target.value })} required maxLength={60} /></label><label>手机 / 微信<input aria-label="手机或微信" value={contactPhone} onChange={(event) => updateDraft({ contactPhone: event.target.value })} required pattern="[A-Za-z0-9_+()\-\s]{5,40}" placeholder="手机号或微信号" /></label><label>所在城市<input aria-label="所在城市" value={city} onChange={(event) => updateDraft({ city: event.target.value })} required maxLength={80} /></label>
      <label>GPU 型号<input aria-label="GPU 型号" value={gpuModel} onChange={(event) => updateDraft({ gpuModel: event.target.value })} required maxLength={100} /></label><label>卡数<input aria-label="卡数" type="number" min={1} max={4096} value={quantity} onChange={(event) => updateDraft({ quantity: Number(event.target.value) })} required /></label>{tab === 'rental' && <label>预计卡时<input aria-label="预计卡时" type="number" min={1} max={1000000} value={durationHours} onChange={(event) => updateDraft({ durationHours: Number(event.target.value) })} required /></label>}{tab === 'installment' && <label>期数<select aria-label="分期期数" value={termMonths} onChange={(event) => updateDraft({ termMonths: Number(event.target.value) })}><option value={12}>12 个月</option><option value={24}>24 个月</option><option value={36}>36 个月</option></select></label>}
      <label className="compute-wide">需求说明<textarea aria-label="需求说明" value={requirements} onChange={(event) => updateDraft({ requirements: event.target.value })} maxLength={2000} placeholder={tab === 'rental' ? '训练框架、镜像、存储、带宽、开始时间…' : tab === 'supply' ? '机房位置、卡况、服务器配置、可售时段…' : '设备配置、预算、首付能力、发票与交付要求…'} /></label>
      {tab === 'installment' && <div className="compute-compliance compute-wide"><ShieldCheck /> 融资租赁申请将由具备相应资质的合作机构独立审核并签署书面合同；提交申请不代表授信通过。</div>}{error && <div className="notice error compute-wide">{error}</div>}{signedIn ? <button type="submit" className="primary-button compute-wide" disabled={submitting}>{submitting ? <CircleNotch className="spin" /> : <PaperPlaneTilt weight="fill" />}提交并等待报价</button> : <button type="button" className="primary-button compute-wide" onClick={onLogin}><Key /> 登录后提交需求</button>}
    </form></section>
    {requests.length > 0 && <section className="compute-requests"><header><strong>我的需求</strong><small>商务确认后状态会更新</small></header>{requests.map((request) => <div key={request.id}><span><strong>{request.kind === 'rental' ? '算力租赁' : request.kind === 'supply' ? '供方上架' : '显卡分期'} · {request.gpuModel}</strong><small>{request.quantity} 卡{request.durationHours ? ` · ${request.durationHours} 卡时` : ''}{request.termMonths ? ` · ${request.termMonths} 个月` : ''} · {formatTime(request.createdAt)}</small></span><i className={request.status}>{statusLabel[request.status]}</i></div>)}</section>}
  </div>;
}

export function App() {
  const [colorMode, setColorMode] = useState<ColorMode>(initialColorMode);
  const [authState, setAuthState] = useState<AuthState>('loading');
  const [capabilities, setCapabilities] = useState<CapabilityReport | null>(null);
  const [capabilityError, setCapabilityError] = useState('');
  const [modelCatalog, setModelCatalog] = useState<PublicModelSourceInfo[]>([]);
  const [modelCatalogError, setModelCatalogError] = useState('');
  const [session, setSession] = useState<CodSession | null>(null);
  const [tasks, setTasks] = useState<RemoteTask[]>([]);
  const [devices, setDevices] = useState<DeviceRecord[]>([]);
  const [currentDeviceId, setCurrentDeviceId] = useState('');
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [creditPacks, setCreditPacks] = useState<CreditPackState>({ packs: [], summary: { availableCents: 0, grants: [] } });
  const [referralSummary, setReferralSummary] = useState<ReferralSummary | null>(null);
  const [purchasingPackId, setPurchasingPackId] = useState('');
  const [paymentAmountCents, setPaymentAmountCents] = useState(5000);
  const [paymentBusy, setPaymentBusy] = useState(false);
  const [paymentOrder, setPaymentOrder] = useState<PaymentOrder | null>(null);
  const [paymentCheckout, setPaymentCheckout] = useState<(PaymentCheckout & { qrDataUrl?: string }) | null>(null);
  const [compareEnabled, setCompareEnabled] = useState(false);
  const [compareModelKeys, setCompareModelKeys] = useState<string[]>([]);
  const [products, setProducts] = useState<ProductManifest[]>([]);
  const [computeOffers, setComputeOffers] = useState<ComputeOffer[]>([]);
  const [computeRequests, setComputeRequests] = useState<ComputeRequest[]>([]);
  const [computeDraft, setComputeDraft] = useState<ComputeDraft>(initialComputeDraft);
  const [resumeComputeAfterLogin, setResumeComputeAfterLogin] = useState(false);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [targetDeviceId, setTargetDeviceId] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [mode, setMode] = useState<WorkspaceMode>(() => hasDesktopBridge() ? 'code' : 'chat');
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
  const [mobileContextExpanded, setMobileContextExpanded] = useState(false);
  const [notice, setNotice] = useState('');
  const [messagesByTask, setMessagesByTask] = useState<Record<string, ChatMessage[]>>({});
  const [pendingSend, setPendingSend] = useState<{ prompt: string; mode: WorkspaceMode } | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [cancellingTaskId,setCancellingTaskId]=useState('');
  const [agentStatus, setAgentStatus] = useState('就绪');
  const [pendingPermission, setPendingPermission] = useState<{ summary: PermissionToolSummary; options: Array<{ optionId: string; name: string; kind: string }> } | null>(null);
  const [project, setProject] = useState<ProjectSnapshot>(emptyProject);
  const permissionResolver = useRef<((optionId: string | null) => void) | null>(null);
  const pendingSendRunner = useRef<(prompt: string, mode: WorkspaceMode) => void>(() => undefined);
  const activeRunRef=useRef<ActiveRun|null>(null);
  const sendingRef=useRef(false);
  const authGenerationRef=useRef(0);
  const sessionToken = session?.token ?? null;
  const sessionTokenRef=useRef<string|null>(sessionToken);
  sessionTokenRef.current=sessionToken;
  const pendingPaymentOrderId = paymentOrder?.status === 'pending' ? paymentOrder.id : null;

  const clearAuthenticatedUi = useCallback((message = '') => {
    authGenerationRef.current += 1;
    const run=activeRunRef.current;
    if(run){run.cancelled=true;run.controller.abort(new DOMException('Signed out','AbortError'));}
    activeRunRef.current=null;sendingRef.current=false;sessionTokenRef.current=null;
    permissionResolver.current?.(null);permissionResolver.current=null;
    void window.codDesktop?.stopGoose();
    setSession(null);setTasks([]);setDevices([]);setLedger([]);setCreditPacks({ packs: [], summary: { availableCents: 0, grants: [] } });setComputeRequests([]);setReferralSummary(null);setKnowledgeHits([]);setKnowledgeLoading(false);setPaymentOrder(null);setPaymentCheckout(null);setPaymentBusy(false);setCurrentDeviceId('');setTargetDeviceId('');setActiveTaskId(null);setMessagesByTask({});setPrompt('');setPendingSend(null);setResumeComputeAfterLogin(false);setPendingPermission(null);setIsSending(false);setAgentStatus('就绪');setNotice(message);setOverlay(null);setAuthState('signed-out');
  }, []);

  const closeTopmostUi = useCallback(() => {
    if (overlay !== null) {
      if (overlay === 'login') {
        authGenerationRef.current += 1;
        setPendingSend(null);
        setResumeComputeAfterLogin(false);
      }
      setOverlay(null);
      return;
    }
    if (sidebarOpen) setSidebarOpen(false);
  }, [overlay, sidebarOpen]);

  useEffect(() => observeCodTopmostUiClose(closeTopmostUi), [closeTopmostUi]);

  useEffect(() => observeCodSessionInvalidated((expectedToken) => {
    if (sessionTokenRef.current !== expectedToken) return;
    clearAuthenticatedUi('登录已过期，请重新登录。');
  }), [clearAuthenticatedUi]);

  useEffect(() => {
    void getCodRuntime().setNativeTopmostUiVisible?.(overlay !== null || sidebarOpen);
  }, [overlay, sidebarOpen]);

  useEffect(() => {
    document.documentElement.dataset.colorMode = colorMode;
    document.documentElement.style.colorScheme = colorMode;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', colorMode === 'dark' ? '#0b1416' : '#fbfdfd');
    storageSet('kai.color-mode.v1', colorMode);
    void getCodRuntime().setNativeColorMode?.(colorMode);
  }, [colorMode]);

  useEffect(() => { listComputeOffers().then(setComputeOffers).catch(() => setComputeOffers([])); }, []);

  useEffect(() => {
    if (!sessionToken) { setComputeRequests([]); return; }
    const token=sessionToken;
    let stopped=false;
    listComputeRequests(token).then((requests)=>{if(!stopped)setComputeRequests(requests);}).catch(()=>{if(!stopped)setComputeRequests([]);});
    return()=>{stopped=true;};
  }, [sessionToken]);

  useEffect(() => {
    if (!sessionToken) { setReferralSummary(null); return; }
    const token=sessionToken;
    let stopped=false;
    getReferralSummary(token).then((summary)=>{if(!stopped)setReferralSummary(summary);}).catch(()=>{if(!stopped)setReferralSummary(null);});
    return()=>{stopped=true;};
  }, [sessionToken]);

  const activeTask = useMemo(() => tasks.find((task) => task.id === activeTaskId) ?? null, [tasks, activeTaskId]);
  const selectedSource = session?.sources.find((source) => source.id === selectedSourceId) ?? session?.sources[0] ?? null;
  const sourceModels = selectedSource?.models ?? [];
  const selectedModelInfo = sourceModels.find((model) => model.id === selectedModel) ?? sourceModels[0] ?? null;
  const callableModels = useMemo(() => session?.sources.flatMap((source) => source.callable ? source.models.map((model) => ({ key: `${source.id}::${model.id}`, sourceId: source.id, sourceLabel: source.label, model })) : []) ?? [], [session]);
  const compareTargets = callableModels.filter((target) => compareModelKeys.includes(target.key));
  const onlineDesktopDevices = useMemo(() => devices.filter((device) => device.status === 'online' && !['web', 'mobile'].includes(device.platform)), [devices]);
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

  const loadWorkspace = async (nextSession: CodSession, authGeneration:number) => {
    const assertCurrentAuth=()=>{if(authGenerationRef.current!==authGeneration)throw new DOMException('Authentication attempt superseded','AbortError');};
    assertCurrentAuth();
    const [devicesResult, tasksResult, productsResult, ledgerResult, creditPacksResult] = await Promise.allSettled([listDevices(nextSession.token), listTasks(nextSession.token), listProducts(nextSession.token), listLedger(nextSession.token), getCreditPacks(nextSession.token)]);
    assertCurrentAuth();
    if (devicesResult.status === 'rejected') throw devicesResult.reason;
    if (tasksResult.status === 'rejected') throw tasksResult.reason;
    const initialDevices = devicesResult.value;
    const nextTasks = tasksResult.value;
    let nextDevices = initialDevices;
    const storedDeviceId = storageGet('cod.device.id');
    let currentDevice = nextDevices.find((device) => device.id === storedDeviceId);
    if (!currentDevice) {
      const platform = devicePlatform();
      currentDevice = await registerDevice(nextSession.token, hasDesktopBridge() ? `COD Desktop (${platform})` : `COD ${platform === 'mobile' ? 'Mobile' : 'Web'}`, platform);
      assertCurrentAuth();
      storageSet('cod.device.id', currentDevice.id);
      nextDevices = [...nextDevices, currentDevice];
    } else {
      currentDevice = await heartbeatDevice(nextSession.token, currentDevice.id);
      assertCurrentAuth();
      nextDevices = nextDevices.map((device) => device.id === currentDevice!.id ? currentDevice! : device);
    }
    assertCurrentAuth();
    setModelCatalog(nextSession.sources);
    setModelCatalogError('');
    setDevices(nextDevices); setTasks(nextTasks);
    setProducts(productsResult.status === 'fulfilled' ? productsResult.value : []);
    setLedger(ledgerResult.status === 'fulfilled' ? ledgerResult.value : []);
    setCreditPacks(creditPacksResult.status === 'fulfilled' ? creditPacksResult.value : { packs: [], summary: { availableCents: 0, grants: [] } });
    const degradedServices = [productsResult.status === 'rejected' ? '产品入口' : '', ledgerResult.status === 'rejected' ? '账单' : '', creditPacksResult.status === 'rejected' ? '额度包' : ''].filter(Boolean);
    if (degradedServices.length) setNotice(`已登录；${degradedServices.join('、')}暂未加载，可稍后刷新。`);
    setCurrentDeviceId(currentDevice.id);
    setTargetDeviceId((current) => nextDevices.some((device) => device.id === current && device.status === 'online' && !['web', 'mobile'].includes(device.platform)) ? current : nextDevices.find((device) => device.status === 'online' && !['web', 'mobile'].includes(device.platform))?.id ?? '');
    setActiveTaskId((current) => current && nextTasks.some((task) => task.id === current) ? current : nextTasks[0]?.id ?? null);
    const storedSourceId = storageGet('cod.model.source');
    const nextSource = nextSession.sources.find((source) => source.id === storedSourceId) ?? nextSession.sources.find((source) => source.callable) ?? nextSession.sources[0];
    setSelectedSourceId(nextSource?.id ?? 'demo');
    const storedModel = nextSource ? storageGet(`cod.model.${nextSource.id}`) : null;
    setSelectedModel(nextSource?.models.find((model) => model.id === storedModel)?.id ?? nextSource?.models[0]?.id ?? 'coder-pro');
    setCompareModelKeys((current) => {
      const valid=current.filter((key)=>nextSession.sources.some((source)=>source.callable&&source.models.some((model)=>`${source.id}::${model.id}`===key)));
      return valid.length>=2?valid:nextSession.sources.flatMap((source)=>source.callable?source.models.map((model)=>`${source.id}::${model.id}`):[]).slice(0,2);
    });
  };

  useEffect(() => {
    let mounted = true;
    const authGeneration=++authGenerationRef.current;
    Promise.allSettled([getCapabilities(), listModelCatalog(), resumeCodSession()]).then(async ([capabilityResult, catalogResult, sessionResult]) => {
      if (!mounted||authGenerationRef.current!==authGeneration) return;
      if (capabilityResult.status === 'fulfilled') setCapabilities(capabilityResult.value); else setCapabilityError('控制平面暂不可达，请检查网络或服务状态。');
      if (catalogResult.status === 'fulfilled') setModelCatalog(catalogResult.value); else setModelCatalogError('模型目录暂不可用，请稍后重试。');
      const nextSession = sessionResult.status === 'fulfilled' ? sessionResult.value : null;
      if (!nextSession) { setAuthState('signed-out'); return; }
      try { await loadWorkspace(nextSession,authGeneration); if (mounted&&authGenerationRef.current===authGeneration) { sessionTokenRef.current=nextSession.token; setSession(nextSession); setAuthState('signed-in'); setOverlay(null); } }
      catch { if (mounted&&authGenerationRef.current===authGeneration) { await logoutCod(nextSession.token).catch(() => false); setAuthState('signed-out'); } }
    });
    return () => { mounted = false; if(authGenerationRef.current===authGeneration)authGenerationRef.current+=1; };
  }, []);

  useEffect(() => {
    if (!activeTaskId || messagesByTask[activeTaskId]) return;
    const raw = storageGet(`cod.messages.${activeTaskId}`);
    if (!raw) { setMessagesByTask((current) => ({ ...current, [activeTaskId]: [] })); return; }
    try {
      const parsed = JSON.parse(raw) as ChatMessage[];
      const sanitized = Array.isArray(parsed) ? sanitizeChatHistory(parsed) : [];
      if (sanitized.length !== parsed.length) storageSet(`cod.messages.${activeTaskId}`, JSON.stringify(sanitized));
      setMessagesByTask((current) => ({ ...current, [activeTaskId]: sanitized }));
    }
    catch { setMessagesByTask((current) => ({ ...current, [activeTaskId]: [] })); }
  }, [activeTaskId, messagesByTask]);

  useEffect(() => {
    if (!sessionToken) return;
    const token = sessionToken;
    let stopped=false;
    const sync = async () => {
      if (!hasDesktopBridge() && document.visibilityState === 'hidden' && !activeRunRef.current?.leaseAcquired) return;
      try {
        const currentDeviceId = storageGet('cod.device.id');const activeRun=activeRunRef.current;
        if(currentDeviceId&&!stopped){try{await heartbeatDevice(token,currentDeviceId,activeRun?.leaseAcquired?activeRun.taskId:undefined);}catch(error){if(activeRun?.leaseAcquired&&error instanceof ApiError&&['task_lease_expired','task_lease_required','invalid_task_lease'].includes(error.code)&&!activeRun.cancelled&&!activeRun.finalizing&&!activeRun.terminalCommitted){activeRun.cancelled=true;activeRun.controller.abort(new DOMException('Task execution lease expired','AbortError'));setNotice('任务执行租约已失效，本机 Agent 已停止。请检查项目状态后重新执行。');if(hasDesktopBridge())void window.codDesktop?.stopGoose();}}}
        const [tasksResult, devicesResult, accountResult, creditPacksResult] = await Promise.allSettled([
          listTasks(token), listDevices(token), refreshAccount(token), getCreditPacks(token),
        ]);
        if(stopped||sessionTokenRef.current!==token)return;
        if(tasksResult.status==='fulfilled')setTasks(tasksResult.value);
        if(devicesResult.status==='fulfilled')setDevices(devicesResult.value);
        if(creditPacksResult.status==='fulfilled')setCreditPacks(creditPacksResult.value);
        if(accountResult.status==='fulfilled')setSession((current) => current?.token === token ? { ...current, account:accountResult.value } : current);
      } catch { /* Keep the last synchronized snapshot and retry. */ }
    };
    const interval = window.setInterval(sync, 15_000);
    const syncWhenVisible=()=>{if(document.visibilityState==='visible')void sync();};
    document.addEventListener('visibilitychange',syncWhenVisible);
    return () => { stopped=true; window.clearInterval(interval); document.removeEventListener('visibilitychange',syncWhenVisible); };
  }, [sessionToken]);

  useEffect(() => {
    if (!sessionToken || !pendingPaymentOrderId) return;
    const token = sessionToken;
    const orderId = pendingPaymentOrderId;
    let stopped = false;
    const poll = async () => {
      try {
        const next = await getPaymentOrder(token, orderId);
        if (stopped) return;
        setPaymentOrder(next);
        if (next.status === 'paid') {
          const [account, nextLedger, nextCreditPacks] = await Promise.all([refreshAccount(token), listLedger(token), getCreditPacks(token)]);
          if (stopped) return;
          setSession((current) => current?.token === token ? { ...current, account } : current);
          setLedger(nextLedger); setCreditPacks(nextCreditPacks); setNotice('充值已到账，所有登录设备会自动同步最新额度。');
        }
      } catch { /* Provider callbacks can take a few seconds; keep polling. */ }
    };
    const interval = window.setInterval(() => void poll(), 2_000);
    void poll();
    return () => { stopped = true; window.clearInterval(interval); };
  }, [pendingPaymentOrderId, sessionToken]);

  useEffect(()=>{
    const run=activeRunRef.current;if(!run||run.cancelled)return;
    const task=tasks.find((item)=>item.id===run.taskId);if(task?.status!=='cancelled'&&task?.status!=='failed')return;
    run.cancelled=true;run.controller.abort(new DOMException('Task cancelled','AbortError'));
    permissionResolver.current?.(null);permissionResolver.current=null;setPendingPermission(null);setAgentStatus('已终止');
    if(hasDesktopBridge())void window.codDesktop?.stopGoose();
  },[tasks]);

  useEffect(() => {
    if (!hasDesktopBridge()) return;
    const recentRoot = storageGet('cod.project.root');
    if (recentRoot) loadProject(recentRoot).then((snapshot) => snapshot && setProject(snapshot)).catch(() => storageSet('cod.project.root', ''));
  }, []);

  const establishAuthenticatedSession = async (nextSession: CodSession, authGeneration: number, nextOverlay: Overlay) => {
    const assertCurrentAuth=()=>{if(authGenerationRef.current!==authGeneration)throw new DOMException('Authentication attempt superseded','AbortError');};
    try {
      await persistCodSession(nextSession.token);
      assertCurrentAuth();
      await loadWorkspace(nextSession,authGeneration);
      assertCurrentAuth();
    } catch (error) {
      try {
        const cleared=await logoutCod(nextSession.token,{clearMobileHistory:false});
        if(!cleared)throw new ApiError('登录凭据回滚未完成，请清理本机应用数据后重试。',503,'logout_recovery_unavailable');
      } catch (cleanupError) {
        if(cleanupError instanceof ApiError&&cleanupError.code==='logout_recovery_unavailable')throw cleanupError;
      }
      throw error;
    }
    sessionTokenRef.current=nextSession.token;setSession(nextSession);setAuthState('signed-in');setOverlay(nextOverlay);setResumeComputeAfterLogin(false);
  };

  const handleLogin = async (email: string, password: string) => {
    const authGeneration=++authGenerationRef.current;
    const nextSession = await loginCod(email, password);
    if(authGenerationRef.current!==authGeneration)throw new DOMException('Authentication attempt superseded','AbortError');
    await establishAuthenticatedSession(nextSession,authGeneration,resumeComputeAfterLogin ? 'compute' : null);
  };
  const handleRegister=async(input:{email:string;password:string;inviteCode?:string;legacyAccessCode?:string})=>{
    const authGeneration=++authGenerationRef.current;
    const nextSession=await registerCod(input);
    if(authGenerationRef.current!==authGeneration)throw new DOMException('Authentication attempt superseded','AbortError');
    await establishAuthenticatedSession(nextSession,authGeneration,resumeComputeAfterLogin?'compute':null);
  };
  const handleLogout = () => {
    const expectedToken=sessionTokenRef.current??undefined;
    clearAuthenticatedUi();
    void logoutCod(expectedToken,{explicit:true}).catch((error) => setNotice(error instanceof Error ? error.message : '本机登录凭据未能删除，请在系统设置中清除 COD 应用数据。'));
  };
  const refreshWallet = async (quiet=false):Promise<boolean> => {
    if (!session) return false;
    const token=session.token;
    const [accountResult, ledgerResult, creditPacksResult] = await Promise.allSettled([refreshAccount(token), listLedger(token), getCreditPacks(token)]);
    if(sessionTokenRef.current!==token)return false;
    if(accountResult.status==='fulfilled')setSession((current)=>current?.token===token?{...current,account:accountResult.value}:current);
    if(ledgerResult.status==='fulfilled')setLedger(ledgerResult.value);
    if(creditPacksResult.status==='fulfilled')setCreditPacks(creditPacksResult.value);
    const failed=[accountResult.status==='rejected'?'余额':'',ledgerResult.status==='rejected'?'账单':'',creditPacksResult.status==='rejected'?'额度包':''].filter(Boolean);
    if(failed.length&&!quiet)setNotice(`${failed.join('、')}刷新失败，当前回复不受影响。`);
    return failed.length===0;
  };
  const handleTopup = async (amountCents: number) => {
    if (!session || !capabilities?.payments.topupEnabled) { setNotice('支付渠道尚未接入，当前不可充值。'); setOverlay('account'); return; }
    const token=session.token;
    try { const account = await topup(token, amountCents); if(sessionTokenRef.current!==token)return; setSession((current)=>current?.token===token?{...current,account}:current); await refreshWallet(true); if(sessionTokenRef.current===token)setNotice(`已预存 ¥${(amountCents / 100).toFixed(2)} 试点额度。`); }
    catch (error) { setNotice(error instanceof Error ? error.message : '充值失败'); }
  };
  const handleOfficialPayment = async (channel: PaymentOrder['channel']) => {
    if (!session || paymentBusy) return;
    const token=session.token;
    setPaymentBusy(true); setPaymentOrder(null); setPaymentCheckout(null);
    try {
      const result = await createPaymentOrder(token, paymentAmountCents, channel);
      const qrDataUrl = result.checkout.kind === 'qr' ? await QRCode.toDataURL(result.checkout.url, { width: 220, margin: 1, errorCorrectionLevel: 'M' }) : undefined;
      if(sessionTokenRef.current!==token)return;
      setPaymentOrder(result.order); setPaymentCheckout({ ...result.checkout, qrDataUrl });
    } catch (error) { if(sessionTokenRef.current===token)setNotice(error instanceof Error ? error.message : '创建支付订单失败'); }
    finally { if(sessionTokenRef.current===token)setPaymentBusy(false); }
  };
  const handleCopyInviteCode=async()=>{
    if(!referralSummary?.inviteCode)return;
    try{const copied=await copyCodText(referralSummary.inviteCode);setNotice(copied?'邀请码已复制。':'当前环境不能自动复制，请手动选择邀请码。');}
    catch{setNotice('复制失败，请手动选择邀请码。');}
  };
  const handlePurchaseCreditPack = async (packId:string) => {
    if(!session||purchasingPackId)return;const token=session.token;setPurchasingPackId(packId);
    try{const result=await purchaseCreditPack(token,packId);if(sessionTokenRef.current!==token)return;setSession((current)=>current?.token===token?{...current,account:result.account}:current);setCreditPacks((current)=>({...current,summary:result.summary}));const nextLedger=await listLedger(token);if(sessionTokenRef.current!==token)return;setLedger(nextLedger);setNotice(`${result.grant.name} 已到账，有效至 ${new Date(result.grant.expiresAt).toLocaleDateString('zh-CN')}。`);}
    catch(error){if(sessionTokenRef.current===token)setNotice(error instanceof Error?error.message:'购买额度包失败');}
    finally{if(sessionTokenRef.current===token)setPurchasingPackId('');}
  };
  const handleComputeRequest = async (input:ComputeRequestInput) => {
    if(!session){setOverlay('login');return;}
    const token=session.token;const created=await createComputeRequest(token,input);if(sessionTokenRef.current!==token)return;setComputeRequests((current)=>[created,...current.filter((item)=>item.id!==created.id)]);setNotice('需求已提交，商务确认库存和交付条件后会联系你。');
  };
  const handleSourceChange = (sourceId: string) => {
    if (!session) return;
    const source = session.sources.find((item) => item.id === sourceId); if (!source) return;
    setSelectedSourceId(source.id); storageSet('cod.model.source', source.id);
    const storedModel = storageGet(`cod.model.${source.id}`); setSelectedModel(source.models.find((model) => model.id === storedModel)?.id ?? source.models[0]?.id ?? '');
    setNotice(source.note);
  };
  const selectWorkspaceMode=(nextMode:WorkspaceMode)=>{
    if(nextMode==='code'&&!hasDesktopBridge()){setMode('chat');setNotice('代码执行需要 COD Desktop 和已选择的本机项目；Web 端不会把普通聊天标记为代码任务完成。');return;}
    setMode(nextMode);
  };
  const handleModelChange = (modelId: string) => { setSelectedModel(modelId); storageSet(`cod.model.${selectedSourceId}`, modelId); };
  const toggleCompareModel = (key:string) => setCompareModelKeys((current) => current.includes(key) ? current.filter((item) => item !== key) : current.length < 4 ? [...current,key] : current);
  const chooseComparisonModel=(messageId:string,result:ComparisonResult)=>{const modelId=result.modelId??result.model;const source=session?.sources.find((item)=>item.id===result.sourceId);const model=source?.models.find((item)=>item.id===modelId);if(!source||!model||!activeTaskId)return;setSelectedSourceId(source.id);setSelectedModel(model.id);storageSet('cod.model.source',source.id);storageSet(`cod.model.${source.id}`,model.id);setMessagesByTask((current)=>{const messages=(current[activeTaskId]??[]).map((message)=>message.id===messageId?{...message,selectedComparisonKey:comparisonResultKey(result)}:message);storageSet(`cod.messages.${activeTaskId}`,JSON.stringify(messages.slice(-100)));return{...current,[activeTaskId]:messages};});setCompareEnabled(false);setNotice(`已将 ${source.label} · ${model.label} 设为默认模型并用于后续上下文。`);};
  const handleCreateTask = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!session || !newTaskTitle.trim() || !targetDeviceId) return;
    const targetDevice=onlineDesktopDevices.find((device)=>device.id===targetDeviceId);
    if(!targetDevice){setNotice('没有在线的 COD Desktop 设备，请先在电脑端登录并保持在线。');return;}
    const token=session.token;
    try {
      const task = await createRemoteTask(token, newTaskTitle.trim(), targetDevice.id);
      if(sessionTokenRef.current!==token)return;
      setTasks((current) => [task, ...current]); setActiveTaskId(task.id); setNewTaskTitle(''); setOverlay(null); setSidebarOpen(false); setNotice('任务已创建并同步到目标设备。');
    } catch (error) { setNotice(error instanceof Error ? error.message : '创建任务失败'); }
  };
  const changeTaskStatus = async (task: RemoteTask, status: TaskStatus, outcome: { result?: string | null; error?: string | null } = {}): Promise<RemoteTask> => {
    if (!session) return task;
    const token=session.token;const updated = await updateRemoteTask(token, task, status, outcome);if(sessionTokenRef.current!==token)throw new DOMException('Session changed','AbortError');replaceTask(updated);return updated;
  };
  const handleKnowledge = async () => {
    if (!session) { setOverlay('login'); return; }
    const query = prompt.trim() || activeTask?.title || '';
    if (!query) { setNotice('请先输入要检索的内容。'); return; }
    const token=session.token;setKnowledgeLoading(true); setKnowledgeHits([]);
    try { const hits = await searchKnowledge(token, query);if(sessionTokenRef.current!==token)return;setKnowledgeHits(hits);if(!hits.length)setNotice('期算知识库没有找到匹配结果。'); }
    catch (error) {
      if(sessionTokenRef.current!==token)return;
      if (error instanceof ApiError && (error.code === 'wiki_unavailable' || error.code === 'wiki_upstream_error')) setNotice('期算知识库响应超时或暂不可用，请稍后重试。');
      else setNotice(error instanceof Error ? error.message : '期算知识库检索失败，请稍后重试。');
    }
    finally { if(sessionTokenRef.current===token)setKnowledgeLoading(false); }
  };
  const handleRemoteTask = async () => {
    if (!session) { setOverlay('login'); return; }
    const targetDevice=onlineDesktopDevices.find((device)=>device.id===targetDeviceId);
    if(!targetDevice){setNotice('没有在线的 COD Desktop 设备，请先在电脑端登录并保持在线。');return;}
    const title = prompt.trim() || activeTask?.title;
    if (!title) { setOverlay('new-task'); return; }
    const token=session.token;
    try { const task = await createRemoteTask(token, title, targetDevice.id);if(sessionTokenRef.current!==token)return;setTasks((current) => [task, ...current]);setActiveTaskId(task.id);setNotice(`已发送到 ${targetDevice.name}。`); }
    catch (error) { setNotice(error instanceof Error ? error.message : '发送失败'); }
  };
  const handleProductLaunch = async (product: ProductManifest) => {
    if (!session) return;
    const token=session.token;
    try {
      const launch = await launchProduct(token, product.id);
      if(sessionTokenRef.current!==token)return;
      await openCodExternalUrl(launch.url);
    } catch (error) { setNotice(error instanceof Error ? error.message : '产品打开失败'); }
  };
  const handleSend = async (requestedPrompt = prompt, requestedTask: RemoteTask | null = activeTask, requestedMode: WorkspaceMode = mode) => {
    const promptText = requestedPrompt.trim();
    if (!promptText || sendingRef.current) return;
    if (!session) { setPendingSend({ prompt: promptText, mode: requestedMode }); setOverlay('login'); return; }
    if(requestedMode==='code'&&!hasDesktopBridge()){setMode('chat');setNotice('Web 端不能执行代码任务，请使用 COD Desktop；本次没有发送，也不会标记任务完成。');return;}
    if(requestedMode==='code'&&!project.root){setNotice('请先在 COD Desktop 中选择项目，再发送代码任务。');return;}
    const comparisonRequest=compareEnabled&&requestedMode==='chat';
    if(comparisonRequest&&compareTargets.length<2){setNotice('多模型对比至少需要选择 2 个可用模型。');return;}
    if (!comparisonRequest&&(!selectedSource?.callable || !selectedModelInfo)) { setNotice('当前模型源仅供查看目录，配置该源密钥后才能调用。'); return; }
    const token=session.token;
    let task = requestedTask;
    let promptAppended = false;
    let responseAppended = false;
    const run:ActiveRun={taskId:task?.id??'',controller:new AbortController(),cancelled:false,leaseAcquired:false,finalizing:false,terminalCommitted:false,mode:requestedMode};
    const assertActive=()=>{if(run.cancelled||run.controller.signal.aborted||sessionTokenRef.current!==token)throw new DOMException('Task cancelled','AbortError');};
    let projectBeforeRun:ProjectSnapshot|null=null;
    if (task && task.deviceId !== currentDeviceId) { setNotice(`该任务应在 ${devices.find((device) => device.id === task!.deviceId)?.name ?? '目标设备'} 上执行`); return; }
    sendingRef.current=true;activeRunRef.current=run;setIsSending(true);setAgentStatus('正在执行');setNotice('');
    try {
      if(currentDeviceId){await heartbeatDevice(token,currentDeviceId);assertActive();}
      if (!task) {
        if (!currentDeviceId) throw new Error('当前设备尚未完成注册');
        task = await createRemoteTask(token, promptText.slice(0, 80), currentDeviceId);
        assertActive();run.taskId=task.id;
        setTasks((current) => [task!, ...current]); setActiveTaskId(task.id);
      }
      if (task.status !== 'running'||!getTaskExecutionLease(task.id)) {task = await changeTaskStatus(task, 'running');assertActive();}
      run.leaseAcquired=Boolean(getTaskExecutionLease(task.id));if(!run.leaseAcquired)throw new Error('未取得任务执行租约，本次任务未启动。');
      run.taskId=task.id;
      const submittedPrompt = promptText;
      const taskMessages = messagesByTask[task.id] ?? [];
      const contextualTaskMessages=taskMessages.filter((message,index)=>!(message.role==='user'&&message.content.trim()===submittedPrompt&&taskMessages[index+1]?.role==='assistant'&&(taskMessages[index+1]?.failed||taskMessages[index+1]?.cancelled)));
      const contextualHistory=contextualTaskMessages.flatMap((message):Array<{role:'user'|'assistant';content:string}>=>{
        if(message.role==='user'&&message.content.trim())return[{role:'user',content:message.content.trim()}];
        if(message.role==='assistant'&&!message.failed&&!message.cancelled&&message.content.trim())return[{role:'assistant',content:message.content.trim()}];
        if(message.role==='comparison'){
          const successful=message.comparisonResults?.filter((result)=>!result.error&&result.content.trim())??[];
          const selected=successful.find((result)=>comparisonResultKey(result)===message.selectedComparisonKey)??successful.find((result)=>result.sourceId===selectedSource?.id&&(result.modelId??result.model)===selectedModelInfo?.id)??successful[0];
          return selected?[{role:'assistant',content:selected.content.trim()}]:[];
        }
        return[];
      }).slice(-19);
      const conversationMessages = [
        ...contextualHistory,
        { role: 'user' as const, content: submittedPrompt },
      ];
      appendMessage(task.id, { id: createClientId(), role: 'user', content: submittedPrompt, createdAt: new Date().toISOString() });
      promptAppended = true;
      setPrompt('');
      let reply = '';
      let replyMode: 'live' | 'demo' = capabilities?.ai.mode === 'demo' ? 'demo' : 'live';
      if(requestedMode==='code'){
        projectBeforeRun=await loadProject(project.root);
        assertActive();
        if(!projectBeforeRun)throw new Error('无法读取项目运行前状态，本次代码任务未执行。');
      }
      const executionLease=getTaskExecutionLease(task.id);
      const acpUrl = requestedMode === 'code' && selectedSource && selectedModelInfo && executionLease ? await window.codDesktop?.getGooseAcpUrl({ token, sourceId: selectedSource.id, modelId: selectedModelInfo.id, taskId:task.id, executionId:executionLease.executionId, leaseToken:executionLease.leaseToken }) : null;
      assertActive();
      if(comparisonRequest){
        setAgentStatus(`正在并行请求 ${compareTargets.length} 个模型`);
        const results=await Promise.all(compareTargets.map(async(target):Promise<ComparisonResult>=>{const startedAt=performance.now();try{const result=await sendChat(token,target.sourceId,target.model.id,conversationMessages,{taskId:task!.id,signal:run.controller.signal});return{sourceId:target.sourceId,sourceLabel:target.sourceLabel,model:result.model,modelId:target.model.id,content:result.content,inputTokens:result.inputTokens,outputTokens:result.outputTokens,durationMs:Math.round(performance.now()-startedAt)};}catch(error){return{sourceId:target.sourceId,sourceLabel:target.sourceLabel,model:target.model.id,modelId:target.model.id,content:'',durationMs:Math.round(performance.now()-startedAt),error:chatFailureMessage(error)};}}));
        assertActive();
        const successful=results.filter((result)=>!result.error);if(!successful.length)throw new Error('所选模型均未返回可用回答。');
        const preferred=successful.find((result)=>result.sourceId===selectedSource?.id&&(result.modelId??result.model)===selectedModelInfo?.id)??successful[0];
        appendMessage(task.id,{id:createClientId(),role:'comparison',content:'多模型对比',comparisonResults:results,selectedComparisonKey:comparisonResultKey(preferred),createdAt:new Date().toISOString()});
        responseAppended = true;
        reply=successful.map((result)=>`[${result.sourceLabel} · ${result.model}]\n${result.content}`).join('\n\n').slice(0,48_000);
      } else if (requestedMode === 'code') {
        if(!acpUrl)throw new Error('COD Desktop Agent 未能启动，本次代码任务未执行。');
        const { buildCodeExecutionPrompt, runGooseTask, validateCodeRun } = await import('./goose');
        setAgentStatus('连接本机 Goose');
        const contextualPrompt = conversationMessages.length === 1 ? submittedPrompt : `Continue this conversation using the current project.\n\n${conversationMessages.map((message) => `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.content}`).join('\n\n')}`;
        const gooseRun = await runGooseTask({ acpUrl, cwd: project.root, prompt: buildCodeExecutionPrompt(contextualPrompt), signal:run.controller.signal, onUpdate: (update) => { if(run.cancelled||sessionTokenRef.current!==token)return;if (update.kind === 'message') reply += update.text; if (update.kind === 'tool' || update.kind === 'status') setAgentStatus(update.text); }, requestPermission: (request) => new Promise((resolve) => { if(run.cancelled||sessionTokenRef.current!==token){resolve(null);return;}permissionResolver.current = resolve; setPendingPermission({ summary: summarizePermissionToolCall(request.toolCall), options: request.options }); }) });
        assertActive();
        const projectAfterRun=await loadProject(project.root);
        assertActive();
        if(!projectAfterRun)throw new Error('无法读取项目运行后状态，因此未将本次代码任务标记为完成。');
        setProject((current)=>({...projectAfterRun,selectedFile:current.selectedFile,selectedContent:current.selectedContent}));
        reply=gooseRun.answer;validateCodeRun(submittedPrompt,gooseRun,Boolean(projectBeforeRun&&projectBeforeRun.diff!==projectAfterRun.diff));
        if (!reply) reply = 'Goose 已完成任务，请在右侧刷新文件与 Diff。';
      } else {
        if (!selectedSource?.callable || !selectedModelInfo) throw new Error('当前模型源仅供查看目录，配置该源密钥后才能调用。');
        const result = await sendChat(token, selectedSource.id, selectedModelInfo.id, conversationMessages,{taskId:task.id,signal:run.controller.signal});assertActive();reply = result.content;replyMode = result.mode;
        appendMessage(task.id, { id: createClientId(), role: 'assistant', content: reply, mode: replyMode, sourceLabel: selectedSource.label, model: result.model, inputTokens: result.inputTokens, outputTokens: result.outputTokens, usageEstimated: result.usageEstimated, fallbackUsed: result.fallbackUsed, createdAt: new Date().toISOString() });
        responseAppended = true;
      }
      if (!comparisonRequest&&requestedMode === 'code'&&selectedSource&&selectedModelInfo) { appendMessage(task.id, { id: createClientId(), role: 'assistant', content: reply, mode: replyMode, sourceLabel: selectedSource.label, model: selectedModelInfo.id, createdAt: new Date().toISOString() }); responseAppended = true; }
      if (task.status === 'running' || task.status === 'waiting') {run.finalizing=true;try{task = await changeTaskStatus(task, 'complete', { result: reply, error: null });run.terminalCommitted=true;run.leaseAcquired=false;}catch(error){run.finalizing=false;throw error;}assertActive();}
      setAgentStatus('已完成');
      const [walletRefresh,projectRefresh]=await Promise.allSettled([refreshWallet(true),requestedMode!=='code'&&hasDesktopBridge()&&project.root?loadProject(project.root):Promise.resolve(null)]);
      assertActive();
      if(projectRefresh.status==='fulfilled'&&projectRefresh.value)setProject((current)=>({...projectRefresh.value!,selectedFile:current.selectedFile,selectedContent:current.selectedContent}));
      const refreshFailures=[walletRefresh.status==='rejected'||walletRefresh.value===false?'余额/账单':'',projectRefresh.status==='rejected'?'项目状态':''].filter(Boolean);
      if(refreshFailures.length)setNotice(`回复已完成，但${refreshFailures.join('、')}刷新失败，可稍后手动刷新。`);
    } catch (error) {
      if(run.cancelled||sessionTokenRef.current!==token||isTaskCancellation(error)){if(sessionTokenRef.current===token)setAgentStatus('已终止');return;}
      const failure = chatFailureMessage(error);
      setAgentStatus('等待重试'); setNotice(failure);
      if (task && promptAppended && !responseAppended) appendMessage(task.id, { id: createClientId(), role: 'assistant', content: failure, failed: true, retryPrompt: promptText, createdAt: new Date().toISOString() });
      if (task && session && (task.status === 'draft' || task.status === 'running' || task.status === 'waiting')) { run.finalizing=true;try { await changeTaskStatus(task, 'failed', { error: failure });run.terminalCommitted=true;run.leaseAcquired=false; } catch { run.finalizing=false;/* Preserve the original error. */ } }
    } finally { if(activeRunRef.current===run){activeRunRef.current=null;sendingRef.current=false;setIsSending(false);} }
  };
  pendingSendRunner.current = (nextPrompt, nextMode) => { void handleSend(nextPrompt, null, nextMode); };
  useEffect(() => {
    if (!session || !pendingSend || isSending) return;
    const next = pendingSend;
    setPendingSend(null);
    pendingSendRunner.current(next.prompt, next.mode);
  }, [session, pendingSend, isSending]);
  const executeSynchronizedTask = (task: RemoteTask) => {
    if (sendingRef.current) { setNotice('当前任务正在执行，请先等待完成或终止。'); return; }
    if (task.deviceId !== currentDeviceId) { setNotice('请在任务指定的目标设备上执行。'); return; }
    if (hasDesktopBridge() && !project.root) { setNotice('请先在 COD Desktop 中选择该任务要操作的项目。'); return; }
    const instruction = task.status === 'draft' ? task.title : prompt.trim() || task.title;
    void handleSend(instruction, task, hasDesktopBridge() ? 'code' : 'chat');
  };
  const completeSynchronizedTask = (task: RemoteTask) => {
    if (sendingRef.current) { setNotice('任务仍在执行，请先等待完成或终止，不能提前标记完成。'); return; }
    if (task.deviceId !== currentDeviceId) { setNotice('请在任务指定的目标设备上更新状态。'); return; }
    void changeTaskStatus(task, 'complete', { result: task.result?.trim() || '用户在目标设备手动确认任务已完成。', error: null }).catch((error) => setNotice(error.message));
  };
  const cancelSynchronizedTask=async(task:RemoteTask)=>{
    if(!session||cancellingTaskId)return;
    const token=session.token;
    setCancellingTaskId(task.id);setNotice('正在终止任务并释放预占额度…');
    const run=activeRunRef.current;
    if(run?.taskId===task.id){run.cancelled=true;run.controller.abort(new DOMException('Task cancelled','AbortError'));permissionResolver.current?.(null);permissionResolver.current=null;setPendingPermission(null);}
    try{
      const [result]=await Promise.all([cancelRemoteTask(token,task),hasDesktopBridge()&&run?.taskId===task.id?window.codDesktop?.stopGoose():Promise.resolve()]);
      if(sessionTokenRef.current!==token)return;
      if(run?.taskId===task.id)run.leaseAcquired=false;replaceTask(result.task);appendMessage(task.id,{id:createClientId(),role:'assistant',content:hasDesktopBridge()?'任务已由用户终止。本机 Agent 已停止。未结算请求不扣费，已完成或结算中的请求按实际用量计费。':'任务已由用户终止。未结算请求不扣费，已完成或结算中的请求按实际用量计费。',cancelled:true,createdAt:new Date().toISOString()});
      setAgentStatus('已终止');setNotice(result.cancelledRequests>0?`任务已终止，已取消 ${result.cancelledRequests} 个模型请求并释放预占额度。`:'任务已终止，当前没有仍在运行的模型请求。');await refreshWallet();
    }catch(error){
      if(sessionTokenRef.current!==token)return;
      try{const latest=await listTasks(token);if(sessionTokenRef.current!==token)return;setTasks(latest);if(latest.find((item)=>item.id===task.id)?.status==='cancelled'){setAgentStatus('已终止');setNotice('任务已在其他设备终止。');return;}}catch{/* Preserve the cancellation error. */}
      if(sessionTokenRef.current===token)setNotice(error instanceof Error?error.message:'终止任务失败');
    }finally{if(sessionTokenRef.current===token)setCancellingTaskId((current)=>current===task.id?'':current);}
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
  const hiddenMobileContextCount = 3 + Number(Boolean(selectedSource)) + Number(Boolean(selectedModelInfo));

  return <div className={`app-shell${inspectorOpen ? '' : ' inspector-hidden'}`}>
    <aside className="rail"><Brand /><div className="rail-actions"><button className={`icon-button ${mode === 'code' ? 'active' : ''}`} title="任务" onClick={() => { selectWorkspaceMode('code'); setSidebarOpen(true); }}><ListChecks weight="fill" /></button><button className={`icon-button ${mode === 'chat' ? 'active' : ''}`} title="普通对话" onClick={() => selectWorkspaceMode('chat')}><ChatCircleDots /></button><button className="icon-button compute-entry" title="算力市场" onClick={() => setOverlay('compute')}><Storefront weight="fill" /></button><button className="icon-button" title="模型库" onClick={() => setOverlay('models')}><Stack /></button><button className="icon-button" title="命令面板" onClick={() => setOverlay('commands')}><Command /></button>{products.map((product) => <button className="icon-button" title={product.name} key={product.id} onClick={() => void handleProductLaunch(product)}><ArrowSquareOut /></button>)}</div><div className="rail-footer"><ThemeToggle colorMode={colorMode} onChange={setColorMode} /><button className="icon-button" title={session ? '账户' : '登录'} onClick={() => setOverlay(session ? 'account' : 'login')}><UserCircle /></button></div></aside>
    {sidebarOpen && <button className="sidebar-scrim" aria-label="关闭任务栏" onClick={() => setSidebarOpen(false)} />}
    <aside className={`sidebar ${sidebarOpen ? 'open' : ''}`}><div className="sidebar-head"><div><small>工作区</small><strong>{mode === 'code' ? '代码任务' : '对话'}</strong></div><button className="new-task" onClick={() => setOverlay(session ? 'new-task' : 'login')}><Plus weight="bold" /> 新任务</button></div><div className="search"><MagnifyingGlass /><input aria-label="搜索任务" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="搜索任务或状态" /></div><TaskList tasks={filteredTasks} devices={devices} activeId={activeTaskId} onSelect={(id) => { setActiveTaskId(id); setSidebarOpen(false); }} /><div className="sidebar-bottom">{notice && <div className="remote-notice">{notice}</div>}<button className="project-switch" onClick={handleOpenProject}><span className="project-icon"><Folder weight="fill" /></span><span><small>当前项目</small><strong>{projectName}</strong></span><CaretDown /></button><div className="balance-preview"><Lightning weight="fill" /><span><small>可用使用额度</small><strong>{session ? session.account.billingExempt ? '不限额度' : `¥ ${((session.account.balanceCents + creditPacks.summary.availableCents) / 100).toFixed(2)}` : '登录后查看'}</strong></span><button onClick={() => setOverlay(session ? 'account' : 'login')}>{session ? '额度包' : '登录'}</button></div></div></aside>
    <main className="workspace"><header className="workspace-header"><div className="task-heading"><button className="mobile-only icon-button" title="打开任务栏" onClick={() => setSidebarOpen(true)}><SidebarSimple /></button><div><h1>{activeTask?.title ?? (session ? '新建或选择任务' : '新对话')}</h1><p>{project.root || (authState === 'loading' ? '正在连接 COD…' : session ? 'Web 远程工作区' : '输入消息即可开始')}</p></div></div><div className="header-actions">{activeTask && <span className={`header-status ${activeTask.status}`}>{statusLabels[activeTask.status]}</span>}<div className="mode-switch" aria-label="工作模式"><button className={mode === 'code' ? 'active' : ''} onClick={() => selectWorkspaceMode('code')}><Code /> 代码</button><button className={mode === 'chat' ? 'active' : ''} onClick={() => selectWorkspaceMode('chat')}><ChatCircleDots /> 对话</button></div><select className="source-picker" aria-label="模型源" value={selectedSource?.id ?? ''} onChange={(event) => handleSourceChange(event.target.value)} disabled={!session}><option value="">{authState === 'loading' ? '正在连接…' : '登录后选择模型源'}</option>{session?.sources.map((source) => <option key={source.id} value={source.id}>{source.label} · {source.callable ? '已连接' : source.status === 'catalog' ? '目录' : '不可用'}</option>)}</select><select className="model-picker" aria-label="模型" value={selectedModelInfo?.id ?? ''} onChange={(event) => handleModelChange(event.target.value)} disabled={!session || !sourceModels.length}><option value="">登录后选择模型</option>{sourceModels.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}</select><button className={`icon-button inspector-toggle${inspectorOpen ? ' active' : ''}`} title={inspectorOpen ? '隐藏右侧面板' : '显示右侧面板'} onClick={toggleInspector}><SidebarSimple /></button></div></header>
      <section className="conversation"><div className="conversation-scroll">{!activeTask && <div className="empty-state"><div className="agent-avatar"><span>C</span></div><h2>{session ? '从一个真实任务开始' : '有什么可以帮你？'}</h2><p>{session ? '新建任务后，状态、目标设备和执行结果会同步保存。' : '直接输入第一条消息；保持随后打开的登录窗口，并完成认证后自动发送。'}</p>{session && <button className="primary-button" onClick={() => setOverlay('new-task')}><Plus /> 新建任务</button>}</div>}{activeTask && !activeMessages.length && !activeTask.result && !activeTask.error && <div className="empty-state compact"><StatusGlyph status={activeTask.status} /><h2>{activeTask.title}</h2><p>{activeTask.status==='cancelled'?'任务已终止，可重新执行。':`任务已同步到 ${devices.find((device) => device.id === activeTask.deviceId)?.name ?? '目标设备'}。输入内容开始执行。`}</p></div>}{activeTask && !activeMessages.length && (activeTask.result || activeTask.error) && <article className="agent-message"><div className="agent-avatar"><span>C</span></div><div><header><strong>{activeTask.error ? '远程任务失败' : '远程任务结果'}</strong></header><MarkdownContent>{activeTask.error ? chatFailureMessage(new Error(activeTask.error)) : activeTask.result ?? ''}</MarkdownContent><small>{formatTime(activeTask.updatedAt)}</small></div></article>}{activeMessages.map((message) => message.role === 'user' ? <article className="user-message" key={message.id}><p>{message.content}</p><small>{formatTime(message.createdAt)}</small></article> : message.role === 'comparison' ? <article className="comparison-message" key={message.id}><header><div><Stack weight="fill" /><span><strong>多模型对比</strong><small>同一问题 · {message.comparisonResults?.length ?? 0} 个模型</small></span></div><time>{formatTime(message.createdAt)}</time></header><div className="comparison-results">{message.comparisonResults?.map((result) => <section className={`${result.error ? 'failed' : ''}${message.selectedComparisonKey === comparisonResultKey(result) ? ' selected' : ''}`.trim()} key={`${result.sourceId}-${result.model}`}><header><span><strong>{result.model}</strong><small>{result.sourceLabel}</small></span><div><i>{result.error ? '失败' : `${(result.durationMs / 1000).toFixed(1)}s`}</i>{!result.error&&<button type="button" aria-pressed={message.selectedComparisonKey === comparisonResultKey(result)} onClick={()=>chooseComparisonModel(message.id,result)}>{message.selectedComparisonKey === comparisonResultKey(result) ? '已用于后续对话' : '选用此回答'}</button>}</div></header><MarkdownContent className={result.error ? 'comparison-error' : ''}>{result.error ?? result.content}</MarkdownContent><footer>{result.inputTokens !== undefined && result.outputTokens !== undefined ? `输入 ${result.inputTokens.toLocaleString('zh-CN')} / 输出 ${result.outputTokens.toLocaleString('zh-CN')} Token` : '未返回 Token 用量'}</footer></section>)}</div></article> : <article className={`agent-message${message.failed ? ' failed' : message.cancelled?' cancelled':''}`} key={message.id}><div className="agent-avatar"><span>{message.failed ? '!' : message.cancelled?'■':'C'}</span></div><div><header><strong>{message.failed ? '本次未扣费' : message.cancelled?'任务已终止':'COD Agent'}</strong>{message.mode === 'demo' && <span className="demo-chip">演示响应</span>}{message.sourceLabel && <span className="source-chip">{message.sourceLabel} · {message.model}{message.fallbackUsed ? '（健康模型降级）' : ''}{message.inputTokens !== undefined && message.outputTokens !== undefined ? ` · 输入 ${message.inputTokens.toLocaleString('zh-CN')} / 输出 ${message.outputTokens.toLocaleString('zh-CN')} Token${message.usageEstimated ? '（估算）' : ''}` : ''}</span>}</header><MarkdownContent>{message.content}</MarkdownContent>{message.failed && message.retryPrompt && <button className="retry-message" disabled={isSending} onClick={() => void handleSend(message.retryPrompt, activeTask, mode)}><ArrowClockwise /> 重试这条消息</button>}<small>{formatTime(message.createdAt)}</small></div></article>)}{isSending && <div className="agent-intro"><div className="agent-avatar"><span>C</span></div><div><strong>COD Agent</strong><small>{agentStatus}</small></div><span className="live-chip"><CircleNotch className="spin" /> running</span></div>}{pendingPermission && <div className="live-permission"><PermissionRequestSummary summary={pendingPermission.summary} showPersistentWarning={permissionOptionsRequirePersistentWarning(pendingPermission.options)} /><p>Goose 请求执行权限，请确认本次操作。建议优先选择单次授权。</p><div>{presentPermissionOptions(pendingPermission.options).map((option) => <button className={option.kind === 'allow_once' ? 'approve' : option.kind.endsWith('always') ? 'persistent' : ''} key={option.optionId} title={option.kind.endsWith('always') ? '在当前 Agent 会话的后续同类操作中持续生效' : undefined} onClick={() => resolvePermission(option.optionId)}>{permissionOptionLabel(option)}</button>)}<button onClick={() => resolvePermission(null)}>取消</button></div></div>}</div>
        <div className="composer-wrap">
          {activeTask && <div className="task-actions">{(activeTask.status === 'draft' || activeTask.status === 'failed' || activeTask.status === 'complete' || activeTask.status==='cancelled') && <button onClick={() => executeSynchronizedTask(activeTask)} disabled={isSending}><Play /> {activeTask.status === 'failed' ? '重试任务' : activeTask.status === 'complete' ? '继续任务' : activeTask.status==='cancelled'?'重新执行':'执行任务'}</button>}{(activeTask.status === 'running' || activeTask.status === 'waiting') && <><button onClick={() => completeSynchronizedTask(activeTask)} disabled={isSending || cancellingTaskId===activeTask.id}><Check /> 标记完成</button><button className="cancel-task" onClick={() => void cancelSynchronizedTask(activeTask)} disabled={Boolean(cancellingTaskId)}>{cancellingTaskId===activeTask.id?<CircleNotch className="spin"/>:<Stop weight="fill"/>}{cancellingTaskId===activeTask.id?'正在终止':'终止任务'}</button></>}</div>}
          {mode === 'chat' && <div className={`compare-bar${compareEnabled ? ' open' : ''}`}><button className="compare-toggle" aria-pressed={compareEnabled} onClick={() => setCompareEnabled((current) => !current)}><Stack weight={compareEnabled ? 'fill' : 'regular'} /><span><strong>多模型对比</strong><small>{compareEnabled ? `已选 ${compareTargets.length} 个模型` : '同一问题并行比较 2-4 个模型'}</small></span><i>{compareEnabled ? '已开启' : '开启'}</i></button>{compareEnabled && <div className="compare-picker"><header><span>选择模型</span><small>本次发送将产生 {compareTargets.length} 次独立计费请求</small></header><div>{callableModels.map((target) => { const checked=compareModelKeys.includes(target.key); return <label className={checked ? 'selected' : ''} key={target.key}><input type="checkbox" checked={checked} disabled={!checked&&compareModelKeys.length>=4} onChange={() => toggleCompareModel(target.key)} /><span><strong>{target.model.label}</strong><small>{target.sourceLabel} · 输入 ¥{(target.model.inputPricePerMillionCents/100).toFixed(2)} / 输出 ¥{(target.model.outputPricePerMillionCents/100).toFixed(2)} 每百万</small></span><Check weight="bold" /></label>;})}</div>{callableModels.length<2&&<p>当前可调用模型不足 2 个，暂时无法开始对比。</p>}</div>}</div>}
          <div className={`context-strip${mobileContextExpanded ? ' mobile-expanded' : ''}`}>
            <span className="mobile-context-secondary"><Folder weight="fill" /> {projectName}</span>
            <span className="mobile-context-secondary"><GitDiff /> {changeCount} 个改动</span>
            <span className="mobile-context-secondary"><ShieldCheck /> 本机操作需确认</span>
            {selectedSource && <span className="mobile-context-primary" aria-label={selectedSource.paymentDirection} title={selectedSource.paymentDirection}><Lightning weight="fill" /><b className="context-source-desktop" aria-hidden="true">{selectedSource.paymentDirection}</b><b className="context-source-mobile" aria-hidden="true">{selectedSource.label}</b></span>}
            {selectedModelInfo && <span className="mobile-context-primary context-price" aria-label={`输入 ¥${(selectedModelInfo.inputPricePerMillionCents / 100).toFixed(2)} / 输出 ¥${(selectedModelInfo.outputPricePerMillionCents / 100).toFixed(2)} 每百万 Token`} title={`输入 ¥${(selectedModelInfo.inputPricePerMillionCents / 100).toFixed(2)} / 输出 ¥${(selectedModelInfo.outputPricePerMillionCents / 100).toFixed(2)} 每百万 Token`}><b className="context-price-desktop" aria-hidden="true">输入 ¥{(selectedModelInfo.inputPricePerMillionCents / 100).toFixed(2)} / 输出 ¥{(selectedModelInfo.outputPricePerMillionCents / 100).toFixed(2)} 每百万 Token</b><b className="context-price-mobile" aria-hidden="true">入 ¥{(selectedModelInfo.inputPricePerMillionCents / 100).toFixed(2)} / 出 ¥{(selectedModelInfo.outputPricePerMillionCents / 100).toFixed(2)}</b></span>}
            <button className={selectedSource ? 'mobile-context-secondary' : 'mobile-context-primary'} onClick={handleKnowledge} disabled={knowledgeLoading}>{knowledgeLoading ? <CircleNotch className="spin" /> : <MagnifyingGlass />} 期算知识库</button>
            <button className={selectedModelInfo ? 'mobile-context-secondary' : 'mobile-context-primary'} onClick={handleRemoteTask}><PaperPlaneTilt /> 发送到设备</button>
            <button className="context-more-toggle" type="button" aria-expanded={mobileContextExpanded} aria-label={mobileContextExpanded ? '收起上下文信息' : `展开更多上下文信息，共 ${hiddenMobileContextCount} 项`} onClick={() => setMobileContextExpanded((current) => !current)}><CaretDown /> {mobileContextExpanded ? '收起' : '更多'}</button>
          </div>
          {notice && <div className="remote-notice"><span>{notice}</span><button title="关闭提示" onClick={() => setNotice('')}><X /></button></div>}
          {knowledgeHits.length > 0 && <div className="knowledge-strip">{knowledgeHits.map((hit) => <button type="button" key={hit.id} onClick={()=>void openCodExternalUrl(hit.url)}><strong>{hit.title}</strong><span>{hit.excerpt}</span></button>)}</div>}
          <div className="composer"><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void handleSend(); }} placeholder={mode === 'code' ? '让 COD 修改、检查或解释这个项目...' : compareEnabled ? `输入一个问题，同时询问 ${compareTargets.length} 个模型...` : '问 COD 任何问题...'} /><div className="composer-footer"><button className="composer-tool" title="查看项目文件" onClick={() => { if (hasDesktopBridge()) setInspectorTab('files'); else setNotice('项目文件仅在 COD Desktop 中可用。'); }}><Plus /></button><span>{compareEnabled&&mode==='chat'?`${compareTargets.length} 个模型 · 独立计费`:'⌘ ↵ 发送'}</span><button className="send" title="发送" disabled={!prompt.trim() || isSending || Boolean(session && (compareEnabled&&mode==='chat' ? compareTargets.length<2 : !selectedSource?.callable && !(mode === 'code' && hasDesktopBridge() && project.root)))} onClick={() => void handleSend()}>{isSending ? <CircleNotch className="spin" /> : <PaperPlaneTilt weight="fill" />}</button></div></div>
        </div></section>
    </main>
    {inspectorOpen && <aside className="inspector"><div className="inspector-tabs"><button className={inspectorTab === 'changes' ? 'active' : ''} onClick={() => setInspectorTab('changes')}><GitDiff /> 改动</button><button className={inspectorTab === 'files' ? 'active' : ''} onClick={() => setInspectorTab('files')}><Folder /> 文件</button><button className={inspectorTab === 'terminal' ? 'active' : ''} onClick={() => setInspectorTab('terminal')}><TerminalWindow /> 终端</button><button className="inspector-close" title="隐藏右侧面板" onClick={toggleInspector}><X /></button></div><div className="inspector-body">{inspectorTab === 'changes' && <><div className="panel-title"><span><GitDiff /> 未提交改动</span><button title="刷新" onClick={refreshProject}><ArrowClockwise /></button></div>{project.root ? <CodeBlock text={project.diff || '当前项目没有未提交改动。'} /> : <div className="panel-empty">Web 端不伪造 Diff。请在 COD Desktop 中选择本机项目。</div>}</>}{inspectorTab === 'files' && <>{project.root ? <><div className="panel-title"><span><Folder /> 项目文件</span><small>{project.files.length}</small></div><FileTree files={project.files} selected={project.selectedFile} onSelect={handleFileSelect} />{project.selectedFile && <div className="file-preview"><strong>{project.selectedFile}</strong><CodeBlock text={project.selectedContent} /></div>}</> : <div className="panel-empty">本机文件仅在 COD Desktop 中可用。</div>}</>}{inspectorTab === 'terminal' && <>{window.codDesktop && project.root ? <><div className="panel-title"><span><TerminalWindow /> 本地终端</span><small>desktop</small></div><div className="terminal"><pre>{terminalOutput}</pre><div className="terminal-command"><span>$</span><input aria-label="终端命令" value={command} onChange={(event) => setCommand(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && handleRun()} /><button onClick={handleRun}>运行</button></div></div></> : <div className="panel-empty">Web 端不会执行或伪造终端结果。请使用 COD Desktop。</div>}</>}</div></aside>}
    {overlay === 'login' && <Modal title={pendingSend ? '登录后继续' : '登录 COD'} onClose={closeTopmostUi}><LoginForm capabilities={capabilities} capabilityError={capabilityError} resumeConversation={Boolean(pendingSend)} onLogin={handleLogin} onRegister={handleRegister} /></Modal>}
    {overlay === 'models' && <Modal title="模型库" wide onClose={closeTopmostUi}><ModelLibrary sources={modelCatalog} error={modelCatalogError} signedIn={Boolean(session)} onLogin={() => setOverlay('login')} /></Modal>}
    {overlay === 'compute' && <Modal title="COD 算力市场 · 机房直供 / 卡时 / 分期" wide onClose={closeTopmostUi}><ComputeMarket offers={computeOffers} requests={computeRequests} signedIn={Boolean(session)} draft={computeDraft} onDraftChange={setComputeDraft} onLogin={() => { setResumeComputeAfterLogin(true); setOverlay('login'); }} onSubmit={handleComputeRequest} /></Modal>}
    {overlay === 'new-task' && session && <Modal title="新建任务" onClose={closeTopmostUi}><form className="modal-form" onSubmit={handleCreateTask}><label>任务标题<input aria-label="任务标题" value={newTaskTitle} onChange={(event) => setNewTaskTitle(event.target.value)} placeholder="例如：审计登录流程" required autoFocus /></label><label>目标设备<select aria-label="目标设备" value={targetDeviceId} onChange={(event) => setTargetDeviceId(event.target.value)} required>{!onlineDesktopDevices.length && <option value="">暂无在线 COD Desktop</option>}{onlineDesktopDevices.map((device) => <option key={device.id} value={device.id}>{device.name} · {device.status}</option>)}</select></label><button className="primary-button" disabled={isSending || !newTaskTitle.trim() || !onlineDesktopDevices.some((device) => device.id === targetDeviceId)}><Plus /> {onlineDesktopDevices.length ? '创建并同步' : '等待 Desktop 上线'}</button></form></Modal>}
    {overlay === 'account' && session && <Modal title="钱包与额度包" wide onClose={closeTopmostUi}><div className="account-panel">
      <div className="balance-grid"><div className="account-balance"><small>{session.account.billingExempt ? '管理员测试账户' : '钱包余额 · 永久有效'}</small><strong>{session.account.billingExempt ? '不限额度' : `¥ ${(session.account.balanceCents / 100).toFixed(2)}`}</strong><span>{session.account.billingExempt ? '模型调用会记录零元测试流水，不扣钱包或额度包' : '不买额度包也能按模型原价直接扣款'}</span></div><div className="account-balance credit"><small>AI.KAI.COM 使用额度 · 优先扣减</small><strong>¥ {(creditPacks.summary.availableCents / 100).toFixed(2)}</strong><span>含限时赠额 · {creditPacks.summary.grants.filter((grant) => grant.status === 'active').length} 个有效批次</span></div></div>
      <section className="credit-pack-section"><header><div><strong>{session.account.billingExempt ? '管理员测试账户无需兑换额度包' : '钱包兑换 AI.KAI.COM 180 天额度包'}</strong><small>{session.account.billingExempt ? '当前账户为不限额度测试账户，模型调用不扣钱包；普通用户仍可用钱包兑换限时赠额。' : '额度包按模型原价计量，但可获得限时赠额；不用额度包时继续从永久钱包按原价扣款。'}</small></div></header><div className="credit-pack-grid">{creditPacks.packs.map((pack) => <article key={pack.id}><span>{pack.bonusPercent ? `赠 ${pack.bonusPercent}%` : '基础档'}</span><strong>{pack.name}</strong><b>¥ {(pack.creditCents / 100).toFixed(0)} <small>使用额度</small></b><p>钱包兑换 ¥{(pack.priceCents / 100).toFixed(0)} · {pack.validityDays} 天</p><button disabled={session.account.billingExempt || Boolean(purchasingPackId) || session.account.balanceCents < pack.priceCents} onClick={() => void handlePurchaseCreditPack(pack.id)}>{purchasingPackId === pack.id ? <CircleNotch className="spin" /> : <Lightning weight="fill" />} {session.account.billingExempt ? '管理员无需兑换' : session.account.balanceCents < pack.priceCents ? '钱包余额不足' : '使用钱包兑换'}</button></article>)}</div></section>
      {creditPacks.summary.grants.length > 0 && <section className="credit-grants"><header><strong>额度批次</strong><small>试用金 30 天；购买额度包 180 天</small></header>{creditPacks.summary.grants.map((grant) => <div key={grant.id}><span><strong>{grant.name}</strong><small>{grant.status === 'expired' ? '已过期' : grant.status === 'depleted' ? '已用完' : `有效至 ${new Date(grant.expiresAt).toLocaleDateString('zh-CN')}`}</small></span><b className={grant.status}>¥ {(grant.remainingCents / 100).toFixed(2)} / ¥ {(grant.originalCents / 100).toFixed(2)}</b></div>)}</section>}
      <div className="service-grid"><span>实际模型网关<strong className={capabilities?.ai.mode === 'live' ? 'live' : 'demo'}>{capabilities?.ai.mode === 'live' ? 'ai.kai.com 已连接' : capabilities?.ai.mode === 'demo' ? '演示模式' : '不可用'}</strong></span><span>扣费顺序<strong>临期额度 → 永久钱包</strong></span><span>当前归因来源<strong>{selectedSource?.label ?? '未选择'} · 分成 {(selectedSource?.commissionRateBps ?? 0) / 100}%</strong></span><span>支付方向<strong>{selectedSource?.paymentDirection ?? '未选择'}</strong></span></div>
      {referralSummary && <div className="invite-panel"><span><small>我的邀请码</small><code>{referralSummary.inviteCode}</code><i>已邀请 {referralSummary.referredUsers} 人</i></span><button onClick={() => void handleCopyInviteCode()}><Key /> 复制邀请码</button></div>}
      {(capabilities?.payments.channels?.length ?? 0) > 0 && <section className="official-payment">
        <header><div><strong>官方商户充值</strong><small>订单金额与回调金额一致后才会入账；未支付订单不会增加余额。</small></div><label>充值金额<select aria-label="充值金额" value={paymentAmountCents} onChange={(event) => setPaymentAmountCents(Number(event.target.value))} disabled={paymentBusy}><option value={1000}>¥10</option><option value={5000}>¥50</option><option value={10000}>¥100</option><option value={20000}>¥200</option><option value={50000}>¥500</option></select></label></header>
        <div className="official-payment-actions">{capabilities?.payments.channels?.includes('wechat') && <button className="wechat" disabled={paymentBusy} onClick={() => void handleOfficialPayment('wechat')}>{paymentBusy ? <CircleNotch className="spin" /> : <CreditCard />} 微信支付</button>}{capabilities?.payments.channels?.includes('alipay') && <button className="alipay" disabled={paymentBusy} onClick={() => void handleOfficialPayment('alipay')}>{paymentBusy ? <CircleNotch className="spin" /> : <CreditCard />} 支付宝</button>}</div>
        {paymentCheckout && paymentOrder && <div className={`payment-checkout ${paymentOrder.status}`}><div>{paymentCheckout.kind === 'qr' && paymentCheckout.qrDataUrl ? <img src={paymentCheckout.qrDataUrl} alt="微信支付二维码" /> : <CreditCard weight="duotone" />}</div><span><strong>{paymentOrder.status === 'paid' ? '充值已到账' : paymentCheckout.kind === 'qr' ? '请使用微信扫码支付' : '支付宝订单已创建'}</strong><small>订单 {paymentOrder.id} · ¥{(paymentOrder.amountCents / 100).toFixed(2)}</small>{paymentOrder.status === 'pending' && paymentCheckout.kind === 'redirect' && <button type="button" onClick={()=>void openCodExternalUrl(paymentCheckout.url)}>前往支付宝付款 <ArrowSquareOut /></button>}{paymentOrder.status === 'pending' && <i>正在等待官方支付结果…</i>}</span></div>}
      </section>}
      {capabilities?.payments.mode === 'unavailable' && <div className="payment-status unavailable"><strong>充值渠道尚未开通</strong><small>当前只能使用已有钱包余额和试用额度；COD 不会创建无法支付的订单。</small></div>}
      {capabilities?.payments.topupEnabled && <div className="topup-panel"><div><strong>预存试点钱包</strong><small>仅用于本轮产品与计费闭环测试，不代表真实支付已到账。</small></div><div><button onClick={() => handleTopup(1000)}>+ ¥10</button><button onClick={() => handleTopup(5000)}>+ ¥50</button><button onClick={() => handleTopup(10000)}>+ ¥100</button></div></div>}
      <div className="ledger"><header><strong>最近流水</strong><button onClick={() => void refreshWallet()}><ArrowClockwise /> 刷新</button></header>{ledger.length ? ledger.map((entry) => <div key={entry.id}><span>{entry.type === 'usage' ? `${entry.model ?? '模型'} 用量` : entry.type === 'pack_purchase' ? `兑换 ${entry.reference}` : entry.type === 'trial_credit' ? '新用户试用金' : entry.type === 'credit_grant' ? `${entry.reference} 到账` : entry.type === 'opening_balance' ? '历史钱包期初余额' : '钱包预存'}<small>{entry.paymentDirection ?? entry.reference} · {formatTime(entry.createdAt)}{entry.type === 'usage' && entry.creditAmountCents !== 0 ? ` · 额度 ¥${Math.abs(entry.creditAmountCents / 100).toFixed(2)}` : ''}{entry.type === 'usage' && entry.walletAmountCents !== 0 ? ` · 钱包 ¥${Math.abs(entry.walletAmountCents / 100).toFixed(2)}` : ''}{entry.type === 'usage' && entry.sourceId ? ` · 归因 ${entry.sourceId} / 上游 ${entry.upstreamSourceId ?? 'ai-kai'}` : ''}{entry.type === 'usage' && (entry.commissionRateBps ?? 0) > 0 ? ` · 分成 ¥${((entry.commissionCents ?? 0) / 100).toFixed(2)}` : ''}</small></span><strong className={entry.amountCents < 0 ? 'negative' : 'positive'}>{entry.amountCents > 0 ? '+' : ''}¥ {(entry.amountCents / 100).toFixed(2)}</strong></div>) : <p>暂无流水</p>}</div><button className="secondary-button" onClick={handleLogout}><SignOut /> 退出登录</button>
    </div></Modal>}
    {overlay === 'commands' && <Modal title="命令面板" onClose={closeTopmostUi}><div className="command-list"><button onClick={() => setOverlay(session ? 'new-task' : 'login')}><Plus /><span><strong>新建任务</strong><small>创建并同步到设备</small></span></button><button onClick={() => { selectWorkspaceMode('code'); setOverlay(null); }}><Code /><span><strong>代码模式</strong><small>进入项目与 Agent 工作区</small></span></button><button onClick={() => { selectWorkspaceMode('chat'); setOverlay(null); }}><ChatCircleDots /><span><strong>普通对话</strong><small>使用选定模型提问</small></span></button><button onClick={() => setOverlay('compute')}><Storefront /><span><strong>算力市场</strong><small>H100 卡时、闲置卡撮合与设备分期申请</small></span></button><button onClick={() => setOverlay('models')}><Stack /><span><strong>模型库</strong><small>查看可用模型与每百万 Token 价格</small></span></button><button onClick={() => { setInspectorTab('terminal'); setOverlay(null); }}><TerminalWindow /><span><strong>打开终端</strong><small>{hasDesktopBridge() ? '运行受控本机命令' : '仅桌面端可用'}</small></span></button><button onClick={() => setOverlay(session ? 'account' : 'login')}><UserCircle /><span><strong>账户与服务状态</strong><small>余额、流水和接入状态</small></span></button></div></Modal>}
  </div>;
}
