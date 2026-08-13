import { app, BrowserWindow, clipboard, Menu, ipcMain, net, protocol, screen, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const petScheme = 'codpet';
const petWindowSize = Object.freeze({ width: 268, height: 350 });
const chatWindowSize = Object.freeze({ width: 430, height: 600, minWidth: 360, minHeight: 480, gap: 10 });
const petScaleOptions = Object.freeze([0.75, 1, 1.25, 1.5]);
const topLevelFiles = new Set(['index.html', 'styles.css', 'renderer.js', 'chat.html', 'chat.css', 'chat-renderer.js']);
const petResources = new Set(['index.html', 'styles.css', 'renderer.js', 'vendor/gsap/gsap.min.js']);
const chatResources = new Set(['chat.html', 'chat.css', 'chat-renderer.js']);

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

function petUrl(entry: 'index.html' | 'chat.html' = 'index.html'): string {
  return `${petScheme}://${entry === 'chat.html' ? 'chat' : 'pet'}/${entry}`;
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

export interface BuiltInDesktopPetChatConnection {
  endpoint: string;
  secret: string;
  model: string;
}

interface BundledChatService {
  characterChanged(characterId: string): Promise<void>;
}

interface BundledChatStore {
  init(): Promise<void>;
}

interface BundledChatProvider {
  getPublicConfig(): { mode: string; label: string; model: string | null };
  stream(request: Record<string, unknown>): AsyncIterable<Record<string, unknown>>;
}

export class BuiltInDesktopPet {
  readonly #resourceAsarPath: string;
  readonly #onOpenCod: (prompt?: string) => void;
  #window: BrowserWindow | null = null;
  #chatWindow: BrowserWindow | null = null;
  #chatService: BundledChatService | null = null;
  #chatConnection: BuiltInDesktopPetChatConnection | null = null;
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

  configureChat(connection: BuiltInDesktopPetChatConnection): void {
    this.#chatConnection = { ...connection };
  }

  async prepare(): Promise<void> {
    if (!this.#protocolReady) {
      await protocol.handle(petScheme, (request) => this.#serveResource(request));
      this.#protocolReady = true;
    }
    if (!this.#handlersReady) {
      this.#registerHandlers();
      await this.#prepareChatService();
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
    this.#protectWebContents(petWindow, petUrl());
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
    const chatWindow = this.#chatWindow;
    this.#chatWindow = null;
    const petWindow = this.#window;
    this.#window = null;
    this.#chatConnection = null;
    if (chatWindow && !chatWindow.isDestroyed()) chatWindow.destroy();
    if (petWindow && !petWindow.isDestroyed()) petWindow.destroy();
  }

  async #prepareChatService(): Promise<void> {
    if (this.#chatService) return;
    const bundledRequire = createRequire(path.join(this.#resourceAsarPath, 'package.json'));
    const { ChatStore } = bundledRequire('./chat-store.cjs') as {
      ChatStore: new (options: { directory: string }) => BundledChatStore;
    };
    const { ChatProviderError, createCompanyChatProvider } = bundledRequire('./company-chat-provider.cjs') as {
      ChatProviderError: new (code: string, message: string) => Error;
      createCompanyChatProvider(options: { env: NodeJS.ProcessEnv }): BundledChatProvider;
    };
    const { createChatService } = bundledRequire('./chat-service.cjs') as {
      createChatService(options: Record<string, unknown>): BundledChatService;
    };
    const store = new ChatStore({ directory: path.join(app.getPath('userData'), 'desktop-pet-chat') });
    await store.init();
    const host = this;
    const provider: BundledChatProvider = {
      getPublicConfig() {
        return {
          mode: 'company',
          label: 'COD 当前模型',
          model: host.#chatConnection?.model ?? null,
        };
      },
      async *stream(request) {
        const connection = host.#chatConnection;
        if (!connection) throw new ChatProviderError('UNAVAILABLE', '请从 COD 重新启动桌宠。');
        const delegate = createCompanyChatProvider({
          env: {
            COD_CHAT_API_URL: connection.endpoint,
            COD_CHAT_API_KEY: connection.secret,
            COD_CHAT_MODEL: connection.model,
          },
        });
        yield* delegate.stream(request);
      },
    };
    this.#chatService = createChatService({
      ipcMain,
      store,
      provider,
      isTrustedChatSender: (event: IpcMainEvent | IpcMainInvokeEvent) => this.#isTrustedSender(event, 'chat'),
      getChatWindow: () => this.#chatWindow,
      getPetWindow: () => this.#window,
      getCurrentCharacter: () => this.#currentCharacter,
      setCurrentCharacter: (id: string, options: { notifyPet?: boolean } = {}) => this.#setCharacter(id, options.notifyPet === true),
      hideChatWindow: () => this.#hideChatWindow(),
      copyText: (value: string) => clipboard.writeText(value),
    });
    ipcMain.handle('chat:route-draft', (event, payload: { text?: string } = {}) => {
      if (!this.#isTrustedSender(event, 'chat')) return { ok: false, code: 'UNTRUSTED', message: '请求来源无效。' };
      const prompt = typeof payload.text === 'string' ? payload.text.trim().slice(0, 4000) : '';
      return { ok: true, decision: { id: `local-${Date.now()}`, intent: 'LOCAL_CHAT', prompt } };
    });
    ipcMain.handle('chat:confirm-route', (event) => this.#isTrustedSender(event, 'chat')
      ? { ok: false, code: 'OPEN_COD', message: '需要执行代码任务时，请进入 COD 主工作区。' }
      : { ok: false, code: 'UNTRUSTED' });
    ipcMain.handle('chat:cancel-route', (event) => ({ ok: this.#isTrustedSender(event, 'chat') }));
    ipcMain.handle('workbench:get-state', (event) => {
      if (!this.#isTrustedSender(event, 'chat')) return { ok: false, code: 'UNTRUSTED' };
      this.#hideChatWindow();
      this.#onOpenCod();
      return { ok: true, state: { connected: true, persistent: false, deviceId: null, devices: [] } };
    });
    ipcMain.handle('workbench:login', (event) => this.#isTrustedSender(event, 'chat')
      ? { ok: false, code: 'INTEGRATED', message: '内置桌宠已复用 COD 登录，无需再次绑定。' }
      : { ok: false, code: 'UNTRUSTED' });
    ipcMain.handle('workbench:select-device', (event) => ({ ok: false, code: this.#isTrustedSender(event, 'chat') ? 'INTEGRATED' : 'UNTRUSTED' }));
    ipcMain.handle('workbench:logout', (event) => ({ ok: false, code: this.#isTrustedSender(event, 'chat') ? 'INTEGRATED' : 'UNTRUSTED' }));
    ipcMain.handle('chat:dictation-capability', (event) => ({ ok: this.#isTrustedSender(event, 'chat'), supported: false }));
    ipcMain.handle('chat:dictation-start', (event) => ({ ok: false, code: this.#isTrustedSender(event, 'chat') ? 'UNSUPPORTED' : 'UNTRUSTED' }));
    ipcMain.on('chat:dictation-stop', (event) => {
      if (!this.#isTrustedSender(event, 'chat')) return;
    });
  }

  #setCharacter(id: string, notifyPet = false): boolean {
    if (!['k', 'a', 'i'].includes(id)) return false;
    const changed = this.#currentCharacter !== id;
    this.#currentCharacter = id;
    if (notifyPet && this.#window && !this.#window.isDestroyed()) {
      this.#window.webContents.send('pet:switch-character', id);
    }
    return changed;
  }

  #positionChatWindow(): void {
    const petWindow = this.#window;
    const chatWindow = this.#chatWindow;
    if (!petWindow || petWindow.isDestroyed() || !chatWindow || chatWindow.isDestroyed()) return;
    const petBounds = petWindow.getBounds();
    const chatBounds = chatWindow.getBounds();
    const { workArea } = screen.getDisplayNearestPoint({
      x: petBounds.x + Math.round(petBounds.width / 2),
      y: petBounds.y + Math.round(petBounds.height / 2),
    });
    const leftX = petBounds.x - chatBounds.width - chatWindowSize.gap;
    const rightX = petBounds.x + petBounds.width + chatWindowSize.gap;
    const fitsLeft = leftX >= workArea.x;
    const fitsRight = rightX + chatBounds.width <= workArea.x + workArea.width;
    const x = fitsLeft || !fitsRight
      ? Math.max(workArea.x, leftX)
      : Math.min(workArea.x + workArea.width - chatBounds.width, rightX);
    const idealY = petBounds.y + petBounds.height - chatBounds.height;
    const y = Math.max(workArea.y, Math.min(workArea.y + workArea.height - chatBounds.height, idealY));
    chatWindow.setPosition(Math.round(x), Math.round(y), false);
  }

  async #openChatWindow(draft?: { text?: string; source?: 'voice' | 'typed'; entryMode?: 'explicit' | 'task_capture' }): Promise<void> {
    if (!this.#chatConnection) {
      this.#onOpenCod(draft?.text);
      return;
    }
    let chatWindow = this.#chatWindow;
    if (!chatWindow || chatWindow.isDestroyed()) {
      chatWindow = new BrowserWindow({
        width: chatWindowSize.width,
        height: chatWindowSize.height,
        minWidth: chatWindowSize.minWidth,
        minHeight: chatWindowSize.minHeight,
        transparent: true,
        frame: false,
        resizable: true,
        maximizable: false,
        fullscreenable: false,
        show: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        hasShadow: false,
        backgroundColor: '#00000000',
        webPreferences: {
          preload: path.join(this.#resourceAsarPath, 'chat-preload.cjs'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          devTools: false,
          webSecurity: true,
          allowRunningInsecureContent: false,
        },
      });
      this.#chatWindow = chatWindow;
      this.#protectWebContents(chatWindow, petUrl('chat.html'));
      chatWindow.setAlwaysOnTop(true, 'floating');
      chatWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      chatWindow.on('close', (event) => {
        if (this.#chatWindow !== chatWindow) return;
        event.preventDefault();
        this.#hideChatWindow();
      });
      chatWindow.on('closed', () => { if (this.#chatWindow === chatWindow) this.#chatWindow = null; });
      const createdChatWindow = chatWindow;
      createdChatWindow.webContents.on('render-process-gone', () => {
        if (!createdChatWindow.isDestroyed()) createdChatWindow.destroy();
      });
      await chatWindow.loadURL(petUrl('chat.html'));
    }
    if (chatWindow.isDestroyed()) return;
    this.#positionChatWindow();
    chatWindow.show();
    chatWindow.focus();
    if (draft) {
      chatWindow.webContents.send('chat:event', {
        v: 1,
        seq: 0,
        type: 'route-draft',
        text: typeof draft.text === 'string' ? draft.text.slice(0, 4000) : '',
        source: draft.source === 'voice' ? 'voice' : 'typed',
        entryMode: draft.entryMode === 'task_capture' ? 'task_capture' : 'explicit',
        startDictation: false,
      });
    } else {
      chatWindow.webContents.send('chat:event', { v: 1, seq: 0, type: 'focus-composer' });
    }
    this.#window?.webContents.send('pet:chat-window', { open: true });
  }

  #hideChatWindow(): void {
    const chatWindow = this.#chatWindow;
    if (chatWindow && !chatWindow.isDestroyed()) {
      chatWindow.webContents.send('chat:event', { v: 1, seq: 0, type: 'window-visibility', visible: false });
      chatWindow.hide();
    }
    this.#window?.webContents.send('pet:chat-window', { open: false });
    this.#window?.show();
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
    const resources = parsed.hostname === 'pet' ? petResources : parsed.hostname === 'chat' ? chatResources : null;
    if (request.method !== 'GET' || !resources || !isAllowedAsset(relativePath)) {
      return new Response('Not found', { status: 404 });
    }
    if (!relativePath.startsWith('assets/') && !resources.has(relativePath)) {
      return new Response('Not found', { status: 404 });
    }
    const requestedPath = path.resolve(this.#resourceAsarPath, relativePath);
    const boundary = path.relative(this.#resourceAsarPath, requestedPath);
    if (boundary.startsWith('..') || path.isAbsolute(boundary)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(requestedPath).toString());
  }

  #isTrustedSender(event: IpcMainEvent | IpcMainInvokeEvent, kind: 'pet' | 'chat' = 'pet'): boolean {
    const targetWindow = kind === 'pet' ? this.#window : this.#chatWindow;
    if (!targetWindow || targetWindow.isDestroyed() || event.sender !== targetWindow.webContents) return false;
    return (event.senderFrame?.url ?? event.sender.getURL()) === petUrl(kind === 'pet' ? 'index.html' : 'chat.html');
  }

  #protectWebContents(targetWindow: BrowserWindow, expectedUrl: string): void {
    targetWindow.webContents.on('will-navigate', (event, url) => { if (url !== expectedUrl) event.preventDefault(); });
    targetWindow.webContents.on('will-frame-navigate', (event) => { if (!event.isMainFrame) event.preventDefault(); });
    targetWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());
    targetWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
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
    this.#positionChatWindow();
    if (notify) petWindow.webContents.send('pet:scale-changed', { scale });
    return true;
  }

  #registerHandlers(): void {
    ipcMain.on('pet:close', (event) => { if (this.#isTrustedSender(event)) this.stop(); });
    ipcMain.on('pet:open-chat', (event, state: { currentCharacter?: string } = {}) => {
      if (!this.#isTrustedSender(event)) return;
      if (['k', 'a', 'i'].includes(state.currentCharacter ?? '')) this.#setCharacter(state.currentCharacter!);
      void this.#openChatWindow();
    });
    ipcMain.handle('pet:open-workbench', (event) => {
      if (!this.#isTrustedSender(event)) return { ok: false, message: '请求来源无效。' };
      this.#onOpenCod();
      return { ok: true };
    });
    ipcMain.handle('pet:route-voice-input', async (event, payload: { transcript?: string } = {}) => {
      if (!this.#isTrustedSender(event)) return { ok: false, message: '请求来源无效。' };
      const transcript = typeof payload.transcript === 'string' ? payload.transcript.trim().slice(0, 4000) : '';
      if (!transcript) return { ok: false, message: '没有识别到语音内容。' };
      await this.#openChatWindow({ text: transcript, source: 'voice', entryMode: 'explicit' });
      return { ok: true, mode: 'voice-draft' };
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
      if (!this.#isTrustedSender(event) || !this.#setCharacter(id)) return;
      void this.#chatService?.characterChanged(id);
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
      this.#positionChatWindow();
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
        { label: '打开简单问答', click: () => { void this.#openChatWindow(); } },
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
