import { app, BrowserWindow, dialog, ipcMain, session, shell } from 'electron';
import { execFile } from 'node:child_process';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { AgentGatewayConfig, TerminalResult, WorkspaceFile } from '@cod/contracts';

const execFileAsync = promisify(execFile);
const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const developmentUrl = process.env.COD_DEV_SERVER_URL || 'http://127.0.0.1:5173';
const allowedCommands = new Set(['npm', 'pnpm', 'cargo', 'git', 'node', 'just']);
const approvedProjectRoots = new Set<string>();
let gooseSidecar: ChildProcess | null = null;
let gooseAcpUrl: string | null = null;
let gooseConfigurationKey: string | null = null;

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
  gooseSidecar = null;
  gooseAcpUrl = null;
  gooseConfigurationKey = null;
  if (!processToStop || processToStop.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => { processToStop.kill('SIGKILL'); resolve(); }, 2_000);
    processToStop.once('exit', () => { clearTimeout(timeout); resolve(); });
    processToStop.kill();
  });
}

function validateAgentGatewayConfig(config: AgentGatewayConfig): void {
  if (!config?.token || config.token.length > 8_192) throw new Error('A valid COD session is required');
  if (!/^[a-z0-9-]{2,40}$/.test(config.sourceId)) throw new Error('Invalid model source');
  if (!config.modelId || config.modelId.length > 200 || /[\r\n]/.test(config.modelId)) throw new Error('Invalid model');
}

async function ensureGooseSidecar(config: AgentGatewayConfig): Promise<string | null> {
  validateAgentGatewayConfig(config);
  const configuredBase = process.env.COD_GOOSE_ACP_URL;
  const configuredToken = process.env.COD_GOOSE_ACP_TOKEN;
  if (configuredBase && configuredToken) {
    const configured = new URL(configuredBase);
    configured.searchParams.set('token', configuredToken);
    gooseAcpUrl = configured.toString();
    return gooseAcpUrl;
  }

  const configurationKey = createHash('sha256').update(`${config.token}\0${config.sourceId}\0${config.modelId}`).digest('hex');
  if (gooseAcpUrl && gooseConfigurationKey === configurationKey) return gooseAcpUrl;
  if (gooseSidecar) await stopGooseSidecar();

  const packagedBinary = path.join(process.resourcesPath, 'bin', process.platform === 'win32' ? 'goose.exe' : 'goose');
  const binary = process.env.COD_GOOSE_BINARY ?? packagedBinary;
  try {
    await fs.access(binary);
  } catch {
    return null;
  }
  const port = await availablePort();
  const secret = randomBytes(24).toString('hex');
  const controlPlane = new URL(process.env.COD_CONTROL_PLANE_URL ?? 'https://cod.kai.com');
  if (controlPlane.protocol !== 'https:' && process.env.NODE_ENV === 'production') {
    throw new Error('COD_CONTROL_PLANE_URL must use HTTPS in production');
  }
  controlPlane.pathname = `${controlPlane.pathname.replace(/\/$/, '')}/v1/sources/${encodeURIComponent(config.sourceId)}`;
  controlPlane.search = '';
  controlPlane.hash = '';
  const spawnedSidecar = spawn(binary, ['serve', '--host', '127.0.0.1', '--port', String(port), '--with-builtin', 'developer'], {
    stdio: 'ignore',
    env: {
      ...process.env,
      GOOSE_SERVER__SECRET_KEY: secret,
      GOOSE_PROVIDER: process.env.GOOSE_PROVIDER ?? 'openai',
      GOOSE_MODEL: config.modelId,
      GOOSE_MODE: process.env.GOOSE_MODE ?? 'smart_approve',
      OPENAI_MODEL: config.modelId,
      OPENAI_BASE_URL: controlPlane.toString().replace(/\/$/, ''),
      OPENAI_API_KEY: config.token,
    },
  });
  gooseSidecar = spawnedSidecar;
  const clearSpawnedSidecar = () => {
    if (gooseSidecar !== spawnedSidecar) return;
    gooseSidecar = null;
    gooseAcpUrl = null;
    gooseConfigurationKey = null;
  };
  spawnedSidecar.once('exit', clearSpawnedSidecar);
  spawnedSidecar.once('error', clearSpawnedSidecar);
  try {
    await waitForGoose(port, spawnedSidecar);
  } catch (error) {
    if (spawnedSidecar.exitCode === null && !spawnedSidecar.killed) spawnedSidecar.kill();
    clearSpawnedSidecar();
    throw error;
  }
  gooseAcpUrl = `ws://127.0.0.1:${port}/acp?token=${secret}`;
  gooseConfigurationKey = configurationKey;
  return gooseAcpUrl;
}

