import { app, BrowserWindow, dialog, ipcMain, session, shell, type IpcMainInvokeEvent } from 'electron';
import { execFile } from 'node:child_process';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import type { AgentGatewayConfig, DesktopPetLaunchConfig, DesktopPetLaunchResult, DesktopPetStatus, TerminalResult } from '@cod/contracts';
import { startAcpProxy, type AcpProxy } from './acp-proxy.js';
import { mintAgentSession } from './agent-session.js';
import { BuiltInDesktopPet } from './built-in-desktop-pet.js';
import { commandPathCandidates, commandPolicyViolation, isWithinRoot, parseCommand, validateCommandPath } from './command-policy.js';
import { commandTimedOut, executeGitCommand } from './git-command.js';
import { desktopPetEnvironment, discoverDesktopPet, type DesktopPetInstallation } from './desktop-pet.js';
import { collectUntrackedDiff, stagedGitDiffArguments, unstagedGitDiffArguments } from './git-diff.js';
import { minimalGooseEnvironment } from './goose-environment.js';
import { forceTerminateChildProcess, GooseLaunchCoordinator, terminateChildProcess } from './goose-lifecycle.js';
import { cleanupAbandonedGooseSidecar, clearGooseOwnershipRecord, saveGooseOwnershipRecord } from './goose-ownership.js';
import { isAllowedDevelopmentNavigation, isSafeExternalUrl } from './navigation-policy.js';
import { resolveCommandInvocation } from './platform-command.js';
import { loadApprovedProjectRoots, maximumApprovedProjectRoots, saveApprovedProjectRoots } from './project-roots.js';
import { defaultDesktopControlPlaneUrl, defaultDesktopDevelopmentUrl, isTrustedRendererUrl, resolveDesktopRuntimeUrls } from './runtime-policy.js';
import { resolveTaskboardUrl } from './taskboard-url.js';
import { startPetChatProxy, type PetChatProxy } from './pet-chat-proxy.js';
import { collectWorkspaceFiles, readWorkspaceTextFile } from './workspace-files.js';

const execFileAsync = promisify(execFile);
const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
let controlPlaneUrl = defaultDesktopControlPlaneUrl;
let developmentUrl = defaultDesktopDevelopmentUrl;
let runtimeConfigurationError: Error | null = null;
try {
  ({ controlPlaneUrl, developmentUrl } = resolveDesktopRuntimeUrls(process.env, app.isPackaged));
} catch (error) {
  runtimeConfigurationError = error instanceof Error ? error : new Error('Desktop runtime configuration is invalid');
}
const packagedEntryPath = path.join(process.resourcesPath, 'web', 'app', 'index.html');
const packagedEntryUrl = pathToFileURL(packagedEntryPath).href;
const gitProbeTimeoutMilliseconds = 3_000;
const gitDiffTimeoutMilliseconds = 15_000;
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();
const approvedProjectRoots = new Set<string>();
let gooseSidecar: ChildProcess | null = null;
let gooseAcpProxy: AcpProxy | null = null;
let gooseAcpUrl: string | null = null;
let gooseConfigurationKey: string | null = null;
let gooseAgentTokenExpiresAt = 0;
let desktopPetProcess: ChildProcess | null = null;
let desktopPetProxy: PetChatProxy | null = null;
let builtInDesktopPet: BuiltInDesktopPet | null = null;
let mainWindow: BrowserWindow | null = null;
const gooseLaunchCoordinator = new GooseLaunchCoordinator();

function trustedRendererWebSocketOrigins(): string[] {
  return app.isPackaged ? ['file://', 'null'] : [new URL(developmentUrl).origin];
}

function assertTrustedIpcSender(event: IpcMainInvokeEvent): void {
  const senderUrl = event.senderFrame?.url ?? '';
  if (!isTrustedRendererUrl(senderUrl, app.isPackaged, developmentUrl, packagedEntryUrl)) {
    throw new Error('IPC request was not sent by the COD renderer');
  }
}

