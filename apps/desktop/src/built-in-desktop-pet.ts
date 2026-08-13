import { BrowserWindow, Menu, ipcMain, net, protocol, screen, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const petScheme = 'codpet';
const petWindowSize = Object.freeze({ width: 268, height: 350 });
const petScaleOptions = Object.freeze([0.75, 1, 1.25, 1.5]);
const topLevelFiles = new Set(['index.html', 'styles.css', 'renderer.js']);
const petResources = new Set(['index.html', 'styles.css', 'renderer.js', 'vendor/gsap/gsap.min.js']);

protocol.registerSchemesAsPrivileged([{ scheme: petScheme, privileges: {
  standard: true,
  secure: true,
  supportFetchAPI: true,
  corsEnabled: true,
  stream: true,
} }]);

function isAllowedAsset(relativePath: string): boolean {
  if (topLevelFiles.has(relativePath) || relativePath === 'vendor/gsap/gsap.min.js') return true;
  if (/^assets\/pets\/pixel\/[a-z0-9-]+\.png$/i.test(relativePath)) return true;
  return /^assets\/voices\/(?:manifest\.json|[kai]\/[a-z0-9-]+\.wav)$/i.test(relativePath);
}

function petUrl(): string {
  return `${petScheme}://pet/index.html`;
}

function scaledPetSize(scale: number): { width: number; height: number } {
  return {
    width: Math.round(petWindowSize.width * scale),
    height: Math.round(petWindowSize.height * scale),
  };
}

export interface BuiltInDesktopPetOptions {
  resourceAsarPath: string;
  onOpenCod(prompt?: string): void;
}

export class BuiltInDesktopPet {
  readonly #resourceAsarPath: string;
  readonly #onOpenCod: (prompt?: string) => void;
  #window: BrowserWindow | null = null;
  #currentCharacter = 'k';
  #scale = 1;
  #protocolReady = false;
  #handlersReady = false;

  constructor(options: BuiltInDesktopPetOptions) {
    this.#resourceAsarPath = options.resourceAsarPath;
    this.#onOpenCod = options.onOpenCod;
  }

  get running(): boolean {
    return Boolean(this.#window && !this.#window.isDestroyed());
  }

  async prepare(): Promise<void> {
    if (!this.#protocolReady) {
      await protocol.handle(petScheme, (request) => this.#serveResource(request));
      this.#protocolReady = true;
    }
    if (!this.#handlersReady) {
      this.#registerHandlers();
      this.#handlersReady = true;
    }
  }

  async start(): Promise<{ started: boolean; focusedExisting: boolean }> {
    await this.prepare();
    if (this.#window && !this.#window.isDestroyed()) {
      if (this.#window.isMinimized()) this.#window.restore();
      this.#window.show();
      this.#window.focus();
      return { started: false, focusedExisting: true };
    }

    const smallest = scaledPetSize(petScaleOptions[0]);
    const largest = scaledPetSize(petScaleOptions.at(-1) ?? 1.5);
    const petWindow = new BrowserWindow({
      ...petWindowSize,
      minWidth: smallest.width,
      minHeight: smallest.height,
      maxWidth: largest.width,
      maxHeight: largest.height,
      transparent: true,
      frame: false,
      resizable: false,
      maximizable: false,
      fullscreenable: false,
      show: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      hasShadow: false,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: path.join(this.#resourceAsarPath, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        devTools: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
      },
    });
    this.#window = petWindow;
    this.#protectWebContents(petWindow);
    petWindow.setAlwaysOnTop(true, 'floating');
    petWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    petWindow.once('ready-to-show', () => {
      if (petWindow.isDestroyed()) return;
      const { workArea } = screen.getPrimaryDisplay();
      const x = Math.max(workArea.x, workArea.x + workArea.width - petWindowSize.width - 20);
      const y = Math.max(workArea.y, workArea.y + workArea.height - petWindowSize.height - 18);
      petWindow.setPosition(Math.round(x), Math.round(y), false);
      petWindow.show();
    });
    petWindow.on('closed', () => {
      if (this.#window === petWindow) this.#window = null;
    });
    petWindow.webContents.on('render-process-gone', () => {
      if (!petWindow.isDestroyed()) petWindow.destroy();
    });
    await petWindow.loadURL(petUrl());
    return { started: true, focusedExisting: false };
  }

  stop(): void {
    const petWindow = this.#window;
    this.#window = null;
    if (petWindow && !petWindow.isDestroyed()) petWindow.destroy();
  }

  async #serveResource(request: Request): Promise<Response> {
    let parsed: URL;
    let relativePath: string;
    try {
      parsed = new URL(request.url);
      relativePath = decodeURIComponent(parsed.pathname).replace(/^\/+/, '') || 'index.html';
    } catch {
      return new Response('Not found', { status: 404 });
    }
    if (request.method !== 'GET' || parsed.hostname !== 'pet' || !isAllowedAsset(relativePath)) {
      return new Response('Not found', { status: 404 });
    }
    if (!relativePath.startsWith('assets/') && !petResources.has(relativePath)) {
      return new Response('Not found', { status: 404 });
    }
    const requestedPath = path.resolve(this.#resourceAsarPath, relativePath);
    const boundary = path.relative(this.#resourceAsarPath, requestedPath);
    if (boundary.startsWith('..') || path.isAbsolute(boundary)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(requestedPath).toString());
  }

  #isTrustedSender(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
    const petWindow = this.#window;
    if (!petWindow || petWindow.isDestroyed() || event.sender !== petWindow.webContents) return false;
    return (event.senderFrame?.url ?? event.sender.getURL()) === petUrl();
  }

  #protectWebContents(petWindow: BrowserWindow): void {
    petWindow.webContents.on('will-navigate', (event, url) => { if (url !== petUrl()) event.preventDefault(); });
    petWindow.webContents.on('will-frame-navigate', (event) => { if (!event.isMainFrame) event.preventDefault(); });
    petWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());
    petWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  }

  #setScale(value: unknown, notify = false): boolean {
    const scale = typeof value === 'number' && petScaleOptions.includes(value) ? value : null;
    const petWindow = this.#window;
    if (!scale || !petWindow || petWindow.isDestroyed()) return false;
    const bounds = petWindow.getBounds();
    const size = scaledPetSize(scale);
    const display = screen.getDisplayNearestPoint({ x: bounds.x + Math.round(bounds.width / 2), y: bounds.y + Math.round(bounds.height / 2) });
    const { workArea } = display;
    const x = Math.max(workArea.x, Math.min(workArea.x + workArea.width - size.width, bounds.x + bounds.width - size.width));
    const y = Math.max(workArea.y, Math.min(workArea.y + workArea.height - size.height, bounds.y + bounds.height - size.height));
    petWindow.webContents.setZoomFactor(scale);
    petWindow.setBounds({ x: Math.round(x), y: Math.round(y), ...size }, false);
    this.#scale = scale;
    if (notify) petWindow.webContents.send('pet:scale-changed', { scale });
    return true;
  }

  #registerHandlers(): void {
    ipcMain.on('pet:close', (event) => { if (this.#isTrustedSender(event)) this.stop(); });
    ipcMain.on('pet:open-chat', (event, state: { currentCharacter?: string } = {}) => {
      if (!this.#isTrustedSender(event)) return;
      if (['k', 'a', 'i'].includes(state.currentCharacter ?? '')) this.#currentCharacter = state.currentCharacter!;
      this.#onOpenCod();
    });
    ipcMain.handle('pet:open-workbench', (event) => {
      if (!this.#isTrustedSender(event)) return { ok: false, message: '请求来源无效。' };
      this.#onOpenCod();
      return { ok: true };
    });
    ipcMain.handle('pet:route-voice-input', (event, payload: { transcript?: string } = {}) => {
      if (!this.#isTrustedSender(event)) return { ok: false, message: '请求来源无效。' };
      const transcript = typeof payload.transcript === 'string' ? payload.transcript.trim().slice(0, 4000) : '';
      if (!transcript) return { ok: false, message: '没有识别到语音内容。' };
      this.#onOpenCod(transcript);
      return { ok: true, mode: 'cod-chat' };
    });
    ipcMain.handle('pet:native-voice-status', (event) => this.#isTrustedSender(event)
      ? { ok: true, supported: false, speechAuthorization: 'unsupported', microphoneAuthorization: 'unsupported' }
      : { ok: false, supported: false });
    ipcMain.handle('pet:native-voice-start', (event) => ({ ok: false, code: this.#isTrustedSender(event) ? 'UNSUPPORTED' : 'UNTRUSTED' }));
    ipcMain.handle('pet:native-voice-stop', (event) => ({ ok: this.#isTrustedSender(event), mode: 'idle' }));
    ipcMain.handle('pet:request-voice-access', (event) => ({ ok: this.#isTrustedSender(event), granted: false, code: 'UNSUPPORTED' }));
    ipcMain.handle('pet:set-scale', (event, payload: { scale?: number } = {}) => {
      if (!this.#isTrustedSender(event) || !this.#setScale(payload.scale)) return { ok: false, scale: this.#scale };
      return { ok: true, scale: this.#scale, ...scaledPetSize(this.#scale) };
    });
    ipcMain.on('pet:character-changed', (event, id: string) => {
      if (this.#isTrustedSender(event) && ['k', 'a', 'i'].includes(id)) this.#currentCharacter = id;
    });
    ipcMain.on('pet:voice-capability', (event) => {
      if (!this.#isTrustedSender(event)) return;
    });
    ipcMain.on('pet:dictation-event', (event) => {
      if (!this.#isTrustedSender(event)) return;
    });
    ipcMain.on('pet:move-by', (event, delta: { x?: number; y?: number; pointerX?: number; pointerY?: number } = {}) => {
      if (!this.#isTrustedSender(event) || !this.#window || this.#window.isDestroyed()) return;
      const rawX = Number(delta.x); const rawY = Number(delta.y);
      if (!Number.isFinite(rawX) || !Number.isFinite(rawY)) return;
      const moveX = Math.max(-480, Math.min(480, Math.round(rawX)));
      const moveY = Math.max(-480, Math.min(480, Math.round(rawY)));
      const bounds = this.#window.getBounds();
      const pointerX = Number(delta.pointerX); const pointerY = Number(delta.pointerY);
      const display = screen.getDisplayNearestPoint(Number.isFinite(pointerX) && Number.isFinite(pointerY)
        ? { x: Math.round(pointerX), y: Math.round(pointerY) }
        : { x: bounds.x + moveX + Math.round(bounds.width / 2), y: bounds.y + moveY + Math.round(bounds.height / 2) });
      const { workArea } = display;
      const x = Math.max(workArea.x, Math.min(workArea.x + workArea.width - bounds.width, bounds.x + moveX));
      const y = Math.max(workArea.y, Math.min(workArea.y + workArea.height - bounds.height, bounds.y + moveY));
      this.#window.setPosition(Math.round(x), Math.round(y), false);
    });
    ipcMain.on('pet:context-menu', (event, state: { voiceMuted?: boolean } = {}) => {
      if (!this.#isTrustedSender(event) || !this.#window || this.#window.isDestroyed()) return;
      const characterItems = ([['k', '小K · 可靠执行官'], ['a', '小A · 灵感探索家'], ['i', '小I · 智慧分析师']] as const).map(([id, label]) => ({
        label, type: 'radio' as const, checked: this.#currentCharacter === id,
        click: () => { this.#currentCharacter = id; this.#window?.webContents.send('pet:switch-character', id); },
      }));
      const scaleItems = ([0.75, 1, 1.25, 1.5] as const).map((scale) => ({
        label: `${Math.round(scale * 100)}%`, type: 'radio' as const, checked: this.#scale === scale,
        click: () => this.#setScale(scale, true),
      }));
      Menu.buildFromTemplate([
        { label: '打开 COD 对话', click: () => this.#onOpenCod() },
        { type: 'separator' },
        { label: '切换伙伴', submenu: characterItems },
        { label: '桌宠大小', submenu: scaleItems },
        { label: '重新自我介绍', click: () => this.#window?.webContents.send('pet:introduce') },
        { label: state.voiceMuted ? '开启角色语音' : '关闭角色语音', click: () => this.#window?.webContents.send('pet:toggle-voice') },
        { type: 'separator' },
        { label: '隐藏桌宠', click: () => this.stop() },
      ]).popup({ window: this.#window });
    });
  }
}
