import { app, BrowserWindow, dialog, ipcMain, session, shell } from 'electron';
import { execFile } from 'node:child_process';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { AgentGatewayConfig, TerminalResult } from '@cod/contracts';
import { mintAgentSession } from './agent-session.js';
import { commandPathCandidates, commandPolicyViolation, isWithinRoot, parseCommand, validateCommandPath } from './command-policy.js';
import { collectGitDiff } from './git-diff.js';
import { minimalGooseEnvironment } from './goose-environment.js';
import { forceTerminateChildProcess, GooseLaunchCoordinator, terminateChildProcess } from './goose-lifecycle.js';
import { cleanupAbandonedGooseSidecar, clearGooseOwnershipRecord, saveGooseOwnershipRecord } from './goose-ownership.js';
import { loadApprovedProjectRoots, maximumApprovedProjectRoots, saveApprovedProjectRoots } from './project-roots.js';
import { collectWorkspaceFiles } from './workspace-files.js';

const execFileAsync = promisify(execFile);
const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const developmentUrl = process.env.COD_DEV_SERVER_URL || 'http://127.0.0.1:5173';
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();
const approvedProjectRoots = new Set<string>();
let gooseSidecar: ChildProcess | null = null;
let gooseAcpUrl: string | null = null;
let gooseConfigurationKey: string | null = null;
let gooseAgentTokenExpiresAt = 0;
const gooseLaunchCoordinator=new GooseLaunchCoordinator();

function isTrustedExternalUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.protocol === 'https:' && (url.hostname === 'kai.com' || url.hostname.endsWith('.kai.com'));
  } catch {
    return false;
  }
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
        const response = await fetch(`http://127.0.0.1:${port}/status`);
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
  gooseSidecar = null;
  gooseAcpUrl = null;
  gooseConfigurationKey = null;
  gooseAgentTokenExpiresAt = 0;
  await terminateChildProcess(processToStop);
  if (processId) await clearGooseOwnershipRecord(gooseOwnershipFile(), processId).catch(() => undefined);
}

function gooseOwnershipFile(): string {
  return path.join(app.getPath('userData'), 'goose-sidecar-owner.json');
}

async function prepareGooseStateHome(): Promise<string | null> {
  if (process.platform === 'win32') return null;
  const configuredStateHome = process.env.XDG_STATE_HOME;
  const stateHome = configuredStateHome && path.isAbsolute(configuredStateHome)
    ? configuredStateHome
    : path.join(app.getPath('home'), '.local', 'state');
  const logsDirectory = path.join(stateHome, 'goose', 'logs');
  await fs.mkdir(logsDirectory, { recursive: true, mode: 0o700 });
  await fs.chmod(logsDirectory, 0o700);
  return stateHome;
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
}

async function ensureGooseSidecarSerialized(config: AgentGatewayConfig,assertCurrent:()=>void): Promise<string | null> {
  validateAgentGatewayConfig(config);
  const configuredBase = process.env.COD_GOOSE_ACP_URL;
  const configuredToken = process.env.COD_GOOSE_ACP_TOKEN;
  if (configuredBase && configuredToken) {
    const configured = new URL(configuredBase);
    configured.searchParams.set('token', configuredToken);
    assertCurrent();
    gooseAcpUrl = configured.toString();
    return gooseAcpUrl;
  }

  const configurationKey = createHash('sha256').update(`${config.token}\0${config.sourceId}\0${config.modelId}\0${config.taskId}\0${config.executionId}`).digest('hex');
  if (gooseAcpUrl && gooseConfigurationKey === configurationKey && gooseAgentTokenExpiresAt > Date.now() + 60_000) return gooseAcpUrl;
  if (gooseSidecar) {await stopGooseSidecar();assertCurrent();}

  const packagedBinary = path.join(process.resourcesPath, 'bin', process.platform === 'win32' ? 'goose.exe' : 'goose');
  const binary = process.env.COD_GOOSE_BINARY ?? packagedBinary;
  try {
    await fs.access(binary);
  } catch {
    assertCurrent();
    return null;
  }
  const resolvedBinary = await fs.realpath(binary);
  assertCurrent();
  const controlPlane = new URL(process.env.COD_CONTROL_PLANE_URL ?? 'https://cod.kai.com');
  if (controlPlane.protocol !== 'https:' && process.env.NODE_ENV === 'production') {
    throw new Error('COD_CONTROL_PLANE_URL must use HTTPS in production');
  }
  const agentSession = await mintAgentSession(controlPlane, config);
  assertCurrent();
  const gooseStateHome = await prepareGooseStateHome();
  assertCurrent();
  const port = await availablePort();
  assertCurrent();
  const secret = randomBytes(24).toString('hex');
  controlPlane.pathname = `${controlPlane.pathname.replace(/\/$/, '')}/v1/tasks/${encodeURIComponent(config.taskId)}/sources/${encodeURIComponent(config.sourceId)}`;
  controlPlane.search = '';
  controlPlane.hash = '';
  const spawnedSidecar = spawn(resolvedBinary, ['serve', '--host', '127.0.0.1', '--port', String(port), '--with-builtin', 'developer'], {
    stdio: 'ignore',
    env: {
      ...minimalGooseEnvironment(process.env),
      GOOSE_SERVER__SECRET_KEY: secret,
      GOOSE_PROVIDER: process.env.GOOSE_PROVIDER ?? 'openai',
      GOOSE_MODEL: config.modelId,
      GOOSE_MODE: process.env.GOOSE_MODE ?? 'smart_approve',
      OPENAI_MODEL: config.modelId,
      OPENAI_BASE_URL: controlPlane.toString().replace(/\/$/, ''),
      OPENAI_API_KEY: agentSession.token,
      ...(gooseStateHome ? { XDG_STATE_HOME: gooseStateHome } : {}),
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
    gooseSidecar = null;
    gooseAcpUrl = null;
    gooseConfigurationKey = null;
    gooseAgentTokenExpiresAt = 0;
  };
  spawnedSidecar.once('exit', clearSpawnedSidecar);
  spawnedSidecar.once('error', clearSpawnedSidecar);
  try {
    await ownershipReady;
    await waitForGoose(port, spawnedSidecar);
    assertCurrent();
  } catch (error) {
    await terminateChildProcess(spawnedSidecar);
    clearSpawnedSidecar();
    throw error;
  }
  gooseAcpUrl = `ws://127.0.0.1:${port}/acp?token=${secret}`;
  gooseConfigurationKey = configurationKey;
  gooseAgentTokenExpiresAt = agentSession.expiresAt;
  return gooseAcpUrl;
}

function ensureGooseSidecar(config:AgentGatewayConfig):Promise<string|null>{
  return gooseLaunchCoordinator.run((assertCurrent)=>ensureGooseSidecarSerialized(config,assertCurrent));
}

function invalidateAndStopGooseSidecar():Promise<void>{
  return gooseLaunchCoordinator.invalidate(stopGooseSidecar);
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
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      backgroundThrottling: false,
      spellcheck: true,
    },
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isTrustedExternalUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    const allowedDevelopmentNavigation = !app.isPackaged && url.startsWith(developmentUrl);
    if (allowedDevelopmentNavigation) return;
    event.preventDefault();
    if (isTrustedExternalUrl(url)) void shell.openExternal(url);
  });
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  window.webContents.on('did-start-navigation', (_event, _url, _isInPlace, isMainFrame) => { if (isMainFrame) void invalidateAndStopGooseSidecar(); });
  window.webContents.on('render-process-gone', () => { void invalidateAndStopGooseSidecar(); });
  window.webContents.on('destroyed', () => { void invalidateAndStopGooseSidecar(); });

  if (!app.isPackaged) {
    await window.loadURL(developmentUrl);
  } else {
    await window.loadFile(path.join(process.resourcesPath, 'web', 'index.html'));
  }
}