function openExternalUrl(rawUrl: string): void {
  if (!isSafeExternalUrl(rawUrl)) return;
  void shell.openExternal(rawUrl).catch(() => {
    dialog.showErrorBox('无法打开链接', '系统浏览器没有接受这个 HTTPS 链接。请检查默认浏览器设置后重试。');
  });
}

async function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 3284;
      server.close(() => resolve(port));
    });
  });
}

async function waitForGoose(port: number, processToWatch: ChildProcess, attempts = 50): Promise<void> {
  let startupError: Error | null = null;
  const handleError = (error: Error) => { startupError = new Error(`Goose sidecar failed to start: ${error.message}`); };
  const handleExit = (code: number | null, signal: NodeJS.Signals | null) => {
    startupError = new Error(`Goose sidecar exited before becoming ready${code !== null ? ` (exit ${code})` : signal ? ` (${signal})` : ''}`);
  };
  processToWatch.once('error', handleError);
  processToWatch.once('exit', handleExit);
  try {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (processToWatch.exitCode !== null || processToWatch.signalCode !== null) {
        throw new Error(`Goose sidecar exited before becoming ready${processToWatch.exitCode !== null ? ` (exit ${processToWatch.exitCode})` : ` (${processToWatch.signalCode})`}`);
      }
      if (startupError) throw startupError;
      try {
        const response = await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(500) });
        if (response.ok) return;
      } catch {
        // The sidecar is still starting.
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (startupError) throw startupError;
    throw new Error('Goose sidecar did not become ready');
  } finally {
    processToWatch.removeListener('error', handleError);
    processToWatch.removeListener('exit', handleExit);
  }
}

async function stopGooseSidecar(): Promise<void> {
  const processToStop = gooseSidecar;
  const processId = processToStop?.pid;
  const proxyToStop = gooseAcpProxy;
  gooseSidecar = null;
  gooseAcpProxy = null;
  gooseAcpUrl = null;
  gooseConfigurationKey = null;
  gooseAgentTokenExpiresAt = 0;
  if (proxyToStop) await proxyToStop.close();
  await terminateChildProcess(processToStop);
  if (processId) await clearGooseOwnershipRecord(gooseOwnershipFile(), processId).catch(() => undefined);
}

function gooseOwnershipFile(): string {
  return path.join(app.getPath('userData'), 'goose-sidecar-owner.json');
}

