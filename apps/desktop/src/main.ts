import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { execFile } from 'node:child_process';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { TerminalResult, WorkspaceFile } from '@cod/contracts';

const execFileAsync = promisify(execFile);
const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const developmentUrl = process.env.COD_DEV_SERVER_URL || 'http://127.0.0.1:5173';
const allowedCommands = new Set(['npm', 'pnpm', 'cargo', 'git', 'node', 'just']);
let gooseSidecar: ChildProcess | null = null;
let gooseAcpUrl: string | null = null;

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

async function waitForGoose(port: number, attempts = 50): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/status`);
      if (response.ok) return;
    } catch {
      // The sidecar is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Goose sidecar did not become ready');
}

async function ensureGooseSidecar(): Promise<string | null> {
  if (gooseAcpUrl) return gooseAcpUrl;
  const configuredBase = process.env.COD_GOOSE_ACP_URL;
  const configuredToken = process.env.COD_GOOSE_ACP_TOKEN;
  if (configuredBase && configuredToken) {
    const configured = new URL(configuredBase);
    configured.searchParams.set('token', configuredToken);
    gooseAcpUrl = configured.toString();
    return gooseAcpUrl;
  }

  const packagedBinary = path.join(process.resourcesPath, 'bin', process.platform === 'win32' ? 'goose.exe' : 'goose');
  const binary = process.env.COD_GOOSE_BINARY ?? packagedBinary;
  try {
    await fs.access(binary);
  } catch {
    return null;
  }
  const port = await availablePort();
  const secret = randomBytes(24).toString('hex');
  gooseSidecar = spawn(binary, ['serve', '--platform', 'desktop', '--host', '127.0.0.1', '--port', String(port)], {
    stdio: 'ignore',
    env: {
      ...process.env,
      GOOSE_SERVER__SECRET_KEY: secret,
      GOOSE_PROVIDER: process.env.GOOSE_PROVIDER ?? 'openai',
      GOOSE_MODEL: process.env.GOOSE_MODEL ?? 'coder-pro',
      OPENAI_MODEL: process.env.OPENAI_MODEL ?? 'coder-pro',
      OPENAI_BASE_URL: process.env.OPENAI_BASE_URL ?? 'https://ai.kai.com/v1',
    },
  });
  await waitForGoose(port);
  gooseAcpUrl = `ws://127.0.0.1:${port}/acp?token=${secret}`;
  return gooseAcpUrl;
}

function isWithinRoot(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
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
      preload: path.join(moduleDirectory, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (!app.isPackaged) {
    await window.loadURL(developmentUrl);
  } else {
    await window.loadFile(path.join(process.resourcesPath, 'web', 'index.html'));
  }
}

ipcMain.handle('cod:select-project', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('cod:list-files', async (_event, root: string) => collectFiles(root));

ipcMain.handle('cod:read-text-file', async (_event, root: string, relativePath: string) => {
  const target = path.join(root, relativePath);
  if (!isWithinRoot(root, target)) throw new Error('File is outside the selected project');
  const stats = await fs.stat(target);
  if (stats.size > 1024 * 1024) throw new Error('File is larger than 1 MB');
  return fs.readFile(target, 'utf8');
});

ipcMain.handle('cod:git-diff', async (_event, root: string) => {
  try {
    const { stdout } = await execFileAsync('git', ['diff', '--no-ext-diff', '--'], { cwd: root, maxBuffer: 2 * 1024 * 1024 });
    return stdout;
  } catch (error) {
    return error instanceof Error ? error.message : 'Unable to read git diff';
  }
});

ipcMain.handle('cod:get-goose-acp-url', () => ensureGooseSidecar());

ipcMain.handle('cod:run-command', async (_event, root: string, rawCommand: string): Promise<TerminalResult> => {
  const parts = rawCommand.trim().split(/\s+/).filter(Boolean);
  const executable = parts.shift();
  if (!executable || !allowedCommands.has(executable)) {
    return { command: rawCommand, output: 'Command is not in the Stage 1 allowlist.', exitCode: 126 };
  }
  try {
    const { stdout, stderr } = await execFileAsync(executable, parts, { cwd: root, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
    return { command: rawCommand, output: `${stdout}${stderr}`.trim(), exitCode: 0 };
  } catch (error) {
    const details = error as Error & { stdout?: string; stderr?: string; code?: number };
    return { command: rawCommand, output: `${details.stdout ?? ''}${details.stderr ?? ''}${details.message}`.trim(), exitCode: typeof details.code === 'number' ? details.code : 1 };
  }
});

app.whenReady().then(async () => {
  await createWindow();
  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) await createWindow();
  });
});

app.on('window-all-closed', () => {
  gooseSidecar?.kill();
  if (process.platform !== 'darwin') app.quit();
});