ipcMain.handle('cod:select-project', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
  if (result.canceled) return null;
  const root = await resolveProjectRoot(result.filePaths[0]);
  await rememberApprovedProjectRoot(root);
  return root;
});

ipcMain.handle('cod:list-files', async (_event, root: string) => {
  const resolvedRoot = await approvedProjectRoot(root);
  return collectWorkspaceFiles(resolvedRoot);
});

ipcMain.handle('cod:read-text-file', async (_event, root: string, relativePath: string) => {
  const resolvedRoot = await approvedProjectRoot(root);
  const target = await fs.realpath(path.join(resolvedRoot, relativePath));
  if (!isWithinRoot(resolvedRoot, target)) throw new Error('File is outside the selected project');
  const stats = await fs.stat(target);
  if (stats.size > 1024 * 1024) throw new Error('File is larger than 1 MB');
  return fs.readFile(target, 'utf8');
});

ipcMain.handle('cod:git-diff', async (_event, root: string) => {
  try {
    const resolvedRoot = await approvedProjectRoot(root);
    return collectGitDiff(resolvedRoot);
  } catch (error) {
    return error instanceof Error ? error.message : 'Unable to read git diff';
  }
});

ipcMain.handle('cod:get-goose-acp-url', (_event, config: AgentGatewayConfig) => ensureGooseSidecar(config));
ipcMain.handle('cod:stop-goose', () => invalidateAndStopGooseSidecar());

ipcMain.handle('cod:run-command', async (_event, root: string, rawCommand: string): Promise<TerminalResult> => {
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
    const { stdout, stderr } = await execFileAsync(executable, parts, { cwd: resolvedRoot, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
    return { command: rawCommand, output: `${stdout}${stderr}`.trim(), exitCode: 0 };
  } catch (error) {
    const details = error as Error & { stdout?: string; stderr?: string; code?: number };
    return { command: rawCommand, output: `${details.stdout ?? ''}${details.stderr ?? ''}${details.message}`.trim(), exitCode: typeof details.code === 'number' ? details.code : 1 };
  }
});

if (hasSingleInstanceLock) {
  app.whenReady().then(async () => {
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    await cleanupAbandonedGooseSidecar(gooseOwnershipFile()).catch(() => undefined);
    await restoreApprovedProjectRoots();
    await createWindow();
    app.on('activate', async () => {
      if (BrowserWindow.getAllWindows().length === 0) await createWindow();
    });
  });

  app.on('second-instance', () => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });

  app.on('window-all-closed', () => {
    void invalidateAndStopGooseSidecar();
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => { void invalidateAndStopGooseSidecar(); });
  process.once('exit', () => { forceTerminateChildProcess(gooseSidecar); });

  let stoppingForSignal = false;
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    process.once(signal, () => {
      if (stoppingForSignal) {
        forceTerminateChildProcess(gooseSidecar);
        process.exit(1);
      }
      stoppingForSignal = true;
      void invalidateAndStopGooseSidecar().finally(() => { process.kill(process.pid, signal); });
    });
  }
}