async function prepareGooseStorage(): Promise<{ pathRoot: string; stateHome: string | null }> {
  // Never load plugins, provider credentials, or settings from a user's
  // unrelated standalone Goose installation. COD owns an isolated state tree.
  const pathRoot = path.join(app.getPath('userData'), 'goose-runtime');
  await fs.mkdir(pathRoot, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') return { pathRoot, stateHome: null };
  await fs.chmod(pathRoot, 0o700);
  const stateHome = path.join(pathRoot, 'xdg-state');
  const logsDirectory = path.join(stateHome, 'goose', 'logs');
  await fs.mkdir(logsDirectory, { recursive: true, mode: 0o700 });
  await fs.chmod(logsDirectory, 0o700);
  return { pathRoot, stateHome };
}

function validateAgentGatewayConfig(config: AgentGatewayConfig): void {
  if (typeof config?.token !== 'string' || !config.token || config.token.length > 8_192 || /[\0\r\n]/.test(config.token)) {
    throw new Error('A valid COD session is required');
  }
  if (typeof config.sourceId !== 'string' || !/^[a-z0-9-]{2,40}$/.test(config.sourceId)) throw new Error('Invalid model source');
  if (typeof config.modelId !== 'string' || !config.modelId || config.modelId.length > 200 || /[\0\r\n]/.test(config.modelId)) throw new Error('Invalid model');
  if (typeof config.taskId !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(config.taskId)) throw new Error('Invalid task');
  if (typeof config.executionId !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(config.executionId)) throw new Error('Invalid task execution');
  if (typeof config.leaseToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(config.leaseToken)) throw new Error('Invalid task lease');
  if (typeof config.root !== 'string'
    || !config.root
    || config.root.length > 4_096
    || /[\0\r\n]/.test(config.root)) throw new Error('Invalid project root');
}

async function ensureGooseSidecarSerialized(config: AgentGatewayConfig, assertCurrent: () => void): Promise<string | null> {
  validateAgentGatewayConfig(config);
  const resolvedRoot = await approvedProjectRoot(config.root);
  assertCurrent();
  const configuredBase = app.isPackaged ? null : process.env.COD_GOOSE_ACP_URL;
  const configuredToken = app.isPackaged ? null : process.env.COD_GOOSE_ACP_TOKEN;
  const configurationKey = createHash('sha256').update(`${config.token}\0${config.sourceId}\0${config.modelId}\0${config.taskId}\0${config.executionId}\0${config.leaseToken}\0${resolvedRoot}`).digest('hex');
  if (gooseAcpProxy && gooseAcpUrl && gooseConfigurationKey === configurationKey && gooseAgentTokenExpiresAt > Date.now() + 60_000) return gooseAcpUrl;
  if (gooseSidecar || gooseAcpProxy) {
    await stopGooseSidecar();
    assertCurrent();
  }

  if (configuredBase || configuredToken) {
    if (!configuredBase || !configuredToken) throw new Error('Both COD_GOOSE_ACP_URL and COD_GOOSE_ACP_TOKEN are required');
    const configured = new URL(configuredBase);
    if ((configured.protocol !== 'ws:' && configured.protocol !== 'wss:')
      || configured.username
      || configured.password
      || configured.hash) {
      throw new Error('COD_GOOSE_ACP_URL must be a WebSocket URL without credentials or a fragment');
    }
    configured.searchParams.set('token', configuredToken);
    const proxy = await startAcpProxy(configured.toString(), resolvedRoot, { allowedOrigins: trustedRendererWebSocketOrigins() });
    try {
      assertCurrent();
    } catch (error) {
      await proxy.close();
      throw error;
    }
    gooseAcpProxy = proxy;
    gooseAcpUrl = proxy.url;
    gooseConfigurationKey = configurationKey;
    gooseAgentTokenExpiresAt = Number.POSITIVE_INFINITY;
    return gooseAcpUrl;
  }

  const packagedBinary = path.join(process.resourcesPath, 'bin', process.platform === 'win32' ? 'goose.exe' : 'goose');
  const binary = !app.isPackaged && process.env.COD_GOOSE_BINARY ? process.env.COD_GOOSE_BINARY : packagedBinary;
  try {
    await fs.access(binary);
  } catch {
    assertCurrent();
    return null;
  }
  const resolvedBinary = await fs.realpath(binary);
  assertCurrent();
  const controlPlane = new URL(controlPlaneUrl);
  const agentSession = await mintAgentSession(controlPlane, config);
  assertCurrent();
  const gooseStorage = await prepareGooseStorage();
  assertCurrent();
  const port = await availablePort();
  assertCurrent();
  const secret = randomBytes(24).toString('hex');
  controlPlane.pathname = `${controlPlane.pathname.replace(/\/$/, '')}/v1/tasks/${encodeURIComponent(config.taskId)}/sources/${encodeURIComponent(config.sourceId)}`;
  controlPlane.search = '';
  controlPlane.hash = '';
  const spawnedSidecar = spawn(resolvedBinary, ['serve', '--host', '127.0.0.1', '--port', String(port), '--with-builtin', 'developer'], {
    cwd: resolvedRoot,
    stdio: 'ignore',
    windowsHide: true,
    env: {
      ...minimalGooseEnvironment(process.env),
      GOOSE_SERVER__SECRET_KEY: secret,
      GOOSE_PATH_ROOT: gooseStorage.pathRoot,
      GOOSE_WORKING_DIR: resolvedRoot,
      GOOSE_TELEMETRY_ENABLED: 'false',
      GOOSE_PROVIDER: !app.isPackaged && process.env.GOOSE_PROVIDER ? process.env.GOOSE_PROVIDER : 'openai',
      GOOSE_MODEL: config.modelId,
      GOOSE_MODE: !app.isPackaged && process.env.GOOSE_MODE ? process.env.GOOSE_MODE : 'smart_approve',
      OPENAI_MODEL: config.modelId,
      OPENAI_BASE_URL: controlPlane.toString().replace(/\/$/, ''),
      OPENAI_API_KEY: agentSession.token,
      ...(gooseStorage.stateHome ? { XDG_STATE_HOME: gooseStorage.stateHome } : {}),
    },
  });
  const sidecarPid = spawnedSidecar.pid;
  if (!sidecarPid) {
    await terminateChildProcess(spawnedSidecar);
    throw new Error('Goose sidecar failed to expose a process ID');
  }
  gooseSidecar = spawnedSidecar;
  const ownershipReady = saveGooseOwnershipRecord(gooseOwnershipFile(), {
    version: 1,
    ownerPid: process.pid,
    sidecarPid,
    executablePath: resolvedBinary,
    port,
    createdAt: new Date().toISOString(),
  });
  const clearSpawnedSidecar = () => {
    void ownershipReady.then(() => clearGooseOwnershipRecord(gooseOwnershipFile(), sidecarPid)).catch(() => undefined);
    if (gooseSidecar !== spawnedSidecar) return;
    const proxyToClose = gooseAcpProxy;
    gooseSidecar = null;
    gooseAcpProxy = null;
    gooseAcpUrl = null;
    gooseConfigurationKey = null;
    gooseAgentTokenExpiresAt = 0;
    if (proxyToClose) void proxyToClose.close();
  };
  spawnedSidecar.once('exit', clearSpawnedSidecar);
  spawnedSidecar.once('error', clearSpawnedSidecar);
  try {
    await ownershipReady;
    await waitForGoose(port, spawnedSidecar);
    assertCurrent();
    if (spawnedSidecar.exitCode !== null || gooseSidecar !== spawnedSidecar) {
      throw new Error('Goose sidecar exited before accepting an ACP session');
    }
  } catch (error) {
    await terminateChildProcess(spawnedSidecar);
    clearSpawnedSidecar();
    throw error;
  }
  let proxy: AcpProxy | null = null;
  try {
    proxy = await startAcpProxy(`ws://127.0.0.1:${port}/acp?token=${secret}`, resolvedRoot, {
      allowedOrigins: trustedRendererWebSocketOrigins(),
    });
    assertCurrent();
  } catch (error) {
    if (proxy) await proxy.close();
    await terminateChildProcess(spawnedSidecar);
    clearSpawnedSidecar();
    throw error;
  }
  if (spawnedSidecar.exitCode !== null || gooseSidecar !== spawnedSidecar) {
    await proxy.close();
    throw new Error('Goose sidecar exited before the ACP proxy was ready');
  }
  gooseAcpProxy = proxy;
  gooseAcpUrl = proxy.url;
  gooseConfigurationKey = configurationKey;
  gooseAgentTokenExpiresAt = agentSession.expiresAt;
  return gooseAcpUrl;
}

function ensureGooseSidecar(config: AgentGatewayConfig): Promise<string | null> {
  return gooseLaunchCoordinator.run((assertCurrent) => ensureGooseSidecarSerialized(config, assertCurrent));
}

function invalidateAndStopGooseSidecar(): Promise<void> {
  return gooseLaunchCoordinator.invalidate(stopGooseSidecar);
}

function desktopPetIsRunning(): boolean {
  return Boolean(builtInDesktopPet?.running || (desktopPetProcess && desktopPetProcess.exitCode === null && desktopPetProcess.signalCode === null));
}

async function desktopPetDiscovery(): Promise<{ installation: DesktopPetInstallation | null; status: DesktopPetStatus }> {
  const result = await discoverDesktopPet({
    platform: process.platform,
    homeDirectory: app.getPath('home'),
    resourcesPath: process.resourcesPath,
    environment: process.env,
    developmentOverride: app.isPackaged ? undefined : process.env.COD_DESKTOP_PET_PATH,
    bundledResourcePath: app.isPackaged
      ? undefined
      : path.join(moduleDirectory, '..', 'resources', 'desktop-pet', 'app.asar'),
  });
  return { ...result, status: { ...result.status, running: desktopPetIsRunning() } };
}

async function stopDesktopPet(): Promise<DesktopPetStatus> {
  builtInDesktopPet?.stop();
  const processToStop = desktopPetProcess;
  const proxyToStop = desktopPetProxy;
  desktopPetProcess = null;
  desktopPetProxy = null;
  await terminateChildProcess(processToStop);
  if (proxyToStop) await proxyToStop.close().catch(() => undefined);
  return (await desktopPetDiscovery()).status;
}

function validateDesktopPetLaunchConfig(config: DesktopPetLaunchConfig): void {
  if (typeof config?.token !== 'string' || !config.token || config.token.length > 8_192 || /[\0\r\n]/.test(config.token)) {
    throw new Error('请先登录 COD，再启动桌面伙伴。');
  }
  if (typeof config.sourceId !== 'string' || !/^[a-z0-9-]{2,40}$/.test(config.sourceId)) throw new Error('请选择可用的模型源。');
  if (typeof config.modelId !== 'string' || !config.modelId || config.modelId.length > 200 || /[\0\r\n]/.test(config.modelId)) {
    throw new Error('请选择可用的模型。');
  }
}

async function launchDesktopPet(config: DesktopPetLaunchConfig): Promise<DesktopPetLaunchResult> {
  validateDesktopPetLaunchConfig(config);
  const discovery = await desktopPetDiscovery();
  if (!discovery.installation || !discovery.status.verified) {
    const message = discovery.status.reason === 'integrity-failed'
      ? '检测到桌宠文件，但它与已审计的 0.7.0 版本不一致，COD 已拒绝运行。'
      : '尚未安装已审计的 COD 桌宠 0.7.0。';
    throw new Error(message);
  }
  if (desktopPetIsRunning()) {
    if (builtInDesktopPet?.running) {
      const result = await builtInDesktopPet.start();
      return { status: { ...discovery.status, running: true }, ...result };
    }
    return { status: discovery.status, started: false, focusedExisting: false };
  }
  await stopDesktopPet();
  if (discovery.installation.kind === 'integrated') {
    const proxy = await startPetChatProxy({ controlPlaneUrl, ...config });
    builtInDesktopPet ??= new BuiltInDesktopPet({
      resourceAsarPath: discovery.installation.executablePath,
      onOpenCod: (prompt) => {
        const window = mainWindow;
        if (!window || window.isDestroyed()) {
          void createWindow().then(() => {
            mainWindow?.webContents.send('cod:desktop-pet-open-chat', prompt ?? null);
          });
          return;
        }
        if (window.isMinimized()) window.restore();
        window.show();
        window.focus();
        window.webContents.send('cod:desktop-pet-open-chat', prompt ?? null);
      },
    });
    builtInDesktopPet.configureChat({ endpoint: proxy.url, secret: proxy.secret, model: config.modelId });
    try {
      const result = await builtInDesktopPet.start();
      desktopPetProxy = proxy;
      const status = { ...(await desktopPetDiscovery()).status, running: builtInDesktopPet.running };
      return { status, ...result };
    } catch (error) {
      await proxy.close().catch(() => undefined);
      throw error;
    }
  }
  const proxy = await startPetChatProxy({ controlPlaneUrl, ...config });
  const installation = discovery.installation;
  let spawned: ChildProcess;
  try {
    spawned = spawn(installation.executablePath, [], {
      cwd: installation.rootPath,
      stdio: 'ignore',
      windowsHide: true,
      env: desktopPetEnvironment(process.env, { url: proxy.url, secret: proxy.secret, model: config.modelId }),
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => { spawned.removeListener('spawn', onSpawn); reject(error); };
      const onSpawn = () => { spawned.removeListener('error', onError); resolve(); };
      spawned.once('error', onError);
      spawned.once('spawn', onSpawn);
    });
  } catch (error) {
    await proxy.close().catch(() => undefined);
    throw error;
  }
  desktopPetProcess = spawned;
  desktopPetProxy = proxy;
  const clearDesktopPet = () => {
    if (desktopPetProcess !== spawned) return;
    desktopPetProcess = null;
    const proxyToClose = desktopPetProxy;
    desktopPetProxy = null;
    if (proxyToClose) void proxyToClose.close().catch(() => undefined);
  };
  spawned.once('exit', clearDesktopPet);
  spawned.once('error', clearDesktopPet);
  await new Promise((resolve) => setTimeout(resolve, 350));
  const running = desktopPetProcess === spawned && spawned.exitCode === null && spawned.signalCode === null;
  const status = { ...(await desktopPetDiscovery()).status, running };
  return { status, started: running, focusedExisting: !running && spawned.exitCode === 0 };
}

async function resolveProjectRoot(root: string): Promise<string> {
  const resolved = await fs.realpath(root);
  const stats = await fs.stat(resolved);
  if (!stats.isDirectory()) throw new Error('Selected project is not a directory');
  return resolved;
}

async function approvedProjectRoot(root: string): Promise<string> {
  const resolved = await resolveProjectRoot(root);
  if (!approvedProjectRoots.has(resolved)) throw new Error('Project access has not been approved in COD Desktop');
  return resolved;
}

function approvedProjectRootsFile(): string {
  return path.join(app.getPath('userData'), 'approved-project-roots.json');
}

async function restoreApprovedProjectRoots(): Promise<void> {
  const restored = await loadApprovedProjectRoots(approvedProjectRootsFile());
  approvedProjectRoots.clear();
  for (const root of restored) approvedProjectRoots.add(root);
  await saveApprovedProjectRoots(approvedProjectRootsFile(), approvedProjectRoots).catch(() => undefined);
}

async function rememberApprovedProjectRoot(root: string): Promise<void> {
  const previousRoots = [...approvedProjectRoots];
  approvedProjectRoots.delete(root);
  approvedProjectRoots.add(root);
  while (approvedProjectRoots.size > maximumApprovedProjectRoots) {
    const oldest = approvedProjectRoots.values().next().value as string | undefined;
    if (!oldest) break;
    approvedProjectRoots.delete(oldest);
  }
  try {
    await saveApprovedProjectRoots(approvedProjectRootsFile(), approvedProjectRoots);
  } catch (error) {
    approvedProjectRoots.clear();
    for (const previousRoot of previousRoots) approvedProjectRoots.add(previousRoot);
    throw error;
  }
}

async function validateCommandPaths(root: string, candidates: string[]): Promise<void> {
  for (const candidate of candidates) await validateCommandPath(root, candidate);
}

async function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  const window = new BrowserWindow({
    width: 1500,
    height: 940,
    minWidth: 760,
    minHeight: 580,
    title: 'COD',
    backgroundColor: '#0d100f',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(moduleDirectory, 'preload.cjs'),
      additionalArguments: [`--cod-control-plane-url=${encodeURIComponent(controlPlaneUrl)}`],
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged,
      webSecurity: true,
      allowRunningInsecureContent: false,
      backgroundThrottling: false,
      spellcheck: true,
    },
  });
  mainWindow = window;
  window.on('closed', () => { if (mainWindow === window) mainWindow = null; });

  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternalUrl(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    const allowedDevelopmentNavigation = !app.isPackaged && isAllowedDevelopmentNavigation(url, developmentUrl);
    if (allowedDevelopmentNavigation) return;
    event.preventDefault();
    openExternalUrl(url);
  });
  window.webContents.on('will-frame-navigate', (event) => {
    if (!event.isMainFrame) event.preventDefault();
  });
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  window.webContents.on('did-start-navigation', (_event, _url, _isInPlace, isMainFrame) => {
    if (isMainFrame) void invalidateAndStopGooseSidecar();
  });
  window.webContents.on('render-process-gone', () => { void invalidateAndStopGooseSidecar(); });
  window.webContents.on('destroyed', () => { void invalidateAndStopGooseSidecar(); });

  if (!app.isPackaged) {
    await window.loadURL(new URL('/app/', developmentUrl).href);
  } else {
    await window.loadFile(packagedEntryPath);
  }
}