function isWithinRoot(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
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

function parseCommand(rawCommand: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (const character of rawCommand.trim()) {
    if (escaped) { current += character; escaped = false; continue; }
    if (character === '\\' && quote !== "'") { escaped = true; continue; }
    if (quote) { if (character === quote) quote = null; else current += character; continue; }
    if (character === '"' || character === "'") { quote = character; continue; }
    if (/\s/.test(character)) { if (current) { parts.push(current); current = ''; } continue; }
    current += character;
  }
  if (quote || escaped) throw new Error('Command contains an unfinished quote or escape');
  if (current) parts.push(current);
  return parts;
}

function isDestructiveGitCommand(parts: string[]): boolean {
  if (parts[0] !== 'git') return false;
  const subcommand = parts[1];
  return subcommand === 'clean'
    || (subcommand === 'reset' && parts.includes('--hard'))
    || (subcommand === 'checkout' && parts.includes('--'))
    || subcommand === 'restore'
    || (subcommand === 'push' && parts.some((part) => part === '--force' || part === '-f'));
}

async function collectFiles(root: string, directory = root, depth = 0): Promise<WorkspaceFile[]> {
  if (depth > 4) return [];
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const visible = entries.filter((entry) => !entry.name.startsWith('.') && entry.name !== 'node_modules' && entry.name !== 'dist' && entry.name !== 'target');
  const files: WorkspaceFile[] = [];
  for (const entry of visible.slice(0, 200)) {
    const absolute = path.join(directory, entry.name);
    const relativePath = path.relative(root, absolute);
    files.push({ name: entry.name, path: relativePath, kind: entry.isDirectory() ? 'directory' : 'file', depth });
    if (entry.isDirectory()) files.push(...await collectFiles(root, absolute, depth + 1));
  }
  return files;
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
  approvedProjectRoots.add(root);
  return root;
});

ipcMain.handle('cod:list-files', async (_event, root: string) => {
  const resolvedRoot = await approvedProjectRoot(root);
  return collectFiles(resolvedRoot);
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
    try {
      const { stdout } = await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: resolvedRoot, maxBuffer: 64 * 1024 });
      if (stdout.trim() !== 'true') return '当前目录不是 Git 工作区，暂无可显示的改动。';
    } catch {
      return '当前目录不是 Git 仓库，暂无可显示的改动。初始化 Git 后即可在这里查看变更。';
    }
    const [{ stdout: unstaged }, { stdout: staged }] = await Promise.all([
      execFileAsync('git', ['diff', '--no-ext-diff', '--'], { cwd: resolvedRoot, maxBuffer: 2 * 1024 * 1024 }),
      execFileAsync('git', ['diff', '--cached', '--no-ext-diff', '--'], { cwd: resolvedRoot, maxBuffer: 2 * 1024 * 1024 }),
    ]);
    return [unstaged && '# Unstaged changes\n' + unstaged, staged && '# Staged changes\n' + staged].filter(Boolean).join('\n');
  } catch (error) {
    return error instanceof Error ? error.message : 'Unable to read git diff';
  }
});

ipcMain.handle('cod:get-goose-acp-url', (_event, config: AgentGatewayConfig) => ensureGooseSidecar(config));
ipcMain.handle('cod:stop-goose', () => stopGooseSidecar());

ipcMain.handle('cod:run-command', async (_event, root: string, rawCommand: string): Promise<TerminalResult> => {
  let parts: string[];
  try { parts = parseCommand(rawCommand); }
  catch (error) { return { command: rawCommand, output: error instanceof Error ? error.message : 'Invalid command', exitCode: 126 }; }
  const executable = parts.shift();
  if (!executable || !allowedCommands.has(executable)) {
    return { command: rawCommand, output: 'Command is not in the COD allowlist.', exitCode: 126 };
  }
  if (isDestructiveGitCommand([executable, ...parts])) return { command: rawCommand, output: 'Destructive Git commands are blocked in the embedded terminal.', exitCode: 126 };
  try {
    const resolvedRoot = await approvedProjectRoot(root);
    const { stdout, stderr } = await execFileAsync(executable, parts, { cwd: resolvedRoot, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
    return { command: rawCommand, output: `${stdout}${stderr}`.trim(), exitCode: 0 };
  } catch (error) {
    const details = error as Error & { stdout?: string; stderr?: string; code?: number };
    return { command: rawCommand, output: `${details.stdout ?? ''}${details.stderr ?? ''}${details.message}`.trim(), exitCode: typeof details.code === 'number' ? details.code : 1 };
  }
});

app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  await createWindow();
  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) await createWindow();
  });
});

app.on('window-all-closed', () => {
  void stopGooseSidecar();
  if (process.platform !== 'darwin') app.quit();
});
