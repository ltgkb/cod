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
import { Copy } from '@phosphor-icons/react/Copy';
import { CreditCard } from '@phosphor-icons/react/CreditCard';
import { DownloadSimple } from '@phosphor-icons/react/DownloadSimple';
import { DotsThree } from '@phosphor-icons/react/DotsThree';
import { File } from '@phosphor-icons/react/File';
import { Folder } from '@phosphor-icons/react/Folder';
import { GitDiff } from '@phosphor-icons/react/GitDiff';
import { Handshake } from '@phosphor-icons/react/Handshake';
import { HardDrives } from '@phosphor-icons/react/HardDrives';
import { Key } from '@phosphor-icons/react/Key';
import { Kanban } from '@phosphor-icons/react/Kanban';
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
import type { AdminComputeRequestSummary, DesktopPetStatus, DeviceRecord, KnowledgeHit, ProductManifest, TaskStatus, WorkspaceFile } from '@cod/contracts';
import {
  cancelRemoteTask,
  createRemoteTask,
  createComputeRequest,
  decideComputeRequestQuote,
  createClientId,
  createPaymentOrder,
  getCapabilities,
  getAdminComputeRequest,
  getCreditPacks,
  getPaymentOrder,
  getReferralSummary,
  getTaskExecutionLease,
  heartbeatDevice,
  hydrateCodSession,
  listDevices,
  listComputeOffers,
  listComputeRequests,
  listAdminComputeRequests,
  listLedger,
  listModelSources,
  listProducts,
  launchProduct,
  listModelCatalog,
  listTasks,
  loginCod,
  logoutCod,
  observeCodSessionInvalidated,
  refreshAccount,
  purchaseCreditPack,
  quoteAdminComputeRequest,
  persistCodSession,
  registerDevice,
  registerCod,
  resumeCodSession,
  searchKnowledge,
  sendChat,
  startRegistrationEmail,
  startRegistrationPhone,
  topup,
  updateAdminComputeRequestStatus,
  updateRemoteTask,
  verifyRegistrationEmail,
  verifyRegistrationPhone,
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
  type DirectRegistrationInput,
  type LegacyMigrationInput,
  type VerifiedRegistrationInput,
} from './api';
import { desktopGitDiffError, hasDesktopBridge, loadProject, loadProjectDiff, loadProjectFiles, readProjectFile, selectProjectRoot } from './desktop';
import { chatFailureMessage } from './chat-errors';
import { filterModelCatalog, groupModelCatalog, uniqueCallableModels } from './model-catalog';
import {
  permissionOptionLabel,
  permissionOptionsRequirePersistentWarning,
  persistentPermissionWarning,
  presentPermissionOptions,
  summarizePermissionToolCall,
  type PermissionToolSummary,
} from './permissions';
import { MarkdownContent } from './presentation';
import { copyCodText, getCodRuntime, observeCodTopmostUiClose, openCodExternalUrl, setCodNativeBackHandler } from './runtime';
import type { InspectorTab, ProjectSnapshot, WorkspaceMode } from './types';

const statusLabels: Record<TaskStatus, string> = {
  draft: '草稿', running: '运行中', waiting: '待确认', complete: '已完成', failed: '失败', cancelled: '已终止',
};
const emptyProject: ProjectSnapshot = { root: '', files: [], diff: '', selectedFile: null, selectedContent: '' };
const taskboardDiscoveryIntervalMs = 15_000;
type Overlay = 'login' | 'new-task' | 'account' | 'commands' | 'models' | 'compute' | 'compute-admin' | 'taskboard' | 'desktop-pet' | 'mobile-menu' | null;
type AuthState = 'loading' | 'signed-out' | 'signed-in';
type ColorMode = 'light' | 'dark';
type ProjectDiffStatus = 'idle' | 'loading' | 'ready' | 'error';
interface ComparisonResult { sourceId: string; sourceLabel: string; model: string; modelId?: string; content: string; inputTokens?: number; outputTokens?: number; durationMs: number; error?: string }
interface ChatMessage { id: string; role: 'user' | 'assistant' | 'comparison'; content: string; mode?: 'live' | 'demo'; sourceLabel?: string; model?: string; inputTokens?: number; outputTokens?: number; usageEstimated?: boolean; fallbackUsed?: boolean; failed?: boolean; cancelled?: boolean; retryPrompt?: string; comparisonResults?: ComparisonResult[]; selectedComparisonKey?: string; createdAt: string }
interface ActiveRun { taskId:string; controller:AbortController; cancelled:boolean; leaseAcquired:boolean; finalizing:boolean; terminalCommitted:boolean; mode:WorkspaceMode }
interface CurrentDeviceSnapshot { device:DeviceRecord; devices:DeviceRecord[] }
interface CurrentDeviceRequest { token:string; authGeneration:number; promise:Promise<CurrentDeviceSnapshot> }
interface ComputeDraft {
  tab: ComputeRequestInput['kind']; offerId: string; imageId: string; company: string; contactName: string; contactPhone: string;
  city: string; gpuModel: string; quantity: number; durationHours: number; termMonths: number; requirements: string;
  hostingPeriodMonths: number; rackUnits: number; powerKilowatts: number; networkMbps: number;
  availabilityNotes: string; settlementPreference: string; hostingRequirements: string;
}