ipcMain.handle('cod:select-project', async (event) => {
  assertTrustedIpcSender(event);
  const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
  if (result.canceled) return null;
  const root = await resolveProjectRoot(result.filePaths[0]);
  await rememberApprovedProjectRoot(root);
  return root;
});

ipcMain.handle('cod:list-files', async (event, root: string) => {
  assertTrustedIpcSender(event);
  const resolvedRoot = await approvedProjectRoot(root);
  return collectWorkspaceFiles(resolvedRoot);
});

ipcMain.handle('cod:read-text-file', async (event, root: string, relativePath: string) => {
  assertTrustedIpcSender(event);
  const resolvedRoot = await approvedProjectRoot(root);
  return readWorkspaceTextFile(resolvedRoot, relativePath);
});

ipcMain.handle('cod:git-diff', async (event, root: string) => {
  assertTrustedIpcSender(event);
  try {
    const resolvedRoot = await approvedProjectRoot(root);
    try {
      const { stdout } = await executeGitCommand(resolvedRoot, ['rev-parse', '--is-inside-work-tree'], {
        maxBuffer: 64 * 1024,
        timeoutMilliseconds: gitProbeTimeoutMilliseconds,
      });
      if (stdout.trim() !== 'true') return '当前目录不是 Git 工作区，暂无可显示的改动。';
    } catch (error) {
      if (commandTimedOut(error)) return 'Git 状态读取超时；项目文件仍可正常使用。可检查仓库元数据权限后重试。';
      return '当前目录不是 Git 仓库，暂无可显示的改动。初始化 Git 后即可在这里查看变更。';
    }
    const [{ stdout: unstaged }, { stdout: staged }, untracked] = await Promise.all([
      executeGitCommand(resolvedRoot, unstagedGitDiffArguments(), { maxBuffer: 2 * 1024 * 1024, timeoutMilliseconds: gitDiffTimeoutMilliseconds }),
      executeGitCommand(resolvedRoot, stagedGitDiffArguments(), { maxBuffer: 2 * 1024 * 1024, timeoutMilliseconds: gitDiffTimeoutMilliseconds }),
      collectUntrackedDiff(resolvedRoot),
    ]);
    return [
      unstaged && '# Unstaged changes\n' + unstaged,
      staged && '# Staged changes\n' + staged,
      untracked && '# Untracked files\n' + untracked,
    ].filter(Boolean).join('\n');
  } catch (error) {
    if (commandTimedOut(error)) return 'Git 改动读取超时；项目文件仍可正常使用。请缩小仓库范围或稍后重试。';
    return 'Git 改动读取失败；项目文件仍可正常使用。';
  }
});

ipcMain.handle('cod:get-goose-acp-url', (event, config: AgentGatewayConfig) => {
  assertTrustedIpcSender(event);
  return ensureGooseSidecar(config);
});
ipcMain.handle('cod:stop-goose', (event) => {
  assertTrustedIpcSender(event);
  return invalidateAndStopGooseSidecar();
});
ipcMain.handle('cod:get-taskboard-url', (event) => {
  assertTrustedIpcSender(event);
  return resolveTaskboardUrl({
    configuredUrl: process.env.COD_TASKBOARD_URL,
    configuredRuntimeFile: process.env.COD_TASKBOARD_RUNTIME_FILE,
    homeDirectory: app.getPath('home'),
    platform: process.platform,
  });
});
ipcMain.handle('cod:get-desktop-pet-status', async (event) => {
  assertTrustedIpcSender(event);
  return (await desktopPetDiscovery()).status;
});
ipcMain.handle('cod:launch-desktop-pet', (event, config: DesktopPetLaunchConfig) => {
  assertTrustedIpcSender(event);
  return launchDesktopPet(config);
});
ipcMain.handle('cod:stop-desktop-pet', (event) => {
  assertTrustedIpcSender(event);
  return stopDesktopPet();
});

ipcMain.handle('cod:run-command', async (event, root: string, rawCommand: string): Promise<TerminalResult> => {
  assertTrustedIpcSender(event);
  if (typeof rawCommand !== 'string' || rawCommand.length > 32 * 1024) {
    return { command: typeof rawCommand === 'string' ? rawCommand.slice(0, 200) : '', output: 'Command is invalid or too long.', exitCode: 126 };
  }
  let parts: string[];
  try { parts = parseCommand(rawCommand); }
  catch (error) { return { command: rawCommand, output: error instanceof Error ? error.message : 'Invalid command', exitCode: 126 }; }
  const executable = parts.shift();
  if (!executable) return { command: rawCommand, output: 'Command is empty.', exitCode: 126 };
  const policyViolation = commandPolicyViolation(executable, parts);
  if (policyViolation) return { command: rawCommand, output: policyViolation, exitCode: 126 };
  try {
    const resolvedRoot = await approvedProjectRoot(root);
    await validateCommandPaths(resolvedRoot, commandPathCandidates(executable, parts));
    let invocation;
    try {
      invocation = resolveCommandInvocation(executable, parts);
    } catch (error) {
      return { command: rawCommand, output: error instanceof Error ? error.message : 'Command is invalid', exitCode: 126 };
    }
    const { stdout, stderr } = await execFileAsync(invocation.executable, invocation.args, {
      cwd: resolvedRoot,
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
      killSignal: 'SIGKILL',
      windowsHide: true,
    });
    return { command: rawCommand, output: `${stdout}${stderr}`.trim(), exitCode: 0 };
  } catch (error) {
    const details = error as Error & { stdout?: string; stderr?: string; code?: number };
    return { command: rawCommand, output: `${details.stdout ?? ''}${details.stderr ?? ''}${details.message}`.trim(), exitCode: typeof details.code === 'number' ? details.code : 1 };
  }
});