const initialComputeDraft: ComputeDraft = {
  tab: 'rental', offerId: '', imageId: '', company: '', contactName: '', contactPhone: '', city: '', gpuModel: 'NVIDIA H100 80GB', quantity: 1,
  durationHours: 100, termMonths: 24, requirements: '', hostingPeriodMonths: 12, rackUnits: 0, powerKilowatts: 0,
  networkMbps: 0, availabilityNotes: '', settlementPreference: '固定托管费（月结）', hostingRequirements: '',
};

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
function storageRemove(key: string): void {
  try { window.localStorage.removeItem(key); } catch { /* Storage can be unavailable in private contexts. */ }
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
function cardHoursFromCents(cents: number): number {
  return Math.floor((cents * 10_000) / 1_002) / 1_000;
}
function formatCardHours(cardHoursMilli: number | undefined, cents: number): string {
  const value=cardHoursMilli===undefined?cardHoursFromCents(cents):cardHoursMilli/1_000;
  return value.toLocaleString('zh-CN',{minimumFractionDigits:value<10?3:2,maximumFractionDigits:3});
}
function isTaskCancellation(error:unknown):boolean{
  return error instanceof ApiError&&error.code==='task_cancelled'||error instanceof DOMException&&error.name==='AbortError'||error instanceof Error&&error.name==='AbortError';
}
function isDefinitiveAuthenticationFailure(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}
function preferredTaskId(tasks: RemoteTask[], currentTaskId: string | null, deviceId: string): string | null {
  if (currentTaskId && tasks.some((task) => task.id === currentTaskId)) return currentTaskId;
  if (!deviceId) return null;
  return tasks.find((task) => task.deviceId === deviceId)?.id ?? null;
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
  const returnFocusRef = useRef<HTMLElement | null>(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const modal = modalRef.current;
    if (!modal) return undefined;
    const returnFocus = returnFocusRef.current;
    const focusableElements = () => [...modal.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
      .filter((element) => !element.hasAttribute('disabled') && element.getAttribute('aria-hidden') !== 'true' && !element.closest('[hidden]'));
    if (!(document.activeElement instanceof Node) || !modal.contains(document.activeElement)) (focusableElements()[0] ?? modal).focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
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
      if (returnFocus?.isConnected) returnFocus.focus();
    };
  }, []);
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onCloseRef.current()}><section ref={modalRef} className={`modal${wide ? ' modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}><header><strong>{title}</strong><button className="icon-button" title="关闭" aria-label="关闭" onClick={() => onCloseRef.current()}><X /></button></header>{children}</section></div>;
}

function LegacyLoginForm({ capabilities, capabilityError, resumeConversation, initialMode = 'login', onModeChange, onLogin, onRegister }: { capabilities: CapabilityReport | null; capabilityError: string; resumeConversation: boolean; initialMode?: 'login'|'register'; onModeChange?: (mode: 'login'|'register') => void; onLogin: (email: string, password: string) => Promise<void>; onRegister:(input:{email:string;password:string;inviteCode?:string;legacyAccessCode?:string})=>Promise<void> }) {
  const [mode,setMode]=useState<'login'|'register'>(initialMode);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword,setConfirmPassword]=useState('');
  const [inviteCode,setInviteCode]=useState('');
  const [legacyAccessCode,setLegacyAccessCode]=useState('');
  const [showLegacyMigration,setShowLegacyMigration]=useState(false);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const registrationAvailable=capabilities?.authentication.registrationEnabled===true;
  const migrationOnly=!registrationAvailable&&capabilities?.authentication.legacyMigrationEnabled===true;
  const enrollmentAvailable=registrationAvailable||migrationOnly;
  const inviteRequired=capabilities?.authentication.inviteCodeRequired===true;
  useEffect(()=>{if(!enrollmentAvailable&&mode==='register'){setMode('login');onModeChange?.('login');setPassword('');setConfirmPassword('');setLegacyAccessCode('');}},[enrollmentAvailable,mode,onModeChange]);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setSubmitting(true); setError('');
    try {
      if(mode==='login')await onLogin(email,password);
      else{
      if(!enrollmentAvailable)throw new Error('当前暂未开放新账号注册或迁移');
        if(password!==confirmPassword)throw new Error('两次输入的密码不一致');
      await onRegister({email,password,inviteCode:registrationAvailable?inviteCode.trim()||undefined:undefined,legacyAccessCode:migrationOnly||showLegacyMigration?legacyAccessCode||undefined:undefined});
      }
    } catch (nextError) {
      if(nextError instanceof ApiError&&nextError.code==='legacy_migration_required')setShowLegacyMigration(true);
      setError(nextError instanceof Error ? nextError.message : mode==='login'?'登录失败':'注册失败');
    } finally { setSubmitting(false); }
  };
  const switchMode=(next:'login'|'register')=>{setMode(next);onModeChange?.(next);setPassword('');setConfirmPassword('');setError('');setShowLegacyMigration(false);setLegacyAccessCode('');};
  const registering=mode==='register';
  return <div className="login-form"><div className={`auth-tabs${enrollmentAvailable?'':' single'}`} role="tablist"><button type="button" role="tab" aria-selected={mode==='login'} className={mode==='login'?'active':''} onClick={()=>switchMode('login')}>密码登录</button>{enrollmentAvailable&&<button type="button" role="tab" aria-selected={registering} className={registering?'active':''} onClick={()=>switchMode('register')}>{migrationOnly?'旧账号迁移':'注册账号'}</button>}</div><div className="login-copy"><span className="eyebrow">COD ACCOUNT</span><h2>{resumeConversation ? `${mode==='login'?'登录':migrationOnly?'迁移':'注册'}后继续对话` : mode==='login'?'登录 COD':migrationOnly?'迁移旧账号':'注册 COD'}</h2><p>{resumeConversation ? '你的消息已保留，认证成功后会自动发送。' : mode==='login'?(registrationAvailable?'当前使用 COD 邮箱密码账号；注册入口在上方。':migrationOnly?'已有账号可直接登录；旧试点账号可完成一次性迁移。':'当前仅开放已有账号登录，新注册暂未开放。'):migrationOnly?'使用旧试点访问码为原账号设置新密码；迁移仅可完成一次。':`注册即获 ¥10 试用金，有效期 30 天。${inviteRequired?'需要有效邀请码。':'邀请码选填，用于绑定邀请人与后续返佣。'}`}</p></div>{capabilityError && <div className="notice error">{capabilityError}</div>}<form onSubmit={submit}><label>邮箱<input aria-label="邮箱" name="email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="username" required autoFocus /></label><label>密码<input key={`password-${mode}`} aria-label="密码" name={mode==='login'?'loginPassword':'newPassword'} type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={mode==='login'?'current-password':'new-password'} minLength={6} maxLength={128} required /></label>{registering&&<><label>确认密码<input key="confirm-register-password" aria-label="确认密码" name="confirmPassword" type="password" value={confirmPassword} onChange={(event)=>setConfirmPassword(event.target.value)} autoComplete="new-password" minLength={6} maxLength={128} required /></label>{registrationAvailable&&<label>邀请码 <small>{inviteRequired?'必填':'选填'}</small><input aria-label="邀请码" name="inviteCode" value={inviteCode} onChange={(event)=>setInviteCode(event.target.value.toUpperCase())} autoComplete="off" maxLength={32} placeholder="例如 KAI-XXXXXXXXXX" required={inviteRequired} /></label>}{(migrationOnly||showLegacyMigration)&&<label>旧试点访问码 <small>仅迁移一次</small><input key="legacy-access-code" aria-label="旧试点访问码" name="legacyAccessCode" type="password" value={legacyAccessCode} onChange={(event)=>setLegacyAccessCode(event.target.value)} autoComplete="off" maxLength={256} required /></label>}<p className="password-hint">密码须为 6-128 位，并同时包含字母和数字。{migrationOnly?'迁移成功后请使用新密码登录。':'邀请关系注册后不可自行更改。'}</p></>}{error && <div className="notice error" role="alert">{error}</div>}<button type="submit" className="primary-button" disabled={submitting}>{submitting ? <CircleNotch className="spin" /> : <Key />} {resumeConversation ? `${mode==='login'?'登录':migrationOnly?'迁移':'注册'}并继续` : mode==='login'?'登录':migrationOnly?'迁移旧账号':'注册并领取试用金'}</button></form><div className="capability-summary"><span className={capabilities?.ai.mode === 'live' ? 'live' : 'demo'}>模型：{capabilities?.ai.mode === 'live' ? '已连接' : capabilities?.ai.mode === 'demo' ? '演示模式' : '待检测'}</span><span>认证：COD 邮箱密码</span></div></div>;
}

type AuthMode = 'login' | 'register';
type RegistrationStep = 'email' | 'email-code' | 'phone' | 'phone-code' | 'password';
type RegistrationDelivery = { maskedDestination: string; expiresAt: string; resendAt: string };
type RegistrationTurnstileAction = 'cod_registration_email' | 'cod_registration_phone';
interface TurnstileApi {
  render(container: HTMLElement, options: { sitekey: string; action: RegistrationTurnstileAction; theme: 'auto'; size: 'flexible'; callback: (token: string) => void; 'expired-callback': () => void; 'error-callback': () => void }): string;
  remove(widgetId: string): void;
}

let turnstileScriptPromise: Promise<TurnstileApi> | null = null;
function loadTurnstile(): Promise<TurnstileApi> {
  const turnstileWindow = window as Window & { turnstile?: TurnstileApi };
  if (turnstileWindow.turnstile) return Promise.resolve(turnstileWindow.turnstile);
  if (turnstileScriptPromise) return turnstileScriptPromise;
  turnstileScriptPromise = new Promise<TurnstileApi>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[data-cod-turnstile]');
    const script = existing ?? document.createElement('script');
    const ready = () => turnstileWindow.turnstile ? resolve(turnstileWindow.turnstile) : reject(new Error('人机验证加载失败'));
    script.addEventListener('load', ready, { once: true });
    script.addEventListener('error', () => reject(new Error('人机验证加载失败')), { once: true });
    if (!existing) {
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      script.async = true;
      script.defer = true;
      script.dataset.codTurnstile = 'true';
      document.head.appendChild(script);
    }
  }).catch((error) => {
    turnstileScriptPromise = null;
    throw error;
  });
  return turnstileScriptPromise;
}

function TurnstileWidget({ siteKey, action, resetNonce, onToken, onError }: { siteKey: string; action: RegistrationTurnstileAction; resetNonce: number; onToken: (token: string) => void; onError: (message: string) => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const onTokenRef = useRef(onToken);
  const onErrorRef = useRef(onError);
  onTokenRef.current = onToken;
  onErrorRef.current = onError;
  useEffect(() => {
    let disposed = false;
    let api: TurnstileApi | null = null;
    let widgetId = '';
    void loadTurnstile().then((loaded) => {
      if (disposed || !containerRef.current) return;
      api = loaded;
      widgetId = loaded.render(containerRef.current, {
        sitekey: siteKey,
        action,
        theme: 'auto',
        size: 'flexible',
        callback: (token) => onTokenRef.current(token),
        'expired-callback': () => onTokenRef.current(''),
        'error-callback': () => onErrorRef.current('人机验证失败，请刷新后重试。'),
      });
    }).catch((error) => {
      if (!disposed) onErrorRef.current(error instanceof Error ? error.message : '人机验证加载失败');
    });
    return () => {
      disposed = true;
      if (api && widgetId) api.remove(widgetId);
    };
  }, [action, resetNonce, siteKey]);
  return <div className="turnstile-slot" ref={containerRef} aria-label="人机验证" />;
}

interface LoginFormProps {
  capabilities: CapabilityReport | null;
  capabilityError: string;
  resumeConversation: boolean;
  initialMode?: AuthMode;
  onModeChange?: (mode: AuthMode) => void;
  onCancelAuthentication: () => void;
  onLogin: (email: string, password: string, signal: AbortSignal) => Promise<void>;
  onRegister: (input: VerifiedRegistrationInput | DirectRegistrationInput | LegacyMigrationInput, signal: AbortSignal, idempotencyKey?: string) => Promise<void>;
}

function secondsUntil(value: string | undefined, now: number): number {
  if (!value) return 0;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, Math.ceil((timestamp - now) / 1_000)) : 0;
}

function safePublicRegistrationUrl(value: string | undefined): string {
  if (!value) return '';
  try {
    const url = new URL(value);
    if (url.origin !== 'https://cod.kai.com' || url.username || url.password) return '';
    if (url.pathname !== '/app/' && url.pathname !== '/app') return '';
    return url.searchParams.get('auth') === 'register' ? url.href : '';
  } catch {
    return '';
  }
}

function LegacyLoginFormAdapter({ capabilities, capabilityError, resumeConversation, initialMode, onModeChange, onCancelAuthentication, onLogin, onRegister }: LoginFormProps) {
  const controllerRef = useRef<AbortController | null>(null);
  useEffect(() => () => controllerRef.current?.abort(new DOMException('Authentication dialog closed', 'AbortError')), []);
  const run = async (operation: (signal: AbortSignal) => Promise<void>) => {
    controllerRef.current?.abort(new DOMException('Authentication superseded', 'AbortError'));
    const controller = new AbortController();
    controllerRef.current = controller;
    try { await operation(controller.signal); }
    finally { if (controllerRef.current === controller) controllerRef.current = null; }
  };
  const changeMode = (next: AuthMode) => {
    controllerRef.current?.abort(new DOMException('Authentication mode changed', 'AbortError'));
    onCancelAuthentication();
    onModeChange?.(next);
  };
  return <LegacyLoginForm
    capabilities={capabilities}
    capabilityError={capabilityError}
    resumeConversation={resumeConversation}
    initialMode={initialMode}
    onModeChange={changeMode}
    onLogin={(email, password) => run((signal) => onLogin(email, password, signal))}
    onRegister={(input) => {
      if (!input.legacyAccessCode) throw new Error('请输入旧试点访问码');
      return run((signal) => onRegister({ email: input.email, password: input.password, legacyAccessCode: input.legacyAccessCode! }, signal));
    }}
  />;
}

const registrationSteps: Array<{ id: RegistrationStep; label: string }> = [
  { id: 'email', label: '邮箱' },
  { id: 'email-code', label: '邮箱验证码' },
  { id: 'phone', label: '手机' },
  { id: 'phone-code', label: '手机验证码' },
  { id: 'password', label: '密码' },
];

function LoginForm(props: LoginFormProps) {
  const { capabilities, capabilityError, resumeConversation, initialMode = 'login', onModeChange, onCancelAuthentication, onLogin, onRegister } = props;
  const [mode, setMode] = useState<AuthMode>(initialMode);
  const [registrationStep, setRegistrationStep] = useState<RegistrationStep>('email');
  const [email, setEmail] = useState('');
  const [emailCode, setEmailCode] = useState('');
  const [emailDelivery, setEmailDelivery] = useState<RegistrationDelivery | null>(null);
  const [challengeId, setChallengeId] = useState('');
  const [phone, setPhone] = useState('');
  const [phoneCode, setPhoneCode] = useState('');
  const [phoneDelivery, setPhoneDelivery] = useState<RegistrationDelivery | null>(null);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [legacyRequired, setLegacyRequired] = useState(false);
  const [humanChallengeToken, setHumanChallengeToken] = useState('');
  const [turnstileResetNonce, setTurnstileResetNonce] = useState(0);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [clock, setClock] = useState(() => Date.now());
  const activeRequestRef = useRef<AbortController | null>(null);
  const operationGenerationRef = useRef(0);
  const registrationIdempotencyKeyRef = useRef('');
  const registrationAvailable = capabilities?.authentication.registrationEnabled === true;
  const migrationOnly = !registrationAvailable && capabilities?.authentication.legacyMigrationEnabled === true;
  const inviteRequired = capabilities?.authentication.inviteCodeRequired === true;
  const turnstileSiteKey = capabilities?.authentication.turnstileSiteKey?.trim() ?? '';
  const verificationMethods = capabilities?.authentication.verificationMethods;
  const verificationRequired = verificationMethods === undefined || verificationMethods.length > 0;
  const nativeRegistration = Boolean(getCodRuntime().hostPlatform) && verificationRequired;
  const publicRegistrationUrl = safePublicRegistrationUrl(capabilities?.authentication.publicRegistrationUrl);
  const registering = mode === 'register';
  const emailResendSeconds = secondsUntil(emailDelivery?.resendAt, clock);
  const phoneResendSeconds = secondsUntil(phoneDelivery?.resendAt, clock);
  const activeRegistrationIndex = registrationSteps.findIndex((step) => step.id === registrationStep);

  const cancelPendingRequest = () => {
    operationGenerationRef.current += 1;
    activeRequestRef.current?.abort(new DOMException('Authentication cancelled', 'AbortError'));
    activeRequestRef.current = null;
    setSubmitting(false);
  };

  useEffect(() => () => {
    operationGenerationRef.current += 1;
    activeRequestRef.current?.abort(new DOMException('Authentication dialog closed', 'AbortError'));
  }, []);

  useEffect(() => {
    const resendAt = registrationStep === 'email-code' ? emailDelivery?.resendAt : registrationStep === 'phone-code' ? phoneDelivery?.resendAt : undefined;
    if (!resendAt || secondsUntil(resendAt, Date.now()) === 0) return;
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [emailDelivery?.resendAt, phoneDelivery?.resendAt, registrationStep]);

  useEffect(() => {
    setHumanChallengeToken('');
    setTurnstileResetNonce((value) => value + 1);
  }, [registrationStep]);

  useEffect(() => {
    if (registrationAvailable || mode !== 'register') return;
    cancelPendingRequest();
    setMode('login');
    onModeChange?.('login');
  }, [mode, onModeChange, registrationAvailable]);

  const execute = async <T,>(operation: (signal: AbortSignal) => Promise<T>, fallback: string): Promise<T | null> => {
    cancelPendingRequest();
    const controller = new AbortController();
    const generation = ++operationGenerationRef.current;
    activeRequestRef.current = controller;
    setSubmitting(true);
    setError('');
    try {
      const result = await operation(controller.signal);
      if (controller.signal.aborted || operationGenerationRef.current !== generation) return null;
      return result;
    } catch (nextError) {
      if (controller.signal.aborted || operationGenerationRef.current !== generation || isTaskCancellation(nextError)) return null;
      if (nextError instanceof ApiError && nextError.code === 'legacy_migration_required') {
        setLegacyRequired(true);
        setError('');
        return null;
      }
      setError(nextError instanceof Error ? nextError.message : fallback);
      return null;
    } finally {
      if (operationGenerationRef.current === generation) {
        activeRequestRef.current = null;
        setSubmitting(false);
      }
    }
  };

  const resetRegistration = () => {
    setRegistrationStep('email');
    setEmailCode('');
    setEmailDelivery(null);
    setChallengeId('');
    setPhone('');
    setPhoneCode('');
    setPhoneDelivery(null);
    setPassword('');
    setConfirmPassword('');
    setInviteCode('');
    setHumanChallengeToken('');
    registrationIdempotencyKeyRef.current = '';
  };

  const switchMode = (next: AuthMode) => {
    cancelPendingRequest();
    onCancelAuthentication();
    setMode(next);
    onModeChange?.(next);
    setError('');
    setLegacyRequired(false);
    resetRegistration();
  };

  const consumeHumanChallenge = () => {
    const token = humanChallengeToken;
    setHumanChallengeToken('');
    setTurnstileResetNonce((value) => value + 1);
    return token;
  };

  const requireHumanChallenge = (): string | null => {
    if (!turnstileSiteKey) return '';
    if (humanChallengeToken) return humanChallengeToken;
    setError('请先完成人机验证。');
    return null;
  };

  const startEmailVerification = async () => {
    const captcha = requireHumanChallenge();
    if (captcha === null) return;
    const normalizedEmail = email.trim().toLowerCase();
    const delivery = await execute((signal) => startRegistrationEmail(normalizedEmail, captcha, signal), '邮箱验证码发送失败');
    if (turnstileSiteKey) consumeHumanChallenge();
    if (!delivery) return;
    setEmail(normalizedEmail);
    setChallengeId(delivery.challengeId);
    setEmailDelivery(delivery);
    setEmailCode('');
    setClock(Date.now());
    setRegistrationStep('email-code');
    registrationIdempotencyKeyRef.current = createClientId();
  };

  const resendEmailVerification = async () => {
    if (emailResendSeconds > 0) return;
    setRegistrationStep('email');
    setError('请完成人机验证后重新发送。');
  };

  const verifyEmailCode = async () => {
    const result = await execute((signal) => verifyRegistrationEmail(challengeId, email, emailCode, signal), '邮箱验证失败');
    if (!result?.verified) return;
    setRegistrationStep('phone');
  };

  const startPhoneVerification = async () => {
    const captcha = requireHumanChallenge();
    if (captcha === null) return;
    const normalizedPhone = phone.replace(/[\s()-]/g, '');
    if (!/^\+[1-9]\d{7,14}$/.test(normalizedPhone)) {
      setError('请使用带国家或地区码的手机号，例如 +8613800138000。');
      return;
    }
    const delivery = await execute((signal) => startRegistrationPhone(challengeId, email, normalizedPhone, captcha, signal), '手机验证码发送失败');
    if (turnstileSiteKey) consumeHumanChallenge();
    if (!delivery) return;
    setPhone(normalizedPhone);
    setChallengeId(delivery.challengeId);
    setPhoneDelivery(delivery);
    setPhoneCode('');
    setClock(Date.now());
    setRegistrationStep('phone-code');
    registrationIdempotencyKeyRef.current = createClientId();
  };

  const resendPhoneVerification = async () => {
    if (phoneResendSeconds > 0) return;
    setRegistrationStep('phone');
    setError('请完成人机验证后重新发送。');
  };

  const verifyPhoneCode = async () => {
    const result = await execute((signal) => verifyRegistrationPhone(challengeId, email, phone, phoneCode, signal), '手机验证失败');
    if (!result?.verified) return;
    setRegistrationStep('password');
  };

  const completeRegistration = async () => {
    if (password !== confirmPassword) {
      setError('两次输入的密码不一致');
      return;
    }
    if (!registrationIdempotencyKeyRef.current) registrationIdempotencyKeyRef.current = createClientId();
    await execute((signal) => onRegister({ challengeId, email, phone, password, inviteCode: inviteCode.trim() || undefined }, signal, registrationIdempotencyKeyRef.current), '注册失败');
  };

  const completeDirectRegistration = async () => {
    if (password !== confirmPassword) {
      setError('两次输入的密码不一致');
      return;
    }
    if (!registrationIdempotencyKeyRef.current) registrationIdempotencyKeyRef.current = createClientId();
    await execute((signal) => onRegister({ email: email.trim().toLowerCase(), password, inviteCode: inviteCode.trim() || undefined }, signal, registrationIdempotencyKeyRef.current), '注册失败');
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (mode === 'login') {
      await execute((signal) => onLogin(email.trim().toLowerCase(), password, signal), '登录失败');
      return;
    }
    if (!verificationRequired) { await completeDirectRegistration(); return; }
    if (nativeRegistration) return;
    if (registrationStep === 'email') { await startEmailVerification(); return; }
    if (registrationStep === 'email-code') { await verifyEmailCode(); return; }
    if (registrationStep === 'phone') { await startPhoneVerification(); return; }
    if (registrationStep === 'phone-code') { await verifyPhoneCode(); return; }
    await completeRegistration();
  };

  const changeEmail = () => {
    cancelPendingRequest();
    onCancelAuthentication();
    setError('');
    resetRegistration();
  };

  const changePhone = () => {
    cancelPendingRequest();
    onCancelAuthentication();
    setError('');
    setRegistrationStep('phone');
    setPhoneCode('');
    setPhoneDelivery(null);
    setPassword('');
    setConfirmPassword('');
    registrationIdempotencyKeyRef.current = createClientId();
  };

  const updateFinalCredential = (update: () => void) => {
    update();
    registrationIdempotencyKeyRef.current = createClientId();
  };

  if (!registrationAvailable || migrationOnly || legacyRequired) {
    const legacyCapabilities = legacyRequired && capabilities ? { ...capabilities, authentication: { ...capabilities.authentication, registrationEnabled: false, legacyMigrationEnabled: true } } : capabilities;
    return <LegacyLoginFormAdapter {...props} capabilities={legacyCapabilities} initialMode={legacyRequired ? 'register' : initialMode} />;
  }

  const primaryLabel = mode === 'login'
    ? resumeConversation ? '登录并继续' : '登录'
    : !verificationRequired ? resumeConversation ? '注册并继续' : '注册并领取试用金'
    : registrationStep === 'email' ? '发送邮箱验证码'
    : registrationStep === 'email-code' ? '验证邮箱'
    : registrationStep === 'phone' ? '发送手机验证码'
    : registrationStep === 'phone-code' ? '验证手机'
    : resumeConversation ? '注册并继续' : '注册并领取试用金';

  return <div className="login-form">
    <div className="auth-tabs" role="tablist">
      <button type="button" role="tab" aria-selected={mode === 'login'} className={mode === 'login' ? 'active' : ''} onClick={() => switchMode('login')}>密码登录</button>
      <button type="button" role="tab" aria-selected={registering} className={registering ? 'active' : ''} onClick={() => switchMode('register')}>注册账号</button>
    </div>
    <div className="login-copy">
      <span className="eyebrow">COD ACCOUNT</span>
      <h2>{resumeConversation ? `${mode === 'login' ? '登录' : '注册'}后继续对话` : mode === 'login' ? '登录 COD' : '注册 COD'}</h2>
      <p>{resumeConversation ? '你的消息已保留，认证成功后会自动发送。' : mode === 'login' ? '已有账号可直接登录，新账号可从上方注册。' : `${verificationRequired?'注册需同时验证邮箱和手机号。':'内测期间填写邮箱和密码即可注册。'}完成后获得 ¥10 试用金，有效期 30 天。${inviteRequired ? '需要有效邀请码。' : '邀请码选填。'}`}</p>
    </div>
    {registering && verificationRequired && !nativeRegistration && <ol className="registration-progress" aria-label="注册进度">
      {registrationSteps.map((step, index) => <li key={step.id} className={index < activeRegistrationIndex ? 'complete' : index === activeRegistrationIndex ? 'active' : ''} aria-current={index === activeRegistrationIndex ? 'step' : undefined}><span>{step.label}</span></li>)}
    </ol>}
    {capabilityError && <div className="notice error">{capabilityError}</div>}
    <form onSubmit={submit}>
      {mode === 'login' && <>
        <label>邮箱<input aria-label="邮箱" name="email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="username" required autoFocus /></label>
        <label>密码<input aria-label="密码" name="loginPassword" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" minLength={6} maxLength={128} required /></label>
      </>}
      {registering && !verificationRequired && <>
        <label>邮箱<input aria-label="邮箱" name="registrationEmail" type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" required autoFocus /></label>
        <label>设置密码<input aria-label="密码" name="newPassword" type="password" value={password} onChange={(event) => updateFinalCredential(() => setPassword(event.target.value))} autoComplete="new-password" minLength={6} maxLength={128} required /></label>
        <label>确认密码<input aria-label="确认密码" name="confirmPassword" type="password" value={confirmPassword} onChange={(event) => updateFinalCredential(() => setConfirmPassword(event.target.value))} autoComplete="new-password" minLength={6} maxLength={128} required /></label>
        <label>邀请码 <small>{inviteRequired ? '必填' : '选填'}</small><input aria-label="邀请码" name="inviteCode" value={inviteCode} onChange={(event) => updateFinalCredential(() => setInviteCode(event.target.value.toUpperCase()))} autoComplete="off" maxLength={32} placeholder="例如 KAI-XXXXXXXXXX" required={inviteRequired} /></label>
        <p className="password-hint">密码须为 6-128 位，并同时包含字母和数字。内测期间暂不要求邮箱或手机验证码。</p>
      </>}
      {registering && nativeRegistration && <div className="native-registration-handoff"><ShieldCheck weight="bold" /><div><strong>请先在网页完成注册</strong><p>邮箱、手机验证需在安全网页中完成。注册后回到 App 使用邮箱密码登录。</p>{!publicRegistrationUrl && <p className="native-registration-unavailable">注册地址暂未下发，请稍后刷新。</p>}</div>{publicRegistrationUrl && <button type="button" className="primary-button" onClick={() => void openCodExternalUrl(publicRegistrationUrl)}><ArrowSquareOut /> 打开网页注册</button>}</div>}
      {registering && verificationRequired && !nativeRegistration && registrationStep === 'email' && <>
        <label>邮箱<input aria-label="邮箱" name="registrationEmail" type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" required autoFocus /></label>
        {turnstileSiteKey && <TurnstileWidget siteKey={turnstileSiteKey} action="cod_registration_email" resetNonce={turnstileResetNonce} onToken={setHumanChallengeToken} onError={setError} />}
      </>}
      {registering && verificationRequired && !nativeRegistration && registrationStep === 'email-code' && <>
        <button type="button" className="auth-step-back" onClick={changeEmail} disabled={submitting}>更换邮箱</button>
        <label>邮箱验证码<input key="email-code" className="verification-code-input" aria-label="邮箱验证码" name="emailCode" value={emailCode} onChange={(event) => setEmailCode(event.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required autoFocus /></label>
        <div className="verification-delivery" aria-live="polite"><span>验证码已发送至 <strong>{emailDelivery?.maskedDestination}</strong></span><button type="button" onClick={() => void resendEmailVerification()} disabled={submitting || emailResendSeconds > 0}>{emailResendSeconds > 0 ? `重新发送 (${emailResendSeconds}s)` : '重新发送'}</button></div>
      </>}
      {registering && verificationRequired && !nativeRegistration && registrationStep === 'phone' && <>
        <button type="button" className="auth-step-back" onClick={changeEmail} disabled={submitting}>更换邮箱</button>
        <div className="verified-destination"><Check weight="bold" /><span>邮箱已验证<strong>{email}</strong></span></div>
        <label>手机号 <small>请包含国家或地区码</small><input aria-label="手机号" name="phone" type="tel" value={phone} onChange={(event) => setPhone(event.target.value)} inputMode="tel" autoComplete="tel" placeholder="+8613800138000" maxLength={24} required autoFocus /></label>
        {turnstileSiteKey && <TurnstileWidget siteKey={turnstileSiteKey} action="cod_registration_phone" resetNonce={turnstileResetNonce} onToken={setHumanChallengeToken} onError={setError} />}
      </>}
      {registering && verificationRequired && !nativeRegistration && registrationStep === 'phone-code' && <>
        <button type="button" className="auth-step-back" onClick={changePhone} disabled={submitting}>更换手机号</button>
        <label>手机验证码<input key="phone-code" className="verification-code-input" aria-label="手机验证码" name="phoneCode" value={phoneCode} onChange={(event) => setPhoneCode(event.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required autoFocus /></label>
        <div className="verification-delivery" aria-live="polite"><span>验证码已发送至 <strong>{phoneDelivery?.maskedDestination}</strong></span><button type="button" onClick={() => void resendPhoneVerification()} disabled={submitting || phoneResendSeconds > 0}>{phoneResendSeconds > 0 ? `重新发送 (${phoneResendSeconds}s)` : '重新发送'}</button></div>
      </>}
      {registering && verificationRequired && !nativeRegistration && registrationStep === 'password' && <>
        <button type="button" className="auth-step-back" onClick={changePhone} disabled={submitting}>更换手机号</button>
        <div className="verified-destination"><Check weight="bold" /><span>邮箱和手机号已验证<strong>{email}<i>{phone}</i></strong></span></div>
        <label>设置密码<input aria-label="密码" name="newPassword" type="password" value={password} onChange={(event) => updateFinalCredential(() => setPassword(event.target.value))} autoComplete="new-password" minLength={6} maxLength={128} required autoFocus /></label>
        <label>确认密码<input aria-label="确认密码" name="confirmPassword" type="password" value={confirmPassword} onChange={(event) => updateFinalCredential(() => setConfirmPassword(event.target.value))} autoComplete="new-password" minLength={6} maxLength={128} required /></label>
        <label>邀请码 <small>{inviteRequired ? '必填' : '选填'}</small><input aria-label="邀请码" name="inviteCode" value={inviteCode} onChange={(event) => updateFinalCredential(() => setInviteCode(event.target.value.toUpperCase()))} autoComplete="off" maxLength={32} placeholder="例如 KAI-XXXXXXXXXX" required={inviteRequired} /></label>
        <p className="password-hint">密码须为 6-128 位，并同时包含字母和数字。邀请关系注册后不可自行更改。</p>
      </>}
      {error && <div className="notice error" role="alert">{error}</div>}
      {!nativeRegistration || mode === 'login' ? <button type="submit" className="primary-button" disabled={submitting}>{submitting ? <CircleNotch className="spin" /> : <Key />} {primaryLabel}</button> : null}
    </form>
    <div className="capability-summary"><span className={capabilities?.ai.mode === 'live' ? 'live' : 'demo'}>模型：{capabilities?.ai.mode === 'live' ? '已连接' : capabilities?.ai.mode === 'demo' ? '演示模式' : '待检测'}</span><span>认证：{registering ? verificationRequired?'邮箱 + 手机验证码':'邮箱密码（内测）' : 'COD 邮箱密码'}</span></div>
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

function ComputeMarket({ offers, requests, signedIn, draft, onDraftChange, onLogin, onSubmit, onQuoteDecision }: { offers: ComputeOffer[]; requests: ComputeRequest[]; signedIn: boolean; draft: ComputeDraft; onDraftChange: (draft: ComputeDraft) => void; onLogin: () => void; onSubmit: (input: ComputeRequestInput) => Promise<void>; onQuoteDecision: (request: ComputeRequest, decision: 'accepted' | 'declined') => Promise<void> }) {
  const [submitting, setSubmitting] = useState(false);
  const [decidingId, setDecidingId] = useState('');
  const [error, setError] = useState('');
  const {
    tab, offerId, imageId, company, contactName, contactPhone, city, gpuModel, quantity, durationHours, termMonths, requirements,
    hostingPeriodMonths, rackUnits, powerKilowatts, networkMbps, availabilityNotes, settlementPreference, hostingRequirements,
  } = draft;
  const updateDraft = (next: Partial<ComputeDraft>) => onDraftChange({ ...draft, ...next });
  const selectedOffer = offers.find((offer) => offer.id === offerId) ?? offers[0];
  const unitLabel: Record<ComputeOffer['priceUnit'], string> = { 'card-hour': '卡时', 'server-hour': '整机时', month: '月', quote: '询价' };
  const statusLabel: Record<ComputeRequest['status'], string> = { submitted: '已提交', contacting: '联系中', quoted: '待确认报价', approved: '已确认', deploying: '部署中', running: '运行中', action_required: '待处理', completed: '已完成', closed: '已关闭' };
  const requestKindLabel: Record<ComputeRequestInput['kind'], string> = { rental: '算力租赁', supply: '供方上架', hosting: '第三方托管', installment: '显卡分期' };
  const formTitle: Record<ComputeRequestInput['kind'], string> = { rental: '提交租赁需求', supply: '成为算力供方', hosting: '申请第三方机房托管', installment: '申请设备融资方案' };
  const formSummary: Record<ComputeRequestInput['kind'], string> = {
    rental: '确认库存与交付环境后出具正式报价',
    supply: '机房、卡况、网络与产权核验通过后上架',
    hosting: '提交设备参数后，由 COD 记录需求并匹配第三方托管商',
    installment: 'COD 仅撮合申请，不自行授信或放款',
  };
  const requirementsPlaceholder: Record<Exclude<ComputeRequestInput['kind'], 'hosting'>, string> = {
    rental: '训练框架、镜像、存储、带宽、开始时间…',
    supply: '机房位置、卡况、服务器配置、可售时段…',
    installment: '设备配置、预算、首付能力、发票与交付要求…',
  };
  const chooseOffer = (offer: ComputeOffer) => updateDraft({ tab: 'rental', offerId: offer.id, imageId: offer.images?.[0]?.id ?? '', gpuModel: offer.gpuModel, quantity: offer.gpuCount, durationHours: offer.minimumUnits });
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!signedIn) { onLogin(); return; }
    if (tab === 'hosting' && !rackUnits && !powerKilowatts && !networkMbps && !availabilityNotes.trim()) {
      setError('请填写机架空间、预计功耗、所需带宽中的至少一项，或补充设备与可用条件。');
      return;
    }
    setSubmitting(true); setError('');
    try {
      await onSubmit({
        kind: tab,
        offerId: tab === 'rental' ? selectedOffer?.id ?? null : null,
        imageId: tab === 'rental' ? imageId || selectedOffer?.images?.[0]?.id || null : null,
        company,
        contactName,
        contactPhone,
        city,
        gpuModel,
        quantity,
        durationHours: tab === 'rental' ? durationHours : null,
        termMonths: tab === 'installment' ? termMonths : null,
        requirements: tab === 'hosting' ? hostingRequirements : requirements,
        ...(tab === 'hosting' ? {
          hostingPeriodMonths,
          rackUnits: rackUnits || null,
          powerKilowatts: powerKilowatts || null,
          networkMbps: networkMbps || null,
          availabilityNotes,
          settlementPreference,
          hostingRequirements,
        } : {}),
      });
      updateDraft({ requirements: '', rackUnits: 0, powerKilowatts: 0, networkMbps: 0, availabilityNotes: '', hostingRequirements: '' });
    } catch (nextError) { setError(nextError instanceof Error ? nextError.message : '提交失败，请稍后重试'); }
    finally { setSubmitting(false); }
  };
  const decideQuote = async (request: ComputeRequest, decision: 'accepted' | 'declined') => {
    if (decidingId) return;setDecidingId(request.id);setError('');
    try { await onQuoteDecision(request, decision); }
    catch (nextError) { setError(nextError instanceof Error ? nextError.message : '报价处理失败，请刷新后重试'); }
    finally { setDecidingId(''); }
  };
  const assetCount=requests.filter((request)=>['approved','deploying','running','action_required','completed'].includes(request.status)).length;
  const hostedCount=requests.filter((request)=>['hosting','supply'].includes(request.kind)&&['approved','deploying','running','action_required'].includes(request.status)).length;
  const rentalCount=requests.filter((request)=>request.kind==='rental'&&['deploying','running','action_required'].includes(request.status)).length;
  return <div className="compute-market">
    <section className="compute-hero"><div><span className="eyebrow">COD COMPUTE EXCHANGE</span><h2>让 GPU 找到合适的使用方式</h2><p>租用算力、上架闲置卡、申请第三方机房托管或设备分期。所有方案先核验设备、网络与交付条件，再由相关方确认合同。</p></div><div className="compute-hero-metrics"><span><strong>H100</strong><small>机房直供</small></span><span><strong>托管</strong><small>第三方撮合</small></span><span><strong>SLA</strong><small>签约前确认</small></span></div></section>
    <section className="compute-deal"><nav aria-label="算力业务类型"><button type="button" className={tab === 'rental' ? 'active' : ''} aria-pressed={tab === 'rental'} onClick={() => updateDraft({ tab: 'rental' })}><HardDrives />租算力</button><button type="button" className={tab === 'supply' ? 'active' : ''} aria-pressed={tab === 'supply'} onClick={() => updateDraft({ tab: 'supply' })}><Storefront />上架闲置卡</button><button type="button" className={tab === 'hosting' ? 'active' : ''} aria-pressed={tab === 'hosting'} onClick={() => updateDraft({ tab: 'hosting' })}><Buildings />第三方托管</button><button type="button" className={tab === 'installment' ? 'active' : ''} aria-pressed={tab === 'installment'} onClick={() => updateDraft({ tab: 'installment' })}><CreditCard />显卡分期</button></nav>{tab === 'rental' && <div className="compute-offers">{offers.map((offer) => <article className={selectedOffer?.id === offer.id ? 'selected' : ''} key={offer.id}><header><span className={offer.availability}>{offer.availability === 'ready' ? `参考规模 ${offer.inventoryCards ?? 0} 卡` : offer.availability === 'limited' ? `参考规模 ${offer.inventoryCards ?? 0} 卡` : '企业询价'}</span>{offer.verified && <i><ShieldCheck weight="fill" /> 配置已核验</i>}</header><HardDrives weight="duotone" /><h3>{offer.title}</h3><p>{offer.gpuModel} · {offer.gpuCount} 卡 · {offer.gpuMemoryGb}GB/卡</p><strong>{offer.priceCents === null ? '企业询价' : `¥${(offer.priceCents / 100).toFixed(2)}`}<small>{offer.priceCents === null ? '' : ` / ${unitLabel[offer.priceUnit]}起`}</small></strong><dl><div><dt>CPU</dt><dd>{offer.specs?.cpuModel ?? '成交前确认'}{offer.specs?.cpuCores ? ` · ${offer.specs?.cpuCores} 核` : ''}</dd></div><div><dt>内存</dt><dd>{offer.specs?.memoryGb ? `${offer.specs?.memoryGb} GB` : '成交前确认'}</dd></div><div><dt>磁盘</dt><dd>{offer.specs?.systemDiskGb ? `${offer.specs?.systemDiskGb} GB 系统盘 + ${offer.specs?.dataDiskGb} GB 数据盘` : '成交前确认'}</dd></div><div><dt>环境</dt><dd>驱动 {offer.specs?.driverVersion ?? '待确认'} · CUDA {offer.specs?.cudaMaxVersion ?? '待确认'}</dd></div><div><dt>区域</dt><dd>{offer.region}</dd></div><div><dt>交付</dt><dd>{offer.delivery}</dd></div></dl><footer>{offer.tags.map((tag) => <span key={tag}>{tag}</span>)}</footer><button type="button" onClick={() => chooseOffer(offer)}>查看配置并预约</button></article>)}</div>}<form onSubmit={submit} noValidate={!signedIn}>
      <div className="compute-form-head"><div>{tab === 'rental' ? <HardDrives /> : tab === 'supply' ? <Storefront /> : tab === 'hosting' ? <Buildings /> : <Handshake />}</div><span><strong>{formTitle[tab]}</strong><small>{formSummary[tab]}</small></span></div>
      {tab === 'hosting' && <ol className="compute-hosting-flow compute-wide" aria-label="第三方托管办理流程"><li><strong>提交设备信息</strong><small>COD 记录需求并匹配托管商</small></li><li><strong>托管商初筛</strong><small>确认机位、电力、网络与档期</small></li><li><strong>现场验机签约</strong><small>双方验收设备并签署机房合同</small></li><li><strong>上线与结算</strong><small>双方确认 SLA、保险和账期</small></li></ol>}
      {tab === 'rental' && <><label className="compute-wide">算力商品<select aria-label="算力商品" value={selectedOffer?.id ?? ''} onChange={(event) => { const offer = offers.find((item) => item.id === event.target.value); if (offer) chooseOffer(offer); }}>{offers.map((offer) => <option key={offer.id} value={offer.id}>{offer.title} · {offer.priceCents === null ? '询价' : `¥${(offer.priceCents / 100).toFixed(2)}/${unitLabel[offer.priceUnit]}`}</option>)}</select></label>{selectedOffer && <section className="compute-configurator compute-wide" aria-label="租赁配置"><header><strong>选择镜像</strong><small>下单前仍由交付人员复核版本与驱动兼容性</small></header><div className="compute-image-options">{(selectedOffer.images ?? []).map((image) => <button type="button" className={(imageId || selectedOffer.images?.[0]?.id)===image.id?'active':''} aria-pressed={(imageId || selectedOffer.images?.[0]?.id)===image.id} key={image.id} onClick={()=>updateDraft({imageId:image.id})}><strong>{image.name} {image.frameworkVersion}</strong><small>Python {image.pythonVersion} · CUDA {image.cudaVersion}</small></button>)}</div><div className="compute-periods"><span>支持周期</span>{(selectedOffer.supportedPeriods ?? []).map((period)=><i key={period}>{period==='hour'?'按时':period==='day'?'按天':'按月'}</i>)}<b>{selectedOffer.inventoryCards===null?'可用资源成交前确认':`最高 ${selectedOffer.inventoryCards} 卡可申请 · 最终人工确认`}</b></div></section>}</>}
      <label>公司 / 团队<input aria-label="公司或团队" value={company} onChange={(event) => updateDraft({ company: event.target.value })} required minLength={2} maxLength={120} placeholder="公司或团队名称" autoComplete="organization" /></label><label>联系人<input aria-label="联系人" value={contactName} onChange={(event) => updateDraft({ contactName: event.target.value })} required maxLength={60} autoComplete="name" /></label><label>手机 / 微信<input aria-label="手机或微信" value={contactPhone} onChange={(event) => updateDraft({ contactPhone: event.target.value })} required pattern={String.raw`(?:[0-9+\(\)\-\s]{6,40}|[A-Za-z][A-Za-z0-9_\-]{5,39})`} placeholder="手机号或微信号" autoComplete="tel" /></label><label>所在城市<input aria-label="所在城市" value={city} onChange={(event) => updateDraft({ city: event.target.value })} required maxLength={80} autoComplete="address-level2" /></label>
      <label>GPU 型号<input aria-label="GPU 型号" value={gpuModel} onChange={(event) => updateDraft({ gpuModel: event.target.value })} required maxLength={100} /></label><label>卡数<input aria-label="卡数" type="number" min={1} max={4096} value={quantity} onChange={(event) => updateDraft({ quantity: Number(event.target.value) })} required /></label>{tab === 'rental' && <label>预计卡时<input aria-label="预计卡时" type="number" min={1} max={1000000} value={durationHours} onChange={(event) => updateDraft({ durationHours: Number(event.target.value) })} required /></label>}{tab === 'installment' && <label>期数<select aria-label="分期期数" value={termMonths} onChange={(event) => updateDraft({ termMonths: Number(event.target.value) })}><option value={12}>12 个月</option><option value={24}>24 个月</option><option value={36}>36 个月</option></select></label>}
      {tab === 'hosting' && <><label>托管周期<select aria-label="托管周期" value={hostingPeriodMonths} onChange={(event) => updateDraft({ hostingPeriodMonths: Number(event.target.value) })}><option value={1}>1 个月</option><option value={3}>3 个月</option><option value={6}>6 个月</option><option value={12}>12 个月</option><option value={24}>24 个月</option></select></label><label>机架空间 <small>选填</small><input aria-label="机架空间" type="number" min={1} max={256} value={rackUnits || ''} onChange={(event) => updateDraft({ rackUnits: Number(event.target.value) })} placeholder="U 数" inputMode="numeric" /></label><label>预计功耗 <small>选填</small><span className="compute-input-unit"><input aria-label="预计功耗" type="number" min={0.1} max={1000} step={0.1} value={powerKilowatts || ''} onChange={(event) => updateDraft({ powerKilowatts: Number(event.target.value) })} placeholder="例如 6.5" inputMode="decimal" /><i>kW</i></span></label><label>所需带宽 <small>选填</small><span className="compute-input-unit"><input aria-label="所需带宽" type="number" min={1} max={1000000} value={networkMbps || ''} onChange={(event) => updateDraft({ networkMbps: Number(event.target.value) })} placeholder="例如 1000" inputMode="numeric" /><i>Mbps</i></span></label><label className="compute-wide">设备与可用条件 <small>参数不全时必填</small><textarea aria-label="设备与可用条件" value={availabilityNotes} onChange={(event) => updateDraft({ availabilityNotes: event.target.value })} required={!rackUnits && !powerKilowatts && !networkMbps} maxLength={1000} placeholder="服务器形态、整机尺寸、当前供电与网络接口、可进场时间；不清楚精确参数时可注明待现场确认。" /></label><label className="compute-wide">期望结算方式<select aria-label="期望结算方式" value={settlementPreference} onChange={(event) => updateDraft({ settlementPreference: event.target.value })} required><option>固定托管费（月结）</option><option>算力收益分成（月结）</option><option>保底费用 + 收益分成</option><option>托管商报价后确认</option></select></label><label className="compute-wide">机房与服务要求<textarea aria-label="机房与服务要求" value={hostingRequirements} onChange={(event) => updateDraft({ hostingRequirements: event.target.value })} required maxLength={2000} placeholder="城市范围、机房等级、温湿度、门禁监控、保险、远程运维和 SLA 要求。" /></label></>}
      {tab !== 'hosting' && <label className="compute-wide">需求说明<textarea aria-label="需求说明" value={requirements} onChange={(event) => updateDraft({ requirements: event.target.value })} maxLength={2000} placeholder={requirementsPlaceholder[tab]} /></label>}
      {tab === 'hosting' && <div className="compute-compliance compute-hosting-responsibility compute-wide" role="note"><ShieldCheck /> <span><strong>第三方托管责任边界</strong>COD 仅提供需求撮合与过程记录，不接收或保管设备，也不代签合同或代为结算。设备验收、机房合同、SLA、保险和费用结算，须由你与第三方托管商书面确认。</span></div>}{tab === 'installment' && <div className="compute-compliance compute-wide"><ShieldCheck /> 融资租赁申请将由具备相应资质的合作机构独立审核并签署书面合同；提交申请不代表授信通过。</div>}{error && <div className="notice error compute-wide">{error}</div>}{signedIn ? <button type="submit" className="primary-button compute-wide" disabled={submitting}>{submitting ? <CircleNotch className="spin" /> : <PaperPlaneTilt weight="fill" />}{tab === 'hosting' ? '提交托管需求' : '提交并等待报价'}</button> : <button type="button" className="primary-button compute-wide" onClick={onLogin}><Key /> {tab === 'hosting' ? '登录后提交托管需求' : '登录后提交需求'}</button>}
    </form></section>
    {requests.length > 0 && <section className="compute-requests"><header><strong>我的算力</strong><small>报价由你确认，确认后才进入交付</small></header><div className="compute-asset-summary"><span><small>我的资产</small><strong>{assetCount}</strong></span><span><small>托管设备</small><strong>{hostedCount}</strong></span><span><small>设备租赁</small><strong>{rentalCount}</strong></span></div>{requests.map((request) => <article key={request.id}><div className="compute-request-line"><span><strong>{requestKindLabel[request.kind]} · {request.gpuModel}</strong><small>{request.quantity} 卡{request.durationHours ? ` · ${request.durationHours} 卡时` : ''}{request.termMonths ? ` · ${request.termMonths} 个月` : ''}{request.hostingPeriodMonths ? ` · 托管 ${request.hostingPeriodMonths} 个月` : ''} · {formatTime(request.createdAt)}</small></span><i className={request.status}>{statusLabel[request.status]}</i></div>{request.quote&&<div className="compute-quote"><span><small>COD 报价</small><strong>¥{(request.quote.amountCents/100).toFixed(2)}</strong>{request.quote.cardHoursMilli!==null&&<small>{(request.quote.cardHoursMilli/1000).toFixed(3)} 卡时</small>}</span><p>{request.quote.terms}<small>有效至 {formatAdminDate(request.quote.validUntil)}</small></p>{request.status==='quoted'?<div><button type="button" className="secondary" disabled={decidingId===request.id||new Date(request.quote.validUntil).getTime()<=Date.now()} onClick={()=>void decideQuote(request,'declined')}>拒绝报价</button><button type="button" disabled={decidingId===request.id||new Date(request.quote.validUntil).getTime()<=Date.now()} onClick={()=>void decideQuote(request,'accepted')}>{decidingId===request.id?<CircleNotch className="spin"/>:<Check weight="bold"/>}确认报价</button></div>:request.quoteDecision&&<b>{request.quoteDecision==='accepted'?'已由你确认':'已由你拒绝'}</b>}</div>}</article>)}</section>}
  </div>;
}

const computeKindLabels: Record<ComputeRequest['kind'], string> = {
  rental: '算力租赁', supply: '供方上架', hosting: '第三方托管', installment: '显卡分期',
};
const computeStatusLabels: Record<ComputeRequest['status'], string> = {
  submitted: '已提交', contacting: '联系中', quoted: '待确认报价', approved: '已确认', deploying: '部署中', running: '运行中', action_required: '待用户处理', completed: '已完成', closed: '已关闭',
};
const computeStatusTransitions: Record<ComputeRequest['status'], ComputeRequest['status'][]> = {
  submitted: ['contacting', 'closed'], contacting: ['closed'], quoted: ['closed'], approved: ['deploying', 'action_required', 'closed'], deploying: ['running', 'action_required', 'closed'], running: ['completed', 'action_required', 'closed'], action_required: ['deploying', 'running', 'closed'], completed: [], closed: [],
};

function summarizeAdminComputeRequest(request: ComputeRequest): AdminComputeRequestSummary {
  const { id, kind, company, gpuModel, quantity, status, createdAt, updatedAt } = request;
  return { id, kind, company, gpuModel, quantity, status, createdAt, updatedAt };
}

function formatAdminDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(date);
}

function AdminComputeRequestDetail({ request, onUpdate, onQuote }: { request: ComputeRequest; onUpdate: (id: string, status: ComputeRequest['status'], expectedStatus: ComputeRequest['status']) => Promise<ComputeRequest>; onQuote: (id: string, quote: { amountCents: number; cardHoursMilli: number | null; validUntil: string; terms: string }, expectedStatus: ComputeRequest['status']) => Promise<ComputeRequest> }) {
  const [nextStatus, setNextStatus] = useState<ComputeRequest['status']>(request.status);
  const [updating, setUpdating] = useState(false);
  const [error, setError] = useState('');
  const [copyFeedback, setCopyFeedback] = useState<{ field: 'email' | 'contact' | ''; message: string }>({ field: '', message: '' });
  const [quoteAmount, setQuoteAmount] = useState('');
  const [quoteCardHours, setQuoteCardHours] = useState(request.durationHours ? String(request.durationHours) : '');
  const [quoteValidityDays, setQuoteValidityDays] = useState(7);
  const [quoteTerms, setQuoteTerms] = useState('库存、设备配置与交付时间以双方最终确认的书面订单为准。');
  const availableStatuses = computeStatusTransitions[request.status];
  useEffect(() => { setNextStatus(request.status); setError(''); setCopyFeedback({ field: '', message: '' }); }, [request.id, request.status]);
  const updateStatus = async (event: FormEvent) => {
    event.preventDefault();
    if (nextStatus === request.status || updating) return;
    setUpdating(true); setError('');
    try {
      const updated = await onUpdate(request.id, nextStatus, request.status);
      setNextStatus(updated.status);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '状态更新失败，请稍后重试。');
    } finally { setUpdating(false); }
  };
  const submitQuote = async (event: FormEvent) => {
    event.preventDefault();if(updating)return;const amount=Number(quoteAmount);const hours=quoteCardHours.trim()?Number(quoteCardHours):null;
    if(!Number.isFinite(amount)||amount<1){setError('请填写不少于 ¥1.00 的报价金额。');return;}
    if(hours!==null&&(!Number.isFinite(hours)||hours<=0)){setError('卡时必须大于 0。');return;}
    setUpdating(true);setError('');
    try { await onQuote(request.id,{amountCents:Math.round(amount*100),cardHoursMilli:hours===null?null:Math.round(hours*1000),validUntil:new Date(Date.now()+quoteValidityDays*86400000).toISOString(),terms:quoteTerms.trim()},request.status); }
    catch(nextError){setError(nextError instanceof Error?nextError.message:'报价发送失败，请稍后重试。');}
    finally{setUpdating(false);}
  };
  const value = (next: string | number | null | undefined, suffix = '') => next === null || next === undefined || next === '' ? '暂无' : `${next}${suffix}`;
  const copyContact = async (field: 'email' | 'contact', label: string, content: string) => {
    try {
      const copied = await copyCodText(content);
      setCopyFeedback({ field: copied ? field : '', message: copied ? `${label}已复制。` : `当前环境不能自动复制${label}。` });
    } catch { setCopyFeedback({ field: '', message: `${label}复制失败，请重试。` }); }
  };
  return <article className="admin-compute-detail" aria-label={`${request.company}的算力申请详情`}>
    <header><div><span className="eyebrow">REQUEST DETAIL</span><h3>{computeKindLabels[request.kind]} · {request.gpuModel}</h3><p>{request.company} · {request.email}</p></div><i className={request.status}>{computeStatusLabels[request.status]}</i></header>
    <section><h4>用户与联系信息</h4><dl className="admin-compute-fields"><div><dt>申请账号</dt><dd className="admin-contact-value"><span>{request.email}</span><button type="button" aria-label="复制申请邮箱" onClick={() => void copyContact('email', '申请邮箱', request.email)}>{copyFeedback.field === 'email' ? <Check weight="bold" /> : <Copy />}{copyFeedback.field === 'email' ? '已复制' : '复制'}</button></dd></div><div><dt>公司 / 团队</dt><dd>{value(request.company)}</dd></div><div><dt>联系人</dt><dd>{value(request.contactName)}</dd></div><div><dt>手机 / 微信</dt><dd className="admin-contact-value"><span>{value(request.contactPhone)}</span><button type="button" aria-label="复制手机或微信" onClick={() => void copyContact('contact', '手机或微信', request.contactPhone)}>{copyFeedback.field === 'contact' ? <Check weight="bold" /> : <Copy />}{copyFeedback.field === 'contact' ? '已复制' : '复制'}</button></dd></div><div><dt>所在城市</dt><dd>{value(request.city)}</dd></div></dl>{copyFeedback.message && <p className="admin-copy-feedback" role="status" aria-live="polite">{copyFeedback.message}</p>}</section>
    <section><h4>算力与设备信息</h4><dl className="admin-compute-fields"><div><dt>业务类型</dt><dd>{computeKindLabels[request.kind]}</dd></div><div><dt>GPU 型号</dt><dd>{value(request.gpuModel)}</dd></div><div><dt>卡数</dt><dd>{value(request.quantity, ' 卡')}</dd></div><div><dt>预计卡时</dt><dd>{value(request.durationHours, ' 卡时')}</dd></div><div><dt>分期期数</dt><dd>{value(request.termMonths, ' 个月')}</dd></div><div><dt>托管周期</dt><dd>{value(request.hostingPeriodMonths, ' 个月')}</dd></div><div><dt>机架空间</dt><dd>{value(request.rackUnits, ' U')}</dd></div><div><dt>预计功耗</dt><dd>{value(request.powerKilowatts, ' kW')}</dd></div><div><dt>所需带宽</dt><dd>{value(request.networkMbps, ' Mbps')}</dd></div><div><dt>交付方式</dt><dd>{request.fulfillmentMode === 'third-party-manual-match' ? '第三方人工撮合' : '人工确认'}</dd></div><div><dt>商品 ID</dt><dd>{value(request.offerId)}</dd></div></dl></section>
    <section><h4>补充需求</h4><dl className="admin-compute-fields admin-compute-notes"><div><dt>设备与可用条件</dt><dd>{value(request.availabilityNotes)}</dd></div><div><dt>期望结算方式</dt><dd>{value(request.settlementPreference)}</dd></div><div><dt>需求说明</dt><dd>{value(request.requirements)}</dd></div><div><dt>机房与服务要求</dt><dd>{value(request.hostingRequirements)}</dd></div></dl></section>
    {request.quote&&<section className="admin-compute-quote-summary"><h4>已发送报价</h4><dl className="admin-compute-fields"><div><dt>总价</dt><dd>¥{(request.quote.amountCents/100).toFixed(2)}</dd></div><div><dt>卡时</dt><dd>{request.quote.cardHoursMilli===null?'不适用':`${(request.quote.cardHoursMilli/1000).toFixed(3)} 卡时`}</dd></div><div><dt>有效期</dt><dd>{formatAdminDate(request.quote.validUntil)}</dd></div><div><dt>用户决定</dt><dd>{request.quoteDecision==='accepted'?'已接受':request.quoteDecision==='declined'?'已拒绝':'等待确认'}</dd></div></dl><p>{request.quote.terms}</p></section>}
    <section><h4>记录信息</h4><dl className="admin-compute-fields"><div><dt>申请 ID</dt><dd className="mono">{request.id}</dd></div><div><dt>提交时间</dt><dd>{formatAdminDate(request.createdAt)}</dd></div><div><dt>最后更新</dt><dd>{formatAdminDate(request.updatedAt)}</dd></div></dl></section>
    {request.status==='contacting'&&<form className="admin-compute-quote-form" onSubmit={submitQuote}><div><strong>向用户发送报价</strong><small>发送后必须由用户本人接受，管理员不能代确认。</small></div><label>报价金额（元）<input aria-label="报价金额" type="number" min="1" max="10000000" step="0.01" value={quoteAmount} onChange={(event)=>setQuoteAmount(event.target.value)} required /></label><label>包含卡时 <small>非租赁可留空</small><input aria-label="报价卡时" type="number" min="0.001" step="0.001" value={quoteCardHours} onChange={(event)=>setQuoteCardHours(event.target.value)} /></label><label>有效期<select aria-label="报价有效期" value={quoteValidityDays} onChange={(event)=>setQuoteValidityDays(Number(event.target.value))}><option value={3}>3 天</option><option value={7}>7 天</option><option value={14}>14 天</option><option value={30}>30 天</option></select></label><label className="wide">报价条款<textarea aria-label="报价条款" minLength={2} maxLength={2000} value={quoteTerms} onChange={(event)=>setQuoteTerms(event.target.value)} required /></label><button type="submit" disabled={updating}>{updating?<CircleNotch className="spin"/>:<PaperPlaneTilt weight="fill"/>}发送报价</button>{error&&<div className="notice error" role="alert">{error}</div>}</form>}
    <form className="admin-compute-status" onSubmit={updateStatus}><div><strong>处理状态</strong><small>状态只可按业务流程向前推进，关闭后不可恢复。</small></div>{availableStatuses.length ? <><label>下一状态<select aria-label="算力申请状态" value={nextStatus} disabled={updating} onChange={(event) => { const status=event.target.value as ComputeRequest['status'];if(status===request.status||availableStatuses.includes(status))setNextStatus(status); }}><option value={request.status}>{computeStatusLabels[request.status]}（当前）</option>{availableStatuses.map((status) => <option value={status} key={status}>{computeStatusLabels[status]}</option>)}</select></label><button type="submit" disabled={updating || nextStatus === request.status || !availableStatuses.includes(nextStatus)}>{updating ? <CircleNotch className="spin" /> : <Check weight="bold" />}{nextStatus === request.status || !availableStatuses.includes(nextStatus) ? '选择下一状态' : `更新为${computeStatusLabels[nextStatus]}`}</button></> : <span className="admin-compute-final">该申请已结束</span>}{error && <div className="notice error" role="alert">{error}</div>}</form>
  </article>;
}

function AdminComputeRequests({ token }: { token: string }) {
  const [requests, setRequests] = useState<AdminComputeRequestSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [kind, setKind] = useState<ComputeRequest['kind'] | 'all'>('all');
  const [status, setStatus] = useState<ComputeRequest['status'] | 'all'>('all');
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [listVersion, setListVersion] = useState(0);
  const [detail, setDetail] = useState<ComputeRequest | null>(null);
  const [detailTargetId, setDetailTargetId] = useState('');
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [mutationError, setMutationError] = useState('');
  const [detailReloadKey, setDetailReloadKey] = useState(0);
  const requestGenerationRef = useRef(0);
  const detailGenerationRef = useRef(0);
  const invalidatePendingPages = () => { requestGenerationRef.current += 1; setLoadingMore(false); };
  const reloadRequests = () => { invalidatePendingPages(); setReloadKey((current) => current + 1); };
  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedQuery(query.trim()), 300);
    return () => window.clearTimeout(timeout);
  }, [query]);
  useEffect(() => {
    let active = true;
    const generation = ++requestGenerationRef.current;
    setLoading(true); setLoadingMore(false); setError('');
    listAdminComputeRequests(token, { kind: kind === 'all' ? undefined : kind, status: status === 'all' ? undefined : status, q: debouncedQuery || undefined }).then((page) => {
      if (!active || generation !== requestGenerationRef.current) return;
      setRequests(page.items); setNextCursor(page.nextCursor); setSelectedId((current) => page.items.some((item) => item.id === current) ? current : page.items[0]?.id ?? ''); setListVersion((current) => current + 1);
    }).catch((nextError) => {
      if (!active || generation !== requestGenerationRef.current) return;
      setRequests([]); setNextCursor(null); setError(nextError instanceof Error ? nextError.message : '算力申请加载失败，请稍后重试。');
    }).finally(() => { if (active && generation === requestGenerationRef.current) setLoading(false); });
    return () => { active = false; };
  }, [debouncedQuery, kind, reloadKey, status, token]);
  const selectedRequest = requests.find((request) => request.id === selectedId) ?? requests[0] ?? null;
  const selectedRequestId = selectedRequest?.id ?? '';
  useEffect(() => {
    if (!selectedRequestId) { setDetail(null); setDetailTargetId(''); setDetailLoading(false); setDetailError(''); return; }
    let active = true;
    const generation = ++detailGenerationRef.current;
    setDetailTargetId(selectedRequestId); setDetail(null); setDetailLoading(true); setDetailError('');
    getAdminComputeRequest(token, selectedRequestId).then((nextDetail) => {
      if (!active || generation !== detailGenerationRef.current || nextDetail.id !== selectedRequestId) return;
      setDetail(nextDetail);
    }).catch((nextError) => {
      if (!active || generation !== detailGenerationRef.current) return;
      setDetailError(nextError instanceof Error ? nextError.message : '申请详情加载失败，请稍后重试。');
    }).finally(() => { if (active && generation === detailGenerationRef.current) setDetailLoading(false); });
    return () => { active = false; };
  }, [detailReloadKey, listVersion, selectedRequestId, token]);
  const reloadDetail = () => { detailGenerationRef.current += 1; setDetailReloadKey((current) => current + 1); };
  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    const cursor = nextCursor;
    const generation = requestGenerationRef.current;
    setLoadingMore(true); setError('');
    try {
      const page = await listAdminComputeRequests(token, { cursor, kind: kind === 'all' ? undefined : kind, status: status === 'all' ? undefined : status, q: debouncedQuery || undefined });
      if (generation !== requestGenerationRef.current) return;
      setRequests((current) => {
        const known = new Set(current.map((item) => item.id));
        return [...current, ...page.items.filter((item) => !known.has(item.id))];
      });
      setNextCursor(page.nextCursor);
    } catch (nextError) {
      if (generation !== requestGenerationRef.current) return;
      setError(nextError instanceof Error ? nextError.message : '更多申请加载失败，请稍后重试。');
    } finally { if (generation === requestGenerationRef.current) setLoadingMore(false); }
  };
  const updateStatus = async (id: string, nextStatus: ComputeRequest['status'], expectedStatus: ComputeRequest['status']) => {
    setMutationError('');
    try {
      const updated = await updateAdminComputeRequestStatus(token, id, nextStatus, expectedStatus);
      if (status !== 'all' && updated.status !== status) reloadRequests();
      else setRequests((current) => current.map((request) => request.id === updated.id ? summarizeAdminComputeRequest(updated) : request));
      setDetail((current) => current?.id === updated.id ? updated : current);
      return updated;
    } catch(error) {
      if(error instanceof ApiError&&error.status===409){
        const conflictMessage = '申请状态已由其他管理员更新，请确认后重试。';
        setMutationError(conflictMessage);
        reloadRequests();reloadDetail();
        throw new Error(conflictMessage);
      }
      throw error;
    }
  };
  const sendQuote = async (id: string, quote: { amountCents: number; cardHoursMilli: number | null; validUntil: string; terms: string }, expectedStatus: ComputeRequest['status']) => {
    setMutationError('');
    try {
      const updated=await quoteAdminComputeRequest(token,id,quote,expectedStatus);
      if(status!=='all'&&updated.status!==status)reloadRequests();else setRequests((current)=>current.map((request)=>request.id===updated.id?summarizeAdminComputeRequest(updated):request));
      setDetail((current)=>current?.id===updated.id?updated:current);return updated;
    } catch(error) {
      if(error instanceof ApiError&&error.status===409){const message='申请已变化，请刷新后重新报价。';setMutationError(message);reloadRequests();reloadDetail();throw new Error(message);}throw error;
    }
  };
  return <div className="admin-compute">
    <section className="admin-compute-intro"><div><span className="eyebrow">ADMIN OPERATIONS</span><h2>用户算力申请</h2><p>仅管理员可查看联系人、设备参数和服务要求；搜索与筛选覆盖全站申请。</p></div><button type="button" disabled={loading} onClick={reloadRequests}>{loading ? <CircleNotch className="spin" /> : <ArrowClockwise />}刷新</button></section>
    <section className="admin-compute-filters" aria-label="算力申请筛选"><label className="admin-compute-search"><MagnifyingGlass /><input aria-label="搜索算力申请" value={query} maxLength={100} onChange={(event) => { invalidatePendingPages(); setQuery(event.target.value); }} placeholder="邮箱、公司、联系人、手机号、城市、GPU 或申请 ID" /></label><label><span>业务</span><select aria-label="筛选业务类型" value={kind} onChange={(event) => { invalidatePendingPages(); setKind(event.target.value as ComputeRequest['kind'] | 'all'); }}><option value="all">全部业务</option>{Object.entries(computeKindLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label><label><span>状态</span><select aria-label="筛选申请状态" value={status} onChange={(event) => { invalidatePendingPages(); setStatus(event.target.value as ComputeRequest['status'] | 'all'); }}><option value="all">全部状态</option>{Object.entries(computeStatusLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label></section>
    {mutationError && <div className="admin-compute-error notice error" role="alert">{mutationError}</div>}
    {error && <div className="admin-compute-error notice error" role="alert"><span>{error}</span>{!requests.length && <button type="button" onClick={reloadRequests}>重试</button>}</div>}
    {loading ? <div className="admin-compute-state"><CircleNotch className="spin" /> 正在读取用户申请…</div> : !requests.length && !error ? <div className="admin-compute-state">{query || kind !== 'all' || status !== 'all' ? <><MagnifyingGlass /> 没有匹配的用户申请</> : <><Storefront /> 暂无用户算力申请</>}</div> : <div className="admin-compute-layout"><nav className="admin-compute-list" aria-label="算力申请列表">{requests.map((request) => <button type="button" aria-pressed={selectedRequest?.id === request.id} className={selectedRequest?.id === request.id ? 'active' : ''} onClick={() => { detailGenerationRef.current += 1; setSelectedId(request.id); }} key={request.id}><span><strong>{request.company}</strong><small>{computeKindLabels[request.kind]} · {request.gpuModel} · {request.quantity} 卡</small><time>{formatAdminDate(request.createdAt)}</time></span><i className={request.status}>{computeStatusLabels[request.status]}</i></button>)}</nav>{selectedRequest && (detailTargetId !== selectedRequest.id || detailLoading ? <div className="admin-compute-detail-state"><CircleNotch className="spin" /> 正在读取申请详情…</div> : detailError ? <div className="admin-compute-detail-state error" role="alert"><Warning /> <span>{detailError}</span><button type="button" onClick={reloadDetail}>重试详情</button></div> : detail?.id === selectedRequest.id ? <AdminComputeRequestDetail key={selectedRequest.id} request={detail} onUpdate={updateStatus} onQuote={sendQuote} /> : <div className="admin-compute-detail-state"><CircleNotch className="spin" /> 正在读取申请详情…</div>)}</div>}
    {!loading && requests.length > 0 && <footer className="admin-compute-pagination"><span>已加载 {requests.length} 条{nextCursor ? '，还有更多记录' : '，已到最后一条'}</span>{nextCursor && <button type="button" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? <CircleNotch className="spin" /> : <CaretDown />}{loadingMore ? '正在加载…' : '加载更多'}</button>}</footer>}
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
  const [taskboardUrl, setTaskboardUrl] = useState<string | null>(null);
  const [desktopPetStatus, setDesktopPetStatus] = useState<DesktopPetStatus | null>(null);
  const [desktopPetBusy, setDesktopPetBusy] = useState(false);
  const [initialAuthMode, setInitialAuthMode] = useState<'login'|'register'>('login');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [newTaskTitle, setNewTaskTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [command, setCommand] = useState('npm test');
  const [terminalOutput, setTerminalOutput] = useState('选择本机项目后可运行受控命令。');
  const [selectedSourceId, setSelectedSourceId] = useState('');
  const [selectedModel, setSelectedModel] = useState('');
  const [knowledgeHits, setKnowledgeHits] = useState<KnowledgeHit[]>([]);
  const [knowledgeLoading, setKnowledgeLoading] = useState(false);
  const [mobileContextExpanded, setMobileContextExpanded] = useState(false);
  const [notice, setNotice] = useState('');
  const [messagesByTask, setMessagesByTask] = useState<Record<string, ChatMessage[]>>({});
  const [pendingSend, setPendingSend] = useState<{ prompt: string; mode: WorkspaceMode } | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [manualRefreshBusy, setManualRefreshBusy] = useState(false);
  const [cancellingTaskId,setCancellingTaskId]=useState('');
  const [agentStatus, setAgentStatus] = useState('就绪');
  const [pendingPermission, setPendingPermission] = useState<{ summary: PermissionToolSummary; options: Array<{ optionId: string; name: string; kind: string }> } | null>(null);
  const [project, setProject] = useState<ProjectSnapshot>(emptyProject);
  const [projectDiffStatus, setProjectDiffStatus] = useState<ProjectDiffStatus>('idle');
  const permissionResolver = useRef<((optionId: string | null) => void) | null>(null);
  const conversationScrollRef = useRef<HTMLDivElement>(null);
  const logoutRef = useRef<() => void>(() => undefined);
  const pendingSendRunner = useRef<(prompt: string, mode: WorkspaceMode) => void>(() => undefined);
  const activeRunRef=useRef<ActiveRun|null>(null);
  const currentDeviceRequestRef=useRef<CurrentDeviceRequest|null>(null);
  const sendingRef=useRef(false);
  const authGenerationRef=useRef(0);
  const authAttemptGenerationRef=useRef(0);
  const authRequestControllerRef=useRef<AbortController|null>(null);
  const projectLoadGenerationRef=useRef(0);
  const fileReadGenerationRef=useRef(0);
  const validatedProjectRef=useRef<ProjectSnapshot>(emptyProject);
  const validatedProjectDiffStatusRef=useRef<ProjectDiffStatus>('idle');
  const projectRootRef=useRef(project.root);
  projectRootRef.current=project.root;
  const sessionToken = session?.token ?? null;
  const sessionTokenRef=useRef<string|null>(sessionToken);
  sessionTokenRef.current=sessionToken;
  const pendingPaymentOrderId = paymentOrder?.status === 'pending' ? paymentOrder.id : null;

  const loadProjectForDisplay = async (root:string,generation:number,failureMessage:string,preserveSelection=false):Promise<ProjectSnapshot|null> => {
    fileReadGenerationRef.current+=1;
    let filesLoaded=false;
    const diffResult:{status:ProjectDiffStatus;value:string;error:string}={status:'loading',value:'',error:''};
    const diffRequest=loadProjectDiff(root).then((diff)=>{
      if(diff===null)return;
      const diffError=desktopGitDiffError(diff);if(diffError)throw new Error(diffError);
      diffResult.status='ready';diffResult.value=diff;
      if(!filesLoaded||generation!==projectLoadGenerationRef.current)return;
      setProject((current)=>{
        if(current.root!==root)return current;
        const next={...current,diff};validatedProjectRef.current=next;return next;
      });
      validatedProjectDiffStatusRef.current='ready';setProjectDiffStatus('ready');
    }).catch((error)=>{
      diffResult.status='error';diffResult.error=error instanceof Error?error.message:'Git 改动读取失败';
      if(!filesLoaded||generation!==projectLoadGenerationRef.current)return;
      validatedProjectDiffStatusRef.current='error';setProjectDiffStatus('error');setNotice(`项目文件已加载，但 Git 改动读取失败：${diffResult.error}`);
    });
    void diffRequest;
    try{
      const snapshot=await loadProjectFiles(root);
      if(!snapshot)throw new Error('桌面端项目桥接不可用');
      if(generation!==projectLoadGenerationRef.current)return null;
      filesLoaded=true;
      const nextSnapshot={...snapshot,diff:diffResult.status==='ready'?diffResult.value:''};
      setProject((current)=>{
        const next=preserveSelection&&current.root===root?{...nextSnapshot,diff:diffResult.status==='ready'?diffResult.value:current.diff,selectedFile:current.selectedFile,selectedContent:current.selectedContent}:nextSnapshot;
        validatedProjectRef.current=next;return next;
      });
      validatedProjectDiffStatusRef.current=diffResult.status;setProjectDiffStatus(diffResult.status);
      if(diffResult.status==='error')setNotice(`项目文件已加载，但 Git 改动读取失败：${diffResult.error}`);
      return nextSnapshot;
    }catch(error){
      if(generation!==projectLoadGenerationRef.current)return null;
      projectLoadGenerationRef.current+=1;
      const fallback=validatedProjectRef.current;
      setProject(fallback);setProjectDiffStatus(validatedProjectDiffStatusRef.current);
      if(fallback.root)storageSet('cod.project.root',fallback.root);else storageRemove('cod.project.root');
      const detail=error instanceof Error?`：${error.message}`:'';
      setNotice(`${failureMessage}${fallback.root?'，已恢复上一个可用项目':'，已清除失效项目'}${detail}`);
      return null;
    }
  };

  const commitProjectSnapshot = (snapshot:ProjectSnapshot,root:string,generation:number):boolean => {
    if(snapshot.root!==root||generation!==projectLoadGenerationRef.current||projectRootRef.current!==root)return false;
    const diffFailed=Boolean(desktopGitDiffError(snapshot.diff));
    fileReadGenerationRef.current+=1;
    setProject((current)=>{
      if(current.root!==root||generation!==projectLoadGenerationRef.current)return current;
      const next={...snapshot,diff:diffFailed?'':snapshot.diff,selectedFile:current.selectedFile,selectedContent:current.selectedContent};
      validatedProjectRef.current=next;return next;
    });
    validatedProjectDiffStatusRef.current=diffFailed?'error':'ready';setProjectDiffStatus(diffFailed?'error':'ready');
    return true;
  };

  const clearAuthenticatedUi = useCallback((message = '') => {
    authGenerationRef.current += 1;
    const run=activeRunRef.current;
    if(run){run.cancelled=true;run.controller.abort(new DOMException('Signed out','AbortError'));}
    activeRunRef.current=null;sendingRef.current=false;sessionTokenRef.current=null;
    permissionResolver.current?.(null);permissionResolver.current=null;
    void window.codDesktop?.stopGoose();
    void window.codDesktop?.stopDesktopPet?.().then(setDesktopPetStatus).catch(() => undefined);
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

  useEffect(() => {
    if (getCodRuntime().hostPlatform !== 'android') return;
    if (overlay) {
      setCodNativeBackHandler(() => {
        if (overlay === 'compute-admin') { setOverlay('account'); return; }
        if (overlay === 'login') {
          authRequestControllerRef.current?.abort(new DOMException('Authentication dialog closed','AbortError'));
          authRequestControllerRef.current=null;
          authAttemptGenerationRef.current += 1;
          setPendingSend(null);
          setResumeComputeAfterLogin(false);
          setInitialAuthMode('login');
        }
        setOverlay(null);
      });
      return;
    }
    if (sidebarOpen) {
      setCodNativeBackHandler(() => setSidebarOpen(false));
      return;
    }
    setCodNativeBackHandler(null);
  }, [overlay, sidebarOpen]);

  useEffect(() => {
    if (!sidebarOpen || overlay) return;
    const closeSidebar = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setSidebarOpen(false);
    };
    window.addEventListener('keydown', closeSidebar);
    return () => window.removeEventListener('keydown', closeSidebar);
  }, [overlay, sidebarOpen]);

  useEffect(() => () => setCodNativeBackHandler(null), []);

  useEffect(() => {
    const getTaskboardUrl=window.codDesktop?.getTaskboardUrl;
    if(!getTaskboardUrl)return;
    let cancelled=false;let refreshPending=false;
    const refreshTaskboard=async()=>{
      if(cancelled||refreshPending)return;refreshPending=true;let url:string|null=null;
      try{url=await getTaskboardUrl();}catch{/* Optional local companion. */}
      refreshPending=false;if(cancelled)return;setTaskboardUrl(url);
      if(!url)setOverlay((current)=>current==='taskboard'?null:current);
    };
    const handleFocus=()=>{void refreshTaskboard();};
    void refreshTaskboard();const interval=window.setInterval(()=>{void refreshTaskboard();},taskboardDiscoveryIntervalMs);
    window.addEventListener('focus',handleFocus);
    return()=>{cancelled=true;window.clearInterval(interval);window.removeEventListener('focus',handleFocus);};
  }, []);

  useEffect(() => {
    const getDesktopPetStatus=window.codDesktop?.getDesktopPetStatus;
    if(!getDesktopPetStatus)return;
    let cancelled=false;let pending=false;
    const refresh=async()=>{
      if(cancelled||pending)return;pending=true;
      try{const status=await getDesktopPetStatus();if(!cancelled)setDesktopPetStatus(status);}catch{if(!cancelled)setDesktopPetStatus(null);}
      finally{pending=false;}
    };
    const handleFocus=()=>{void refresh();};
    void refresh();const interval=window.setInterval(()=>{void refresh();},taskboardDiscoveryIntervalMs);
    window.addEventListener('focus',handleFocus);
    return()=>{cancelled=true;window.clearInterval(interval);window.removeEventListener('focus',handleFocus);};
  }, []);

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
  const callableModels = useMemo(() => uniqueCallableModels(session?.sources ?? []), [session]);
  const compareTargets = callableModels.filter((target) => compareModelKeys.includes(target.key));
  const onlineDesktopDevices = useMemo(() => devices.filter((device) => device.status === 'online' && !['web', 'mobile'].includes(device.platform)), [devices]);
  const activeMessages = activeTaskId ? messagesByTask[activeTaskId] ?? [] : [];
  const activeMessageTailId = activeMessages[activeMessages.length - 1]?.id ?? '';
  useEffect(() => {
    const scrollArea = conversationScrollRef.current;
    if (!scrollArea) return;
    scrollArea.scrollTop = scrollArea.scrollHeight;
  }, [activeMessageTailId, activeTaskId, isSending]);
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

  const ensureCurrentDevice = useCallback((token:string,authGeneration:number,knownDevices:DeviceRecord[],allowUnboundSession=false):Promise<CurrentDeviceSnapshot> => {
    const existingRequest=currentDeviceRequestRef.current;
    if(existingRequest?.token===token&&existingRequest.authGeneration===authGeneration)return existingRequest.promise;
    const assertCurrentAuth=()=>{
      const activeToken=sessionTokenRef.current;
      if(authGenerationRef.current!==authGeneration||activeToken!==token&&!(allowUnboundSession&&activeToken===null))throw new DOMException('Authentication attempt superseded','AbortError');
    };
    const promise=(async():Promise<CurrentDeviceSnapshot>=>{
      assertCurrentAuth();
      const storedDeviceId=storageGet('cod.device.id');
      const platform=devicePlatform();
      let device:DeviceRecord;
      if(storedDeviceId){
        try{device=await heartbeatDevice(token,storedDeviceId);}
        catch(error){
          assertCurrentAuth();
          if(!(error instanceof ApiError&&error.status===404))throw error;
          device=await registerDevice(token,hasDesktopBridge()?`COD Desktop (${platform})`:`COD ${platform==='mobile'?'Mobile':'Web'}`,platform);
        }
      }else device=await registerDevice(token,hasDesktopBridge()?`COD Desktop (${platform})`:`COD ${platform==='mobile'?'Mobile':'Web'}`,platform);
      assertCurrentAuth();
      const devices=[...knownDevices.filter((candidate)=>candidate.id!==device.id&&candidate.id!==storedDeviceId),device];
      storageSet('cod.device.id',device.id);
      setDevices(devices);
      setCurrentDeviceId(device.id);
      return{device,devices};
    })();
    const request={token,authGeneration,promise};
    currentDeviceRequestRef.current=request;
    void promise.then(
      ()=>{if(currentDeviceRequestRef.current===request)currentDeviceRequestRef.current=null;},
      ()=>{if(currentDeviceRequestRef.current===request)currentDeviceRequestRef.current=null;},
    );
    return promise;
  },[]);

  const loadWorkspace = async (nextSession: CodSession, authGeneration:number) => {
    const assertCurrentAuth=()=>{if(authGenerationRef.current!==authGeneration)throw new DOMException('Authentication attempt superseded','AbortError');};
    assertCurrentAuth();
    const [devicesResult, tasksResult, productsResult, ledgerResult, creditPacksResult] = await Promise.allSettled([listDevices(nextSession.token), listTasks(nextSession.token), listProducts(nextSession.token), listLedger(nextSession.token), getCreditPacks(nextSession.token)]);
    assertCurrentAuth();
    const definitiveAuthenticationFailure = [devicesResult, tasksResult, productsResult, ledgerResult, creditPacksResult]
      .find((result) => result.status === 'rejected' && isDefinitiveAuthenticationFailure(result.reason));
    if (definitiveAuthenticationFailure?.status === 'rejected') throw definitiveAuthenticationFailure.reason;
    const initialDevices = devicesResult.status === 'fulfilled' ? devicesResult.value : [];
    const nextTasks = tasksResult.status === 'fulfilled' ? tasksResult.value : [];
    let nextDevices = initialDevices;
    let currentDevice:DeviceRecord|undefined;
    let deviceConnectionFailed = devicesResult.status === 'rejected';
    if (!deviceConnectionFailed) {
      try {
        const ensured=await ensureCurrentDevice(nextSession.token,authGeneration,nextDevices,true);
        assertCurrentAuth();
        currentDevice=ensured.device;nextDevices=ensured.devices;
      } catch (error) {
        if (isDefinitiveAuthenticationFailure(error)) throw error;
        deviceConnectionFailed = true;
      }
    }
    assertCurrentAuth();
    setModelCatalog(nextSession.sources);
    setModelCatalogError('');
    setDevices(nextDevices); setTasks(nextTasks);
    setProducts(productsResult.status === 'fulfilled' ? productsResult.value : []);
    setLedger(ledgerResult.status === 'fulfilled' ? ledgerResult.value : []);
    setCreditPacks(creditPacksResult.status === 'fulfilled' ? creditPacksResult.value : { packs: [], summary: { availableCents: 0, grants: [] } });
    const degradedServices = [deviceConnectionFailed ? '设备同步' : '', tasksResult.status === 'rejected' ? '任务' : '', productsResult.status === 'rejected' ? '产品入口' : '', ledgerResult.status === 'rejected' ? '账单' : '', creditPacksResult.status === 'rejected' ? '额度包' : ''].filter(Boolean);
    setNotice(degradedServices.length ? `已登录；${degradedServices.join('、')}暂未加载，可稍后刷新。` : '');
    setCurrentDeviceId(currentDevice?.id ?? '');
    setTargetDeviceId((current) => nextDevices.some((device) => device.id === current && device.status === 'online' && !['web', 'mobile'].includes(device.platform)) ? current : nextDevices.find((device) => device.status === 'online' && !['web', 'mobile'].includes(device.platform))?.id ?? '');
    setActiveTaskId((current) => preferredTaskId(nextTasks, current, currentDevice?.id ?? ''));
    const storedSourceId = storageGet('cod.model.source');
    const nextSource = nextSession.sources.find((source) => source.id === storedSourceId) ?? nextSession.sources.find((source) => source.callable) ?? nextSession.sources[0];
    setSelectedSourceId(nextSource?.id ?? '');
    const storedModel = nextSource ? storageGet(`cod.model.${nextSource.id}`) : null;
    setSelectedModel(nextSource?.models.find((model) => model.id === storedModel)?.id ?? nextSource?.models[0]?.id ?? '');
    setCompareModelKeys((current) => {
      const available=uniqueCallableModels(nextSession.sources);
      const valid=current.filter((key)=>available.some((target)=>target.key===key));
      return valid.length>=2?valid:available.map((target)=>target.key).slice(0,2);
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
      try { await loadWorkspace(nextSession,authGeneration); if (mounted&&authGenerationRef.current===authGeneration) { sessionTokenRef.current=nextSession.token; setSession(nextSession); setAuthState('signed-in'); setInitialAuthMode('login'); setOverlay(null); } }
      catch (error) {
        if (!mounted || authGenerationRef.current!==authGeneration) return;
        if (isDefinitiveAuthenticationFailure(error)) {
          await logoutCod(nextSession.token).catch(() => false);
          setAuthState('signed-out');
        } else {
          sessionTokenRef.current=nextSession.token;setSession(nextSession);setNotice('已恢复登录；工作区暂未加载，可在网络恢复后重试。');setAuthState('signed-in');
        }
      }
    });
    return () => { mounted = false; if(authGenerationRef.current===authGeneration)authGenerationRef.current+=1; };
    // Bootstrap captures the initial workspace loader and must run exactly once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (authState === 'loading' || session || overlay) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get('auth') !== 'register') return;
    setInitialAuthMode(capabilities?.authentication.registrationEnabled === true ? 'register' : 'login');
    setOverlay('login');
    url.searchParams.delete('auth');
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  }, [authState, capabilities, overlay, session]);

  useEffect(() => {
    if (!session || !window.location.search) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get('auth') !== 'register') return;
    url.searchParams.delete('auth');
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  }, [session]);

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
    const authGeneration=authGenerationRef.current;
    let stopped=false;
    const sync = async () => {
      if (!hasDesktopBridge() && document.visibilityState === 'hidden' && !activeRunRef.current?.leaseAcquired) return;
      try {
        const currentDeviceId = storageGet('cod.device.id');const activeRun=activeRunRef.current;
        if(currentDeviceId&&!stopped){try{await heartbeatDevice(token,currentDeviceId,activeRun?.leaseAcquired?activeRun.taskId:undefined);}catch(error){if(activeRun?.leaseAcquired&&error instanceof ApiError&&['task_lease_expired','task_lease_required','invalid_task_lease'].includes(error.code)&&!activeRun.cancelled&&!activeRun.finalizing&&!activeRun.terminalCommitted){activeRun.cancelled=true;activeRun.controller.abort(new DOMException('Task execution lease expired','AbortError'));setNotice('任务执行租约已失效，本机 Agent 已停止。请检查项目状态后重新执行。');if(hasDesktopBridge())void window.codDesktop?.stopGoose();}}}
        const [tasksResult, devicesResult, accountResult, creditPacksResult] = await Promise.allSettled([
          listTasks(token), listDevices(token), refreshAccount(token), getCreditPacks(token),
        ]);
        if(stopped||sessionTokenRef.current!==token||authGenerationRef.current!==authGeneration)return;
        const authenticationFailure = [tasksResult, devicesResult, accountResult, creditPacksResult]
          .find((result) => result.status === 'rejected' && isDefinitiveAuthenticationFailure(result.reason));
        if (authenticationFailure) { logoutRef.current(); setNotice('登录已失效，请重新登录。'); return; }
        let ensuredDeviceId=storageGet('cod.device.id')??'';
        if(devicesResult.status==='fulfilled'){
          try{
            const ensured=await ensureCurrentDevice(token,authGeneration,devicesResult.value);
            if(stopped||sessionTokenRef.current!==token||authGenerationRef.current!==authGeneration)return;
            ensuredDeviceId=ensured.device.id;
          }catch(error){
            if(isDefinitiveAuthenticationFailure(error)&&!stopped&&sessionTokenRef.current===token&&authGenerationRef.current===authGeneration){logoutRef.current();setNotice('登录已失效，请重新登录。');return;}
            if(stopped||sessionTokenRef.current!==token||authGenerationRef.current!==authGeneration)return;
            setDevices(devicesResult.value);
          }
        }
        if(tasksResult.status==='fulfilled'){
          const nextTasks=tasksResult.value;
          setTasks(nextTasks);
          setActiveTaskId((current)=>preferredTaskId(nextTasks,current,ensuredDeviceId));
        }
        if(creditPacksResult.status==='fulfilled')setCreditPacks(creditPacksResult.value);
        if(accountResult.status==='fulfilled'){
          setSession((current) => current?.token === token ? { ...current, account:accountResult.value } : current);
          if(accountResult.value.role!=='admin')setOverlay((current)=>current==='compute-admin'?'account':current);
        }
      } catch { /* Keep the last synchronized snapshot and retry. */ }
    };
    const interval = window.setInterval(sync, 15_000);
    const syncWhenVisible=()=>{if(document.visibilityState==='visible')void sync();};
    document.addEventListener('visibilitychange',syncWhenVisible);
    return () => { stopped=true; window.clearInterval(interval); document.removeEventListener('visibilitychange',syncWhenVisible); };
  }, [ensureCurrentDevice,sessionToken]);

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
    if (!recentRoot) return;
    const generation=++projectLoadGenerationRef.current;
    setProjectDiffStatus('loading');
    setProject({...emptyProject,root:recentRoot});
    void loadProjectForDisplay(recentRoot,generation,'上次使用的项目无法打开');
    return()=>{if(generation===projectLoadGenerationRef.current)projectLoadGenerationRef.current+=1;};
  }, []);

  const cancelAuthentication = () => {
    authRequestControllerRef.current?.abort(new DOMException('Authentication cancelled','AbortError'));
    authRequestControllerRef.current=null;
    authAttemptGenerationRef.current+=1;
  };
  const establishAuthenticatedSession = async (nextSession: CodSession, authAttemptGeneration: number, signal: AbortSignal, nextOverlay: Overlay) => {
    const authGeneration=++authGenerationRef.current;
    let persisted=false;
    const assertCurrentAuth=()=>{
      if(signal.aborted||authAttemptGenerationRef.current!==authAttemptGeneration||authGenerationRef.current!==authGeneration){
        throw signal.reason instanceof DOMException ? signal.reason : new DOMException('Authentication attempt superseded','AbortError');
      }
    };
    try{
      await persistCodSession(nextSession.token);persisted=true;assertCurrentAuth();
      await loadWorkspace(nextSession,authGeneration);assertCurrentAuth();
    }catch(error){
      if(persisted){
        try{
          const cleared=await logoutCod(nextSession.token,{clearMobileHistory:false});
          if(!cleared)throw new ApiError('登录凭据回滚未完成，请清理本机应用数据后重试。',503,'logout_recovery_unavailable');
        }catch(cleanupError){
          if(cleanupError instanceof ApiError&&cleanupError.code==='logout_recovery_unavailable')throw cleanupError;
        }
      }
      throw error;
    }
    sessionTokenRef.current=nextSession.token;setSession(nextSession);setAuthState('signed-in');setInitialAuthMode('login');setOverlay(nextOverlay);setResumeComputeAfterLogin(false);
  };
  const handleLogin = async (email: string, password: string, signal: AbortSignal) => {
    const authAttemptGeneration=++authAttemptGenerationRef.current;
    const issuedToken=await loginCod(email,password,{signal});
    if(signal.aborted||authAttemptGenerationRef.current!==authAttemptGeneration)throw signal.reason??new DOMException('Authentication attempt superseded','AbortError');
    const nextSession=await hydrateCodSession(issuedToken,signal);
    if(signal.aborted||authAttemptGenerationRef.current!==authAttemptGeneration)throw signal.reason??new DOMException('Authentication attempt superseded','AbortError');
    await establishAuthenticatedSession(nextSession,authAttemptGeneration,signal,resumeComputeAfterLogin?'compute':null);
  };
  const handleRegister=async(input:VerifiedRegistrationInput|DirectRegistrationInput|LegacyMigrationInput,signal:AbortSignal,idempotencyKey?:string)=>{
    const authAttemptGeneration=++authAttemptGenerationRef.current;
    const issuedToken=await registerCod(input,{signal,idempotencyKey});
    if(signal.aborted||authAttemptGenerationRef.current!==authAttemptGeneration)throw signal.reason??new DOMException('Authentication attempt superseded','AbortError');
    const nextSession=await hydrateCodSession(issuedToken,signal);
    if(signal.aborted||authAttemptGenerationRef.current!==authAttemptGeneration)throw signal.reason??new DOMException('Authentication attempt superseded','AbortError');
    await establishAuthenticatedSession(nextSession,authAttemptGeneration,signal,resumeComputeAfterLogin?'compute':null);
  };
  const handleLogout = () => {
    const expectedToken=sessionTokenRef.current??undefined;
    cancelAuthentication();setInitialAuthMode('login');clearAuthenticatedUi();
    void logoutCod(expectedToken,{explicit:true}).catch((error)=>setNotice(error instanceof Error?error.message:'本机登录凭据未能删除，请在系统设置中清除 COD 应用数据。'));
  };
  logoutRef.current=handleLogout;
  const handleManualRefresh = async () => {
    if (manualRefreshBusy) return;
    setManualRefreshBusy(true);
    try {
      if (!session) {
        const [capabilitiesResult, catalogResult, offersResult] = await Promise.allSettled([getCapabilities(), listModelCatalog(), listComputeOffers()]);
        if (capabilitiesResult.status === 'fulfilled') { setCapabilities(capabilitiesResult.value); setCapabilityError(''); }
        if (catalogResult.status === 'fulfilled') { setModelCatalog(catalogResult.value); setModelCatalogError(''); }
        if (offersResult.status === 'fulfilled') setComputeOffers(offersResult.value);
        const failed = [capabilitiesResult.status === 'rejected' ? '服务状态' : '', catalogResult.status === 'rejected' ? '模型目录' : '', offersResult.status === 'rejected' ? '算力市场' : ''].filter(Boolean);
        setNotice(failed.length ? `${failed.join('、')}刷新失败，请检查网络后重试。` : '公开服务信息已刷新。');
        return;
      }
      const token = session.token;
      const authGeneration=authGenerationRef.current;
      const [capabilitiesResult, sourcesResult, tasksResult, devicesResult, accountResult, creditPacksResult, productsResult, ledgerResult, computeResult, referralResult] = await Promise.allSettled([
        getCapabilities(), listModelSources(token), listTasks(token), listDevices(token), refreshAccount(token), getCreditPacks(token), listProducts(token), listLedger(token), listComputeRequests(token), getReferralSummary(token),
      ]);
      if (sessionTokenRef.current !== token||authGenerationRef.current!==authGeneration) return;
      const authenticationFailure = [sourcesResult, tasksResult, devicesResult, accountResult, creditPacksResult, productsResult, ledgerResult, computeResult, referralResult]
        .find((result) => result.status === 'rejected' && isDefinitiveAuthenticationFailure(result.reason));
      if (authenticationFailure) { handleLogout(); setNotice('登录已失效，请重新登录。'); return; }
      let ensuredDeviceId=storageGet('cod.device.id')??'';
      let deviceConnectionFailed=devicesResult.status==='rejected';
      if(devicesResult.status==='fulfilled'){
        try{
          const ensured=await ensureCurrentDevice(token,authGeneration,devicesResult.value);
          if(sessionTokenRef.current!==token||authGenerationRef.current!==authGeneration)return;
          ensuredDeviceId=ensured.device.id;
        }catch(error){
          if(sessionTokenRef.current!==token||authGenerationRef.current!==authGeneration)return;
          if(isDefinitiveAuthenticationFailure(error)){handleLogout();setNotice('登录已失效，请重新登录。');return;}
          deviceConnectionFailed=true;setDevices(devicesResult.value);
        }
      }
      if (capabilitiesResult.status === 'fulfilled') { setCapabilities(capabilitiesResult.value); setCapabilityError(''); }
      if (sourcesResult.status === 'fulfilled') {
        const nextSources = sourcesResult.value;
        const storedSourceId = storageGet('cod.model.source');
        const nextSource = nextSources.find((source) => source.id === selectedSourceId)
          ?? nextSources.find((source) => source.id === storedSourceId)
          ?? nextSources.find((source) => source.callable)
          ?? nextSources[0];
        const storedModel = nextSource ? storageGet(`cod.model.${nextSource.id}`) : null;
        const nextModel = nextSource?.models.find((model) => model.id === selectedModel)?.id
          ?? nextSource?.models.find((model) => model.id === storedModel)?.id
          ?? nextSource?.models[0]?.id
          ?? '';
        setSession((current) => current?.token === token ? { ...current, sources: nextSources } : current);
        setModelCatalog(nextSources);
        setModelCatalogError('');
        setSelectedSourceId(nextSource?.id ?? '');
        setSelectedModel(nextModel);
        if (nextSource) {
          storageSet('cod.model.source', nextSource.id);
          if (nextModel) storageSet(`cod.model.${nextSource.id}`, nextModel);
          else storageRemove(`cod.model.${nextSource.id}`);
        } else {
          storageRemove('cod.model.source');
        }
      }
      if (tasksResult.status === 'fulfilled') {
        const nextTasks = tasksResult.value;
        setTasks(nextTasks);
        setActiveTaskId((current) => preferredTaskId(nextTasks, current, ensuredDeviceId));
      }
      if (accountResult.status === 'fulfilled') setSession((current) => current?.token === token ? { ...current, account: accountResult.value } : current);
      if (creditPacksResult.status === 'fulfilled') setCreditPacks(creditPacksResult.value);
      if (productsResult.status === 'fulfilled') setProducts(productsResult.value);
      if (ledgerResult.status === 'fulfilled') setLedger(ledgerResult.value);
      if (computeResult.status === 'fulfilled') setComputeRequests(computeResult.value);
      if (referralResult.status === 'fulfilled') setReferralSummary(referralResult.value);
      if (sessionTokenRef.current !== token||authGenerationRef.current!==authGeneration) return;
      const failed = [capabilitiesResult.status === 'rejected' ? '服务状态' : '', sourcesResult.status === 'rejected' ? '模型源' : '', tasksResult.status === 'rejected' ? '任务' : '', deviceConnectionFailed ? '设备' : '', accountResult.status === 'rejected' ? '账户' : '', creditPacksResult.status === 'rejected' ? '额度' : '', productsResult.status === 'rejected' ? '产品' : '', ledgerResult.status === 'rejected' ? '流水' : '', computeResult.status === 'rejected' ? '算力需求' : '', referralResult.status === 'rejected' ? '邀请信息' : ''].filter(Boolean);
      setNotice(failed.length ? `已刷新可用数据；${failed.join('、')}暂时失败。` : '工作区已刷新。');
    } finally {
      setManualRefreshBusy(false);
    }
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
    const token=session.token;const created=await createComputeRequest(token,input);if(sessionTokenRef.current!==token)return;setComputeRequests((current)=>[created,...current.filter((item)=>item.id!==created.id)]);setNotice(input.kind==='hosting'?'托管需求已记录，COD 将匹配第三方托管商；待机位、电力、网络与档期核验后会联系你。':'需求已提交，商务确认库存和交付条件后会联系你。');
  };
  const handleComputeQuoteDecision = async (request:ComputeRequest,decision:'accepted'|'declined') => {
    if(!session){setOverlay('login');return;}const token=session.token;const updated=await decideComputeRequestQuote(token,request.id,decision,request.status);if(sessionTokenRef.current!==token)return;
    setComputeRequests((current)=>current.map((item)=>item.id===updated.id?updated:item));setNotice(decision==='accepted'?'报价已确认，COD 将按条款推进交付。':'报价已拒绝，该需求已关闭。');
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
    if(nextMode==='chat'&&activeTask&&activeTask.deviceId!==currentDeviceId){setActiveTaskId(null);setNotice('已开始当前设备的新对话；原任务仍保留在任务列表中。');}
    setMode(nextMode);
  };
  const startNewWorkspaceItem = () => {
    if (!session) { setOverlay('login'); return; }
    if (mode === 'chat') {
      setActiveTaskId(null);
      setPrompt('');
      setSidebarOpen(false);
      setOverlay(null);
      setNotice('新对话已就绪，输入消息即可开始。');
      return;
    }
    setOverlay('new-task');
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
    const projectContext=project.root?{root:project.root,generation:projectLoadGenerationRef.current}:null;
    let task = requestedTask;
    let promptAppended = false;
    let responseAppended = false;
    let chatShellStatus: Promise<RemoteTask | null> | null = null;
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
      // A chat task is only a local/history shell. Model requests intentionally
      // remain taskless so a Desktop execution claim can never block ordinary
      // conversation. Code/Agent runs keep the strict synchronized task lease.
      if (requestedMode === 'code') {
        if (task.status !== 'running'||!getTaskExecutionLease(task.id)) {task = await changeTaskStatus(task, 'running');assertActive();}
        run.leaseAcquired=Boolean(getTaskExecutionLease(task.id));
        if(!run.leaseAcquired)throw new Error('未取得任务执行租约，本次任务未启动。');
      } else {
        const shellTask = task;
        chatShellStatus = (shellTask.status === 'running' || shellTask.status === 'waiting'
          ? Promise.resolve(shellTask)
          : changeTaskStatus(shellTask, 'running'))
          .catch(() => null);
      }
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
        projectBeforeRun=await loadProject(projectContext!.root);
        assertActive();
        if(!projectBeforeRun)throw new Error('无法读取项目运行前状态，本次代码任务未执行。');
      }
      const executionLease=getTaskExecutionLease(task.id);
      const acpUrl = requestedMode === 'code' && selectedSource && selectedModelInfo && executionLease ? await window.codDesktop?.getGooseAcpUrl({ token, sourceId: selectedSource.id, modelId: selectedModelInfo.id, taskId:task.id, root:projectContext!.root, executionId:executionLease.executionId, leaseToken:executionLease.leaseToken }) : null;
      assertActive();
      if(comparisonRequest){
        setAgentStatus(`正在并行请求 ${compareTargets.length} 个模型`);
        const results=await Promise.all(compareTargets.map(async(target):Promise<ComparisonResult>=>{const startedAt=performance.now();try{const result=await sendChat(token,target.sourceId,target.model.id,conversationMessages,{signal:run.controller.signal});return{sourceId:target.sourceId,sourceLabel:target.sourceLabel,model:result.model,modelId:target.model.id,content:result.content,inputTokens:result.inputTokens,outputTokens:result.outputTokens,durationMs:Math.round(performance.now()-startedAt)};}catch(error){return{sourceId:target.sourceId,sourceLabel:target.sourceLabel,model:target.model.id,modelId:target.model.id,content:'',durationMs:Math.round(performance.now()-startedAt),error:chatFailureMessage(error)};}}));
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
        const gooseRun = await runGooseTask({ acpUrl, cwd: projectContext!.root, prompt: buildCodeExecutionPrompt(contextualPrompt), signal:run.controller.signal, onUpdate: (update) => { if(run.cancelled||sessionTokenRef.current!==token)return;if (update.kind === 'message') reply += update.text; if (update.kind === 'tool' || update.kind === 'status') setAgentStatus(update.text); }, requestPermission: (request) => new Promise((resolve) => { if(run.cancelled||sessionTokenRef.current!==token){resolve(null);return;}permissionResolver.current = resolve; setPendingPermission({ summary: summarizePermissionToolCall(request.toolCall), options: request.options }); }) });
        assertActive();
        const projectAfterRun=await loadProject(projectContext!.root);
        assertActive();
        if(!projectAfterRun)throw new Error('无法读取项目运行后状态，因此未将本次代码任务标记为完成。');
        commitProjectSnapshot(projectAfterRun,projectContext!.root,projectContext!.generation);
        reply=gooseRun.answer;validateCodeRun(submittedPrompt,gooseRun,Boolean(projectBeforeRun&&projectBeforeRun.diff!==projectAfterRun.diff));
        if (!reply) reply = 'Goose 已完成任务，请在右侧刷新文件与 Diff。';
      } else {
        if (!selectedSource?.callable || !selectedModelInfo) throw new Error('当前模型源仅供查看目录，配置该源密钥后才能调用。');
        const result = await sendChat(token, selectedSource.id, selectedModelInfo.id, conversationMessages,{signal:run.controller.signal});assertActive();reply = result.content;replyMode = result.mode;
        appendMessage(task.id, { id: createClientId(), role: 'assistant', content: reply, mode: replyMode, sourceLabel: selectedSource.label, model: result.model, inputTokens: result.inputTokens, outputTokens: result.outputTokens, usageEstimated: result.usageEstimated, fallbackUsed: result.fallbackUsed, createdAt: new Date().toISOString() });
        responseAppended = true;
      }
      if (!comparisonRequest&&requestedMode === 'code'&&selectedSource&&selectedModelInfo) { appendMessage(task.id, { id: createClientId(), role: 'assistant', content: reply, mode: replyMode, sourceLabel: selectedSource.label, model: selectedModelInfo.id, createdAt: new Date().toISOString() }); responseAppended = true; }
      if (requestedMode === 'code' && (task.status === 'running' || task.status === 'waiting')) {
        run.finalizing=true;
        try{task=await changeTaskStatus(task,'complete',{result:reply,error:null});run.terminalCommitted=true;run.leaseAcquired=false;}
        catch(error){run.finalizing=false;throw error;}
        assertActive();
      }
      else if (requestedMode === 'chat') {
        void chatShellStatus?.then(async (shellTask) => {
          if (!shellTask) throw new Error('chat shell unavailable');
          if (shellTask.status === 'running' || shellTask.status === 'waiting') await changeTaskStatus(shellTask, 'complete', { result: reply, error: null });
        }).catch(() => {
          if (sessionTokenRef.current === token) setNotice('回复已完成，但对话列表状态同步失败；消息已经保存在当前设备。');
        });
      }
      setAgentStatus('已完成');
      const refreshContext=requestedMode!=='code'&&hasDesktopBridge()?projectContext:null;
      const [walletRefresh,projectRefresh]=await Promise.allSettled([refreshWallet(true),refreshContext?loadProject(refreshContext.root):Promise.resolve(null)]);
      assertActive();
      const projectRefreshIsCurrent=Boolean(refreshContext&&refreshContext.generation===projectLoadGenerationRef.current&&projectRootRef.current===refreshContext.root);
      if(projectRefresh.status==='fulfilled'&&projectRefresh.value&&refreshContext&&projectRefreshIsCurrent)commitProjectSnapshot(projectRefresh.value,refreshContext.root,refreshContext.generation);
      const refreshFailures=[walletRefresh.status==='rejected'||walletRefresh.value===false?'余额/账单':'',projectRefresh.status==='rejected'&&projectRefreshIsCurrent?'项目状态':''].filter(Boolean);
      if(refreshFailures.length)setNotice(`回复已完成，但${refreshFailures.join('、')}刷新失败，可稍后手动刷新。`);
    } catch (error) {
      if(run.cancelled||sessionTokenRef.current!==token||isTaskCancellation(error)){if(sessionTokenRef.current===token)setAgentStatus('已终止');return;}
      const failure = chatFailureMessage(error);
      setAgentStatus('等待重试'); setNotice(failure);
      if (task && promptAppended && !responseAppended) appendMessage(task.id, { id: createClientId(), role: 'assistant', content: failure, failed: true, retryPrompt: promptText, createdAt: new Date().toISOString() });
      if (requestedMode === 'code' && task && session && (task.status === 'draft' || task.status === 'running' || task.status === 'waiting')) {
        run.finalizing=true;
        try{await changeTaskStatus(task,'failed',{error:failure});run.terminalCommitted=true;run.leaseAcquired=false;}
        catch{run.finalizing=false;/* Preserve the original error. */}
      }
      else if (requestedMode === 'chat') void chatShellStatus?.then(async (shellTask) => {
        if (shellTask && (shellTask.status === 'running' || shellTask.status === 'waiting')) await changeTaskStatus(shellTask, 'failed', { error: failure });
      }).catch(() => undefined);
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
  const stopActiveChat=async(task:RemoteTask)=>{
    if(!session||cancellingTaskId)return;
    const token=session.token;const run=activeRunRef.current;
    if(!run||run.mode!=='chat'||run.taskId!==task.id)return;
    setCancellingTaskId(task.id);run.cancelled=true;run.controller.abort(new DOMException('Chat stopped','AbortError'));
    permissionResolver.current?.(null);permissionResolver.current=null;setPendingPermission(null);
    appendMessage(task.id,{id:createClientId(),role:'assistant',content:'已停止这次回复。连接关闭后，未结算的模型请求会释放预占额度；已经完成结算的部分按实际用量计费。',cancelled:true,createdAt:new Date().toISOString()});
    setAgentStatus('已停止');setNotice('已停止回复，正在刷新额度状态。');
    try{
      let shell=task;
      try{const result=await cancelRemoteTask(token,shell);shell=result.task;replaceTask(shell);}
      catch{
        const latest=(await listTasks(token)).find((item)=>item.id===task.id);
        if(latest&&(latest.status==='draft'||latest.status==='running'||latest.status==='waiting')){const result=await cancelRemoteTask(token,latest);shell=result.task;replaceTask(shell);}
        else if(latest)replaceTask(latest);
      }
      await refreshWallet();
      if(sessionTokenRef.current===token)setNotice('回复已停止；未结算请求会在连接关闭后释放预占额度。');
    }catch{
      if(sessionTokenRef.current===token)setNotice('回复已停止；对话列表状态稍后可手动刷新。');
    }finally{if(sessionTokenRef.current===token)setCancellingTaskId((current)=>current===task.id?'':current);}
  };
  const resolvePermission = (optionId: string | null) => { permissionResolver.current?.(optionId); permissionResolver.current = null; setPendingPermission(null); };
  const handleOpenProject = async () => {
    if (!hasDesktopBridge()) { setNotice('Web 端不能读取服务器或本机文件。请在 COD Desktop 中选择项目。'); return; }
    try {
      const root=await selectProjectRoot();
      if(!root)return;
      const generation=++projectLoadGenerationRef.current;
      storageSet('cod.project.root',root);
      setProjectDiffStatus('loading');
      setProject({...emptyProject,root});
      await loadProjectForDisplay(root,generation,'项目打开失败');
    }
    catch (error) { setNotice(error instanceof Error ? error.message : '项目打开失败'); }
  };
  const refreshProject = async () => {
    if (!hasDesktopBridge() || !project.root) { setNotice('请先在 COD Desktop 中选择项目。'); return; }
    try { const generation=++projectLoadGenerationRef.current;setProjectDiffStatus('loading');await loadProjectForDisplay(project.root,generation,'项目刷新失败',true); }
    catch (error) { setNotice(error instanceof Error ? error.message : '项目刷新失败'); }
  };
  const handleFileSelect = async (file: WorkspaceFile) => {
    const fileReadGeneration=++fileReadGenerationRef.current;
    if (file.kind !== 'file' || !project.root) return;
    const root=project.root;const generation=projectLoadGenerationRef.current;
    try {
      const content=await readProjectFile(root,file.path);
      if(fileReadGeneration!==fileReadGenerationRef.current||generation!==projectLoadGenerationRef.current||projectRootRef.current!==root)return;
      setProject((current)=>{
        if(fileReadGeneration!==fileReadGenerationRef.current||current.root!==root||generation!==projectLoadGenerationRef.current)return current;
        const next={...current,selectedFile:file.path,selectedContent:content};validatedProjectRef.current=next;return next;
      });
    }
    catch (error) { if(fileReadGeneration===fileReadGenerationRef.current&&generation===projectLoadGenerationRef.current&&projectRootRef.current===root)setNotice(error instanceof Error ? error.message : '文件读取失败'); }
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
  const refreshDesktopPetStatus = async () => {
    const getStatus=window.codDesktop?.getDesktopPetStatus;if(!getStatus)return;
    setDesktopPetBusy(true);
    try{setDesktopPetStatus(await getStatus());}catch(error){setNotice(error instanceof Error?error.message:'桌面伙伴状态读取失败。');}
    finally{setDesktopPetBusy(false);}
  };
  const handleDesktopPetLaunch = async () => {
    const launch=window.codDesktop?.launchDesktopPet;
    if(!launch){setNotice('当前 COD Desktop 版本不支持桌面伙伴。');return;}
    if(!session||!selectedSource?.callable||!selectedModelInfo){setNotice('请先登录并选择可用模型，再启动桌面伙伴。');return;}
    setDesktopPetBusy(true);
    try{
      const result=await launch({token:session.token,sourceId:selectedSource.id,modelId:selectedModelInfo.id});
      setDesktopPetStatus(result.status);
      setNotice(result.focusedExisting?'已唤醒现有桌宠；如仍显示演示模式，请退出桌宠后从 COD 重新启动。':result.started?'桌面伙伴已连接当前模型。':'桌面伙伴未能保持运行。');
    }catch(error){setNotice(error instanceof Error?error.message:'桌面伙伴启动失败。');}
    finally{setDesktopPetBusy(false);}
  };
  const handleDesktopPetStop = async () => {
    const stop=window.codDesktop?.stopDesktopPet;if(!stop)return;
    setDesktopPetBusy(true);
    try{setDesktopPetStatus(await stop());setNotice('由 COD 启动的桌面伙伴已停止。');}
    catch(error){setNotice(error instanceof Error?error.message:'桌面伙伴停止失败。');}
    finally{setDesktopPetBusy(false);}
  };
  const hiddenMobileContextCount = 3 + Number(Boolean(selectedSource)) + Number(Boolean(selectedModelInfo));
  const isNativeHost = Boolean(getCodRuntime().hostPlatform);
  const showDownloadEntry = !isNativeHost && !hasDesktopBridge();
  const handleOpenDownloadPage = () => void openCodExternalUrl(new URL('/download/index.html', window.location.origin).href);
  const sendHint=isNativeHost?'发送':window.codDesktop?.platform==='darwin'?'⌘ Enter 发送':'Ctrl / ⌘ Enter 发送';
  const computeRequestCounts={
    pending:computeRequests.filter((item)=>item.status==='submitted').length,
    coordinating:computeRequests.filter((item)=>item.status==='contacting'||item.status==='quoted'||item.status==='approved').length,
    active:computeRequests.filter((item)=>item.status==='deploying'||item.status==='running').length,
    attention:computeRequests.filter((item)=>item.status==='action_required').length,
  };

  return <div className={`app-shell${inspectorOpen ? '' : ' inspector-hidden'}`}>
    <aside className="rail"><Brand /><div className="rail-actions"><button className={`icon-button mobile-rail-primary ${mode === 'code' ? 'active' : ''}`} title="任务" aria-label="任务" onClick={() => { if(hasDesktopBridge())selectWorkspaceMode('code');setSidebarOpen(true); }}><ListChecks weight="fill" /></button><button className={`icon-button mobile-rail-primary ${mode === 'chat' ? 'active' : ''}`} title="普通对话" aria-label="普通对话" onClick={() => selectWorkspaceMode('chat')}><ChatCircleDots /></button>{taskboardUrl && <button className={overlay === 'taskboard' ? 'icon-button mobile-rail-secondary active' : 'icon-button mobile-rail-secondary'} title="任务看板" aria-label="任务看板" onClick={() => setOverlay('taskboard')}><Kanban weight="fill" /></button>}<button className="icon-button compute-entry mobile-rail-secondary" title="算力市场" aria-label="算力市场" onClick={() => setOverlay('compute')}><Storefront weight="fill" /></button><button className="icon-button mobile-rail-primary" title="模型库" aria-label="模型库" onClick={() => setOverlay('models')}><Stack /></button>{showDownloadEntry && <button type="button" className="icon-button mobile-rail-secondary" title="下载客户端" aria-label="下载客户端" onClick={handleOpenDownloadPage}><DownloadSimple /></button>}<button className="icon-button mobile-rail-secondary" title="命令面板" aria-label="命令面板" onClick={() => setOverlay('commands')}><Command /></button>{products.map((product) => <button className="icon-button mobile-rail-secondary" title={product.name} aria-label={product.name} key={product.id} onClick={() => void handleProductLaunch(product)}><ArrowSquareOut /></button>)}</div><div className="rail-footer"><ThemeToggle colorMode={colorMode} onChange={setColorMode} className="mobile-rail-secondary" /><button className="icon-button mobile-rail-more" title="更多功能" aria-label="更多功能" onClick={() => setOverlay('mobile-menu')}><DotsThree weight="bold" /></button><button className="icon-button mobile-rail-primary" title={session ? '账户' : '登录'} aria-label={session ? '账户' : '登录'} onClick={() => setOverlay(session ? 'account' : 'login')}><UserCircle /></button></div></aside>
    {sidebarOpen && <button className="sidebar-scrim" aria-label="关闭任务栏遮罩" onClick={() => setSidebarOpen(false)} />}
    <aside className={`sidebar ${sidebarOpen ? 'open' : ''}`}><div className="sidebar-head"><div className="sidebar-head-title"><small>工作区</small><strong>{mode === 'code' ? '代码任务' : '对话'}</strong></div><div className="sidebar-head-actions">{sidebarOpen && <button className="mobile-only icon-button sidebar-close-button" type="button" aria-label="关闭任务栏" title="关闭任务栏" onClick={() => setSidebarOpen(false)}><X /></button>}<button className="new-task" onClick={startNewWorkspaceItem}><Plus weight="bold" /> {mode === 'chat' ? '新对话' : '新任务'}</button></div></div><div className="search"><MagnifyingGlass /><input aria-label="搜索任务" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="搜索任务或状态" /></div><TaskList tasks={filteredTasks} devices={devices} activeId={activeTaskId} onSelect={(id) => { setActiveTaskId(id); setSidebarOpen(false); }} /><div className="sidebar-bottom">{notice && <div className="remote-notice">{notice}</div>}<button className="project-switch" onClick={handleOpenProject}><span className="project-icon"><Folder weight="fill" /></span><span><small>当前项目</small><strong>{projectName}</strong></span><CaretDown /></button><div className="balance-preview"><Lightning weight="fill" /><span><small>可用卡时</small><strong>{session ? session.account.billingExempt ? '不限卡时' : `${formatCardHours(creditPacks.summary.availableCardHoursMilli,creditPacks.summary.availableCents)} 卡时` : '登录后查看'}</strong></span><button onClick={() => setOverlay(session ? 'account' : 'login')}>{session ? '卡时包' : '登录'}</button></div></div></aside>
    <main className="workspace"><header className="workspace-header"><div className="task-heading"><button className="mobile-only icon-button" title="打开任务栏" onClick={() => setSidebarOpen(true)}><SidebarSimple /></button><div><h1>{activeTask?.title ?? (session?'新建或选择任务':'新对话')}</h1><p>{project.root || (authState === 'loading' ? '正在连接 COD…' : session ? mode==='chat'?(isNativeHost?'移动端模型对话':'当前设备模型对话'):'Desktop 代码工作区' : '输入消息即可开始')}</p></div><button className="phone-only icon-button mobile-refresh" title="刷新工作区" aria-label="刷新工作区" disabled={manualRefreshBusy} onClick={() => void handleManualRefresh()}>{manualRefreshBusy ? <CircleNotch className="spin" /> : <ArrowClockwise />}</button></div><div className="header-actions">{activeTask && mode==='code' && <span className={`header-status ${activeTask.status}`}>{statusLabels[activeTask.status]}</span>}<div className="mode-switch" aria-label="工作模式">{hasDesktopBridge()&&<button className={mode === 'code' ? 'active' : ''} onClick={() => selectWorkspaceMode('code')}><Code /> 代码</button>}<button className={mode === 'chat' ? 'active' : ''} onClick={() => selectWorkspaceMode('chat')}><ChatCircleDots /> 对话</button></div><select className="source-picker" aria-label="模型源" value={selectedSource?.id ?? ''} onChange={(event) => handleSourceChange(event.target.value)} disabled={!session}><option value="">{authState === 'loading' ? '正在连接…' : '登录后选择模型源'}</option>{session?.sources.map((source) => <option key={source.id} value={source.id}>{source.label} · {source.callable ? '已连接' : source.status === 'catalog' ? '目录' : '不可用'}</option>)}</select><select className="model-picker" aria-label="模型" value={selectedModelInfo?.id ?? ''} onChange={(event) => handleModelChange(event.target.value)} disabled={!session || !sourceModels.length}><option value="">登录后选择模型</option>{sourceModels.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}</select><button className={`icon-button inspector-toggle${inspectorOpen ? ' active' : ''}`} title={inspectorOpen ? '隐藏右侧面板' : '显示右侧面板'} onClick={toggleInspector}><SidebarSimple /></button></div></header>
      <section className="conversation"><div className="conversation-scroll" ref={conversationScrollRef}>{!activeTask && <div className="empty-state"><div className="agent-avatar"><span>C</span></div><h2>休息一下，把任务交给 COD</h2><p>{session ? '选择模型后直接输入消息；首次发送会在当前设备创建并保存这段对话。' : '直接输入消息；发送时再登录，已经写好的内容不会丢失。'}</p>{session && <button className="primary-button" onClick={startNewWorkspaceItem}><Plus /> {mode === 'chat' ? '开始新对话' : '新建代码任务'}</button>}</div>}{activeTask && !activeMessages.length && !activeTask.result && !activeTask.error && <div className="empty-state compact"><StatusGlyph status={activeTask.status} /><h2>{activeTask.title}</h2><p>{mode==='chat'?'这是保存在当前设备上的对话，直接输入消息即可继续。':activeTask.status==='cancelled'?'任务已终止，可重新执行。':`任务已同步到 ${devices.find((device) => device.id === activeTask.deviceId)?.name ?? '目标设备'}。输入内容开始执行。`}</p></div>}{activeTask && !activeMessages.length && (activeTask.result || activeTask.error) && <article className="agent-message"><div className="agent-avatar"><span>C</span></div><div><header><strong>{mode==='chat'?(activeTask.error?'上次对话未完成':'上次对话结果'):(activeTask.error ? '远程任务失败' : '远程任务结果')}</strong></header><MarkdownContent>{activeTask.error ? chatFailureMessage(new Error(activeTask.error)) : activeTask.result ?? ''}</MarkdownContent><small>{formatTime(activeTask.updatedAt)}</small></div></article>}{activeMessages.map((message) => message.role === 'user' ? <article className="user-message" key={message.id}><p>{message.content}</p><small>{formatTime(message.createdAt)}</small></article> : message.role === 'comparison' ? <article className="comparison-message" key={message.id}><header><div><Stack weight="fill" /><span><strong>多模型对比</strong><small>同一问题 · {message.comparisonResults?.length ?? 0} 个模型</small></span></div><time>{formatTime(message.createdAt)}</time></header><div className="comparison-results">{message.comparisonResults?.map((result) => <section className={`${result.error ? 'failed' : ''}${message.selectedComparisonKey === comparisonResultKey(result) ? ' selected' : ''}`.trim()} key={`${result.sourceId}-${result.model}`}><header><span><strong>{result.model}</strong><small>{result.sourceLabel}</small></span><div><i>{result.error ? '失败' : `${(result.durationMs / 1000).toFixed(1)}s`}</i>{!result.error&&<button type="button" aria-pressed={message.selectedComparisonKey === comparisonResultKey(result)} onClick={()=>chooseComparisonModel(message.id,result)}>{message.selectedComparisonKey === comparisonResultKey(result) ? '已用于后续对话' : '选用此回答'}</button>}</div></header><MarkdownContent className={result.error ? 'comparison-error' : ''}>{result.error ?? result.content}</MarkdownContent><footer>{result.inputTokens !== undefined && result.outputTokens !== undefined ? `输入 ${result.inputTokens.toLocaleString('zh-CN')} / 输出 ${result.outputTokens.toLocaleString('zh-CN')} Token` : '未返回 Token 用量'}</footer></section>)}</div></article> : <article className={`agent-message${message.failed ? ' failed' : message.cancelled?' cancelled':''}`} key={message.id}><div className="agent-avatar"><span>{message.failed ? '!' : message.cancelled?'■':'C'}</span></div><div><header><strong>{message.failed ? '本次未扣费' : message.cancelled?'已停止':'COD Agent'}</strong>{message.mode === 'demo' && <span className="demo-chip">演示响应</span>}{message.sourceLabel && <span className="source-chip">{message.sourceLabel} · {message.model}{message.fallbackUsed ? '（健康模型降级）' : ''}{message.inputTokens !== undefined && message.outputTokens !== undefined ? ` · 输入 ${message.inputTokens.toLocaleString('zh-CN')} / 输出 ${message.outputTokens.toLocaleString('zh-CN')} Token${message.usageEstimated ? '（估算）' : ''}` : ''}</span>}</header><MarkdownContent>{message.content}</MarkdownContent>{message.failed && message.retryPrompt && <button className="retry-message" disabled={isSending} onClick={() => void handleSend(message.retryPrompt, activeTask, mode)}><ArrowClockwise /> 重试这条消息</button>}<small>{formatTime(message.createdAt)}</small></div></article>)}{isSending && <div className="agent-intro"><div className="agent-avatar"><span>C</span></div><div><strong>COD Agent</strong><small>{agentStatus}</small></div><span className="live-chip"><CircleNotch className="spin" /> 正在回复</span></div>}{pendingPermission && <div className="live-permission"><PermissionRequestSummary summary={pendingPermission.summary} showPersistentWarning={permissionOptionsRequirePersistentWarning(pendingPermission.options)} /><p>Goose 请求执行权限，请确认本次操作。建议优先选择单次授权。</p><div>{presentPermissionOptions(pendingPermission.options).map((option) => <button className={option.kind === 'allow_once' ? 'approve' : option.kind.endsWith('always') ? 'persistent' : ''} key={option.optionId} title={option.kind.endsWith('always') ? '在当前 Agent 会话的后续同类操作中持续生效' : undefined} onClick={() => resolvePermission(option.optionId)}>{permissionOptionLabel(option)}</button>)}<button onClick={() => resolvePermission(null)}>取消</button></div></div>}</div>
        <div className="composer-wrap">
          {activeTask && mode==='chat' && isSending && activeRunRef.current?.taskId===activeTask.id && <div className="task-actions"><button className="cancel-task" onClick={() => void stopActiveChat(activeTask)} disabled={Boolean(cancellingTaskId)}>{cancellingTaskId===activeTask.id?<CircleNotch className="spin"/>:<Stop weight="fill"/>}{cancellingTaskId===activeTask.id?'正在停止':'停止回复'}</button></div>}
          {activeTask && mode==='code' && <div className="task-actions">{(activeTask.status === 'draft' || activeTask.status === 'failed' || activeTask.status === 'complete' || activeTask.status==='cancelled') && <button onClick={() => executeSynchronizedTask(activeTask)} disabled={isSending}><Play /> {activeTask.status === 'failed' ? '重试任务' : activeTask.status === 'complete' ? '继续任务' : activeTask.status==='cancelled'?'重新执行':'执行任务'}</button>}{(activeTask.status === 'running' || activeTask.status === 'waiting') && <><button onClick={() => completeSynchronizedTask(activeTask)} disabled={isSending || cancellingTaskId===activeTask.id}><Check /> 标记完成</button><button className="cancel-task" onClick={() => void cancelSynchronizedTask(activeTask)} disabled={Boolean(cancellingTaskId)}>{cancellingTaskId===activeTask.id?<CircleNotch className="spin"/>:<Stop weight="fill"/>}{cancellingTaskId===activeTask.id?'正在终止':'终止任务'}</button></>}</div>}
          {mode === 'chat' && <div className={`compare-bar${compareEnabled ? ' open' : ''}`}><button type="button" className="compare-toggle" aria-pressed={compareEnabled} onClick={() => setCompareEnabled((current) => !current)}><Stack weight={compareEnabled ? 'fill' : 'regular'} /><span><strong>多模型对比</strong><small>{compareEnabled ? `已选 ${compareTargets.length} 个模型` : '同一问题并行比较 2-4 个模型'}</small></span><i>{compareEnabled ? '已开启' : '开启'}</i></button>{compareEnabled && <div className="compare-picker"><header><span>选择模型</span><small>本次发送将产生 {compareTargets.length} 次独立计费请求</small></header><div>{callableModels.map((target) => { const checked=compareModelKeys.includes(target.key); return <label className={checked ? 'selected' : ''} key={target.key}><input type="checkbox" checked={checked} disabled={!checked&&compareModelKeys.length>=4} onChange={() => toggleCompareModel(target.key)} /><span><strong>{target.model.label}</strong><small>{target.sourceLabel} · 输入 ¥{(target.model.inputPricePerMillionCents/100).toFixed(2)} / 输出 ¥{(target.model.outputPricePerMillionCents/100).toFixed(2)} 每百万</small></span><Check weight="bold" /></label>;})}</div>{callableModels.length<2&&<p>当前可调用模型不足 2 个，暂时无法开始对比。</p>}</div>}</div>}
          <div className={`context-strip${mobileContextExpanded ? ' mobile-expanded' : ''}`}>
            <span className="mobile-context-secondary"><Folder weight="fill" /> {projectName}</span>
            <span className="mobile-context-secondary"><GitDiff /> {projectDiffStatus==='error'?'改动未知':projectDiffStatus==='loading'?'读取改动…':`${changeCount} 个改动`}</span>
            <span className="mobile-context-secondary"><ShieldCheck /> 本机操作需确认</span>
            {selectedSource && <span className="mobile-context-primary" aria-label={selectedSource.paymentDirection} title={selectedSource.paymentDirection}><Lightning weight="fill" /><b className="context-source-desktop" aria-hidden="true">{selectedSource.paymentDirection}</b><b className="context-source-mobile" aria-hidden="true">{selectedSource.label}</b></span>}
            {selectedModelInfo && <span className="mobile-context-primary context-price" aria-label={`输入 ¥${(selectedModelInfo.inputPricePerMillionCents / 100).toFixed(2)} / 输出 ¥${(selectedModelInfo.outputPricePerMillionCents / 100).toFixed(2)} 每百万 Token`} title={`输入 ¥${(selectedModelInfo.inputPricePerMillionCents / 100).toFixed(2)} / 输出 ¥${(selectedModelInfo.outputPricePerMillionCents / 100).toFixed(2)} 每百万 Token`}><b className="context-price-desktop" aria-hidden="true">输入 ¥{(selectedModelInfo.inputPricePerMillionCents / 100).toFixed(2)} / 输出 ¥{(selectedModelInfo.outputPricePerMillionCents / 100).toFixed(2)} 每百万 Token</b><b className="context-price-mobile" aria-hidden="true">入 ¥{(selectedModelInfo.inputPricePerMillionCents / 100).toFixed(2)} / 出 ¥{(selectedModelInfo.outputPricePerMillionCents / 100).toFixed(2)}</b></span>}
            <button className={selectedSource ? 'mobile-context-secondary' : 'mobile-context-primary'} onClick={handleKnowledge} disabled={knowledgeLoading}>{knowledgeLoading ? <CircleNotch className="spin" /> : <MagnifyingGlass />} 期算知识库</button>
            <button className={selectedModelInfo ? 'mobile-context-secondary' : 'mobile-context-primary'} onClick={handleRemoteTask}><PaperPlaneTilt /> 发送到设备</button>
            <button className="context-more-toggle" type="button" aria-expanded={mobileContextExpanded} aria-label={mobileContextExpanded ? '收起上下文信息' : `展开更多上下文信息，共 ${hiddenMobileContextCount} 项`} onClick={() => setMobileContextExpanded((current) => !current)}><CaretDown /> {mobileContextExpanded ? '收起' : '更多'}</button>
          </div>
          {notice && <div className="remote-notice"><span>{notice}</span><button title="关闭提示" onClick={() => setNotice('')}><X /></button></div>}
          {knowledgeHits.length > 0 && <div className="knowledge-strip">{knowledgeHits.map((hit) => <button type="button" key={hit.id} onClick={()=>void openCodExternalUrl(hit.url)}><strong>{hit.title}</strong><span>{hit.excerpt}</span></button>)}</div>}
          <div className="composer"><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void handleSend(); }} placeholder={mode === 'code' ? '让 COD 修改、检查或解释这个项目...' : compareEnabled ? `输入一个问题，同时询问 ${compareTargets.length} 个模型...` : '问 COD 任何问题...'} /><div className="composer-footer">{hasDesktopBridge() && <button className="composer-tool" title="查看项目文件" onClick={() => setInspectorTab('files')}><Plus /></button>}<span>{compareEnabled&&mode==='chat'?`${compareTargets.length} 个模型 · 独立计费`:sendHint}</span><button className="send" title="发送" disabled={!prompt.trim() || isSending || Boolean(session && (compareEnabled&&mode==='chat' ? compareTargets.length<2 : !selectedSource?.callable && !(mode === 'code' && hasDesktopBridge() && project.root)))} onClick={() => void handleSend()}>{isSending ? <CircleNotch className="spin" /> : <PaperPlaneTilt weight="fill" />}</button></div></div>
        </div></section>
    </main>
    {inspectorOpen && <aside className="inspector"><div className="inspector-tabs"><button className={inspectorTab === 'changes' ? 'active' : ''} onClick={() => setInspectorTab('changes')}><GitDiff /> 改动</button><button className={inspectorTab === 'files' ? 'active' : ''} onClick={() => setInspectorTab('files')}><Folder /> 文件</button><button className={inspectorTab === 'terminal' ? 'active' : ''} onClick={() => setInspectorTab('terminal')}><TerminalWindow /> 终端</button><button className="inspector-close" title="隐藏右侧面板" onClick={toggleInspector}><X /></button></div><div className={`inspector-body ${inspectorTab}`}>{inspectorTab === 'changes' && <><div className="panel-title"><span><GitDiff /> 未提交改动</span><button title="刷新" onClick={refreshProject}><ArrowClockwise /></button></div>{!project.root?<div className="panel-empty">Web 端不伪造 Diff。请在 COD Desktop 中选择本机项目。</div>:projectDiffStatus==='loading'?<div className="panel-empty">正在读取 Git 改动…</div>:projectDiffStatus==='error'?<div className="panel-empty">Git 改动读取失败，可点击刷新重试。</div>:<CodeBlock text={project.diff || '当前项目没有未提交改动。'} />}</>}{inspectorTab === 'files' && <>{project.root ? <><div className="panel-title"><span><Folder /> 项目文件</span><small>{project.files.length}</small></div><FileTree files={project.files} selected={project.selectedFile} onSelect={handleFileSelect} />{project.selectedFile && <div className="file-preview"><strong>{project.selectedFile}</strong><CodeBlock text={project.selectedContent} /></div>}</> : <div className="panel-empty">本机文件仅在 COD Desktop 中可用。</div>}</>}{inspectorTab === 'terminal' && <>{window.codDesktop && project.root ? <><div className="panel-title"><span><TerminalWindow /> 本地终端</span><small>desktop</small></div><div className="terminal"><pre>{terminalOutput}</pre><div className="terminal-command"><span>$</span><input aria-label="终端命令" value={command} onChange={(event) => setCommand(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && handleRun()} /><button onClick={handleRun}>运行</button></div></div></> : <div className="panel-empty">Web 端不会执行或伪造终端结果。请使用 COD Desktop。</div>}</>}</div></aside>}
    {overlay === 'login' && <Modal title={pendingSend ? '登录后继续' : initialAuthMode === 'register' ? '注册 COD' : '登录 COD'} onClose={() => { cancelAuthentication();setPendingSend(null);setResumeComputeAfterLogin(false);setInitialAuthMode('login');setOverlay(null); }}><LoginForm capabilities={capabilities} capabilityError={capabilityError} resumeConversation={Boolean(pendingSend)} initialMode={initialAuthMode} onModeChange={setInitialAuthMode} onCancelAuthentication={cancelAuthentication} onLogin={handleLogin} onRegister={handleRegister} /></Modal>}
    {overlay === 'models' && <Modal title="模型库" wide onClose={() => setOverlay(null)}><ModelLibrary sources={modelCatalog} error={modelCatalogError} signedIn={Boolean(session)} onLogin={() => setOverlay('login')} /></Modal>}
    {overlay === 'compute' && <Modal title="COD 算力市场 · 租赁 / 上架 / 托管 / 分期" wide onClose={() => setOverlay(null)}><ComputeMarket offers={computeOffers} requests={computeRequests} signedIn={Boolean(session)} draft={computeDraft} onDraftChange={setComputeDraft} onLogin={() => { setResumeComputeAfterLogin(true); setOverlay('login'); }} onSubmit={handleComputeRequest} onQuoteDecision={handleComputeQuoteDecision} /></Modal>}
    {overlay === 'compute-admin' && session?.account.role === 'admin' && <Modal title="管理员 · 算力申请" wide onClose={() => setOverlay('account')}><AdminComputeRequests token={session.token} /></Modal>}
    {overlay === 'taskboard' && taskboardUrl && <section className="product-overlay taskboard-overlay" role="dialog" aria-modal="true" aria-label="任务看板"><header><div><Kanban weight="fill" /><span><strong>任务看板</strong><small>本地 Dashi Taskboard</small></span></div><button type="button" onClick={() => setOverlay(null)}><X /> 关闭</button></header><iframe title="Dashi Taskboard" src={taskboardUrl} referrerPolicy="no-referrer" sandbox="allow-downloads allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts" /></section>}
    {overlay === 'desktop-pet' && <Modal title="COD 桌面伙伴" onClose={() => setOverlay(null)}><div className="desktop-pet-panel"><div className="desktop-pet-state"><span className={desktopPetStatus?.running?'is-running':desktopPetStatus?.verified?'is-ready':'is-blocked'}><ChatCircleDots weight="fill" /></span><div><strong>{desktopPetStatus?.running?'正在运行':desktopPetStatus?.verified?'已就绪':desktopPetStatus?.reason==='integrity-failed'?'文件校验失败':'尚未安装'}</strong><p>{desktopPetStatus?.running?`已通过 COD 临时代理连接 ${selectedSource?.label??'当前模型'} · ${selectedModelInfo?.label??selectedModelInfo?.id??''}`:desktopPetStatus?.verified?`已审计版本 ${desktopPetStatus.version}，点击后连接当前登录账户与模型。`:desktopPetStatus?.reason==='integrity-failed'?'检测到的文件与已审计版本不一致，COD 不会运行它。':'请先安装 COD 桌宠 0.7.0，再刷新检测状态。'}</p></div></div><div className="desktop-pet-audit"><ShieldCheck weight="bold" /><div><strong>完整性已校验，发行签名未完成</strong><p>三端业务包哈希一致；macOS 尚无 Developer ID/公证，Windows 尚无 Authenticode。当前仅建议内部测试，不会随 COD 静默自启。</p></div></div><div className="desktop-pet-actions"><button type="button" className="secondary-button" disabled={desktopPetBusy} onClick={() => void refreshDesktopPetStatus()}>{desktopPetBusy?<CircleNotch className="spin"/>:<ArrowClockwise/>}刷新检测</button>{desktopPetStatus?.running?<button type="button" className="primary-button" disabled={desktopPetBusy} onClick={() => void handleDesktopPetStop()}><Stop weight="fill"/>停止桌宠</button>:<button type="button" className="primary-button" disabled={desktopPetBusy||!desktopPetStatus?.verified||!session||!selectedSource?.callable||!selectedModelInfo} onClick={() => void handleDesktopPetLaunch()}><Play weight="fill"/>连接并启动</button>}</div>{!session&&<p className="desktop-pet-help">登录 COD 后，桌宠才会启用真实模型对话；未登录时不会以演示回复冒充模型结果。</p>}</div></Modal>}
    {overlay === 'new-task' && session && <Modal title="新建任务" onClose={() => setOverlay(null)}><form className="modal-form" onSubmit={handleCreateTask}><label>任务标题<input aria-label="任务标题" value={newTaskTitle} onChange={(event) => setNewTaskTitle(event.target.value)} placeholder="例如：审计登录流程" required autoFocus /></label><label>目标设备<select aria-label="目标设备" value={targetDeviceId} onChange={(event) => setTargetDeviceId(event.target.value)} required>{!onlineDesktopDevices.length && <option value="">暂无在线 COD Desktop</option>}{onlineDesktopDevices.map((device) => <option key={device.id} value={device.id}>{device.name} · {device.status}</option>)}</select></label><button className="primary-button" disabled={isSending || !newTaskTitle.trim() || !onlineDesktopDevices.some((device) => device.id === targetDeviceId)}><Plus /> {onlineDesktopDevices.length ? '创建并同步' : '等待 Desktop 上线'}</button></form></Modal>}
    {overlay === 'account' && session && <Modal title="钱包与卡时" wide onClose={() => setOverlay(null)}><div className="account-panel">
      <div className="balance-grid"><div className="account-balance"><small>{session.account.billingExempt ? '管理员测试账户' : '钱包余额 · 永久有效'}</small><strong>{session.account.billingExempt ? '不限卡时' : `¥ ${(session.account.balanceCents / 100).toFixed(2)}`}</strong><span>{session.account.billingExempt ? '模型调用会记录零元测试流水，不扣钱包或卡时' : '钱包用于购买卡时包与其他平台服务'}</span></div><div className="account-balance credit"><small>COD 可用卡时 · 优先扣减</small><strong>{formatCardHours(creditPacks.summary.availableCardHoursMilli,creditPacks.summary.availableCents)} 卡时</strong><span>1 卡时 = ¥1.002 · {creditPacks.summary.grants.filter((grant) => grant.status === 'active').length} 个有效批次</span></div></div>
      <section className="compute-account-summary"><header><div><strong>我的算力进度</strong><small>租赁、上架、托管与分期申请统一追踪</small></div><button type="button" onClick={()=>setOverlay('compute')}><Storefront /> 管理算力</button></header><div><span><b>{computeRequestCounts.pending}</b><small>待审核</small></span><span><b>{computeRequestCounts.coordinating}</b><small>对接中</small></span><span><b>{computeRequestCounts.active}</b><small>部署 / 运行</small></span><span><b>{computeRequestCounts.attention}</b><small>待处理</small></span></div></section>
      {session.account.role === 'admin' && <section className="admin-account-entry"><div><ShieldCheck weight="fill" /><span><strong>管理员 · 算力申请</strong><small>查看全站申请人、联系方式和设备需求，并推进处理状态。</small></span></div><button type="button" onClick={() => setOverlay('compute-admin')}><Buildings /> 查看用户申请</button></section>}
      <section className="credit-pack-section"><header><div><strong>{session.account.billingExempt ? '管理员测试账户无需购买卡时' : '钱包购买 180 天卡时包'}</strong><small>{session.account.billingExempt ? '当前账户为不限卡时测试账户；普通用户仍可购买限时卡时包。' : '统一按 1 卡时 = ¥1.002 换算；赠送卡时包含在展示数量中。'}</small></div></header><div className="credit-pack-grid">{creditPacks.packs.map((pack) => <article key={pack.id}><span>{pack.bonusPercent ? `赠 ${pack.bonusPercent}%` : '基础档'}</span><strong>{pack.name}</strong><b>{formatCardHours(pack.cardHoursMilli,pack.creditCents)} <small>卡时</small></b><p>钱包支付 ¥{(pack.priceCents / 100).toFixed(0)} · {pack.validityDays} 天</p><button disabled={session.account.billingExempt || Boolean(purchasingPackId) || session.account.balanceCents < pack.priceCents} onClick={() => void handlePurchaseCreditPack(pack.id)}>{purchasingPackId === pack.id ? <CircleNotch className="spin" /> : <Lightning weight="fill" />} {session.account.billingExempt ? '管理员无需购买' : session.account.balanceCents < pack.priceCents ? '钱包余额不足' : '购买卡时包'}</button></article>)}</div></section>
      {creditPacks.summary.grants.length > 0 && <section className="credit-grants"><header><strong>卡时批次</strong><small>试用卡时 30 天；购买卡时包 180 天</small></header>{creditPacks.summary.grants.map((grant) => <div key={grant.id}><span><strong>{grant.name}</strong><small>{grant.status === 'expired' ? '已过期' : grant.status === 'depleted' ? '已用完' : `有效至 ${new Date(grant.expiresAt).toLocaleDateString('zh-CN')}`}</small></span><b className={grant.status}>{formatCardHours(grant.remainingCardHoursMilli,grant.remainingCents)} / {formatCardHours(grant.originalCardHoursMilli,grant.originalCents)} 卡时</b></div>)}</section>}
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
    {overlay === 'mobile-menu' && <Modal title="更多功能" onClose={() => setOverlay(null)}><div className="command-list mobile-command-list">{taskboardUrl && <button onClick={() => setOverlay('taskboard')}><Kanban /><span><strong>任务看板</strong><small>打开本机 Dashi 任务协作视图</small></span></button>}<button onClick={() => setOverlay('compute')}><Storefront /><span><strong>算力市场</strong><small>租赁、上架、第三方托管与设备分期</small></span></button>{showDownloadEntry && <button onClick={handleOpenDownloadPage}><DownloadSimple /><span><strong>下载客户端</strong><small>查看 Windows、macOS 与 Linux 发布状态</small></span></button>}<button onClick={() => setOverlay('commands')}><Command /><span><strong>命令面板</strong><small>任务、模式与桌面工具入口</small></span></button>{products.map((product) => <button key={product.id} onClick={() => { setOverlay(null); void handleProductLaunch(product); }}><ArrowSquareOut /><span><strong>{product.name}</strong><small>打开已接入的 KAI 产品</small></span></button>)}<button onClick={() => setColorMode(colorMode === 'dark' ? 'light' : 'dark')}>{colorMode === 'dark' ? <Sun /> : <Moon />}<span><strong>{colorMode === 'dark' ? '使用浅色模式' : '使用深色模式'}</strong><small>切换当前设备的界面主题</small></span></button></div></Modal>}
    {overlay === 'commands' && <Modal title="命令面板" onClose={() => setOverlay(null)}><div className="command-list"><button onClick={startNewWorkspaceItem}><Plus /><span><strong>{mode==='chat'?'新对话':'新建任务'}</strong><small>{mode==='chat'?'直接使用当前设备上的模型':'创建并同步到 Desktop'}</small></span></button>{hasDesktopBridge()&&<button onClick={() => { selectWorkspaceMode('code'); setOverlay(null); }}><Code /><span><strong>代码模式</strong><small>进入项目与 Agent 工作区</small></span></button>}<button onClick={() => { selectWorkspaceMode('chat'); setOverlay(null); }}><ChatCircleDots /><span><strong>普通对话</strong><small>使用选定模型提问</small></span></button>{window.codDesktop?.getDesktopPetStatus&&<button onClick={() => setOverlay('desktop-pet')}><ChatCircleDots weight="fill"/><span><strong>桌面伙伴</strong><small>{desktopPetStatus?.running?'正在运行并连接当前模型':desktopPetStatus?.verified?'已安装，连接当前模型后启动':desktopPetStatus?.reason==='integrity-failed'?'文件校验失败，需要重新安装':'检测、启动与管理 COD 桌宠'}</small></span></button>}<button onClick={() => setOverlay('compute')}><Storefront /><span><strong>算力市场</strong><small>H100 卡时、闲置卡、第三方托管与设备分期</small></span></button><button onClick={() => setOverlay('models')}><Stack /><span><strong>模型库</strong><small>查看可用模型与每百万 Token 价格</small></span></button>{showDownloadEntry && <button onClick={handleOpenDownloadPage}><DownloadSimple /><span><strong>下载客户端</strong><small>查看桌面版本和正式发布状态</small></span></button>}{hasDesktopBridge()&&<button onClick={() => { setInspectorTab('terminal'); setOverlay(null); }}><TerminalWindow /><span><strong>打开终端</strong><small>运行受控本机命令</small></span></button>}<button onClick={() => setOverlay(session ? 'account' : 'login')}><UserCircle /><span><strong>账户与服务状态</strong><small>余额、流水和接入状态</small></span></button></div></Modal>}
  </div>;
}