if (hasSingleInstanceLock) {
  app.whenReady().then(async () => {
    if (runtimeConfigurationError) {
      dialog.showErrorBox('COD 启动配置无效', runtimeConfigurationError.message);
      app.quit();
      return;
    }
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.setDevicePermissionHandler(() => false);
    session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => callback({}));
    session.defaultSession.on('will-download', (event) => event.preventDefault());
    await cleanupAbandonedGooseSidecar(gooseOwnershipFile()).catch(() => undefined);
    await restoreApprovedProjectRoots();
    await createWindow();
    app.on('activate', async () => {
      if (!mainWindow || mainWindow.isDestroyed()) await createWindow();
    });
  });

  app.on('second-instance', () => {
    const window = mainWindow;
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });

  app.on('window-all-closed', () => {
    void invalidateAndStopGooseSidecar();
    void stopDesktopPet();
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => { void invalidateAndStopGooseSidecar(); void stopDesktopPet(); });
  process.once('exit', () => { forceTerminateChildProcess(gooseSidecar); forceTerminateChildProcess(desktopPetProcess); });

  let stoppingForSignal = false;
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    process.once(signal, () => {
      if (stoppingForSignal) {
        forceTerminateChildProcess(gooseSidecar);
        forceTerminateChildProcess(desktopPetProcess);
        process.exit(1);
      }
      stoppingForSignal = true;
      void Promise.all([invalidateAndStopGooseSidecar(), stopDesktopPet()]).finally(() => { process.kill(process.pid, signal); });
    });
  }
}
