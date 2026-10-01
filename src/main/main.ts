// メインプロセス: 操作ウィンドウと出力ウィンドウを作り、両者のメッセージを中継する
import fs from 'node:fs';
import path from 'node:path';
import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  MenuItem,
  net,
  screen,
  type IpcMainEvent,
  type Rectangle,
  type WebContents,
} from 'electron';
import electronLocalShortcut from 'electron-localshortcut';
import { AUDIO_EXTS, IMAGE_EXTS, VIDEO_EXTS, parseOnlineUrl } from '../shared/media';
import type {
  AppState,
  DisplayInfo,
  MediaDialogKind,
  OutputCommand,
  OutputConfig,
  OutputStatus,
} from '../shared/types';
import { normalizeState } from './normalize';
import { startServer, type LocalServer } from './server';
import { Store, type WindowState } from './store';

// 出力ウィンドウでは、操作なしで音声付きの自動再生を行う
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const isMac = process.platform === 'darwin';
const OUTPUT_DEFAULT_SIZE = { width: 960, height: 540 };
const PREVIEW_INTERVAL_MS = 16; // プレビュー更新間隔（ミリ秒）約60fps
const PREVIEW_WIDTH = 384;

let server: LocalServer;
let store: Store;
let control: BrowserWindow | null = null;
let output: BrowserWindow | null = null;
let quitting = false;
let outputConfig: OutputConfig = { mode: 'window', displayId: null };
/** 全画面モードで実際に表示しているディスプレイ */
let outputDisplayId: number | null = null;
let previewEnabled = true;
let previewTimer: NodeJS.Timeout | null = null;
let previewBusy = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!control) return;
    if (control.isMinimized()) control.restore();
    control.focus();
  });
  app.whenReady().then(init).catch((err) => {
    dialog.showErrorBox('StreamPlayer を起動できませんでした', String(err));
    app.quit();
  });
}

async function init(): Promise<void> {
  store = new Store(app.getPath('userData'));
  server = await startServer(path.join(__dirname, '..', 'renderer'));
  registerIpc();

  const { settings } = store.getState();
  previewEnabled = settings.previewEnabled;
  createOutputWindow();
  createControlWindow();
  applyOutputConfig({ mode: settings.outputMode, displayId: settings.outputDisplayId });

  screen.on('display-added', notifyDisplaysChanged);
  screen.on('display-metrics-changed', notifyDisplaysChanged);
  screen.on('display-removed', (_e, removed) => {
    if (outputConfig.mode === 'fullscreen' && outputDisplayId === removed.id) {
      const fallback: OutputConfig = { mode: 'window', displayId: outputConfig.displayId };
      applyOutputConfig(fallback);
      sendToControl('output:modeChanged', fallback);
      sendToControl('output:warning', '出力先のディスプレイが外れたため、ウィンドウモードに切り替えました');
    }
    notifyDisplaysChanged();
  });
}

app.on('before-quit', () => {
  quitting = true;
  store?.flush();
});

app.on('window-all-closed', () => app.quit());

// ---------------------------------------------------------------- ウィンドウ

function webPreferences(): Electron.WebPreferences {
  return {
    preload: path.join(__dirname, '..', 'preload', 'preload.js'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    // 裏に回ってもフェードや再生状態の通知を止めない
    backgroundThrottling: false,
  };
}

/** アプリ外のページへの移動や新しいウィンドウを禁止する */
function harden(contents: WebContents): void {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (e, url) => {
    if (!url.startsWith(`${server.origin}/`)) e.preventDefault();
  });
}

function isOnSomeDisplay(rect: Rectangle): boolean {
  return screen.getAllDisplays().some(({ workArea: a }) =>
    rect.x < a.x + a.width && rect.x + rect.width > a.x && rect.y < a.y + a.height && rect.y + rect.height > a.y,
  );
}

function savedBounds(key: keyof WindowState): Rectangle | undefined {
  const b = store.getWindowState()[key];
  return b && isOnSomeDisplay(b) ? b : undefined;
}

function createControlWindow(): void {
  const bounds = savedBounds('control');
  const win = new BrowserWindow({
    width: bounds?.width ?? 1280,
    height: bounds?.height ?? 820,
    x: bounds?.x,
    y: bounds?.y,
    minWidth: 960,
    minHeight: 640,
    title: 'StreamPlayer',
    backgroundColor: '#14161b',
    show: false,
    webPreferences: webPreferences(),
  });
  control = win;
  harden(win.webContents);
  win.removeMenu();
  win.once('ready-to-show', () => win.show());

  const saveBounds = () => {
    if (!win.isMinimized() && !win.isMaximized()) store.setWindowBounds('control', win.getBounds());
  };
  win.on('resized', saveBounds);
  win.on('moved', saveBounds);
  win.on('show', updatePreviewTimer);
  win.on('hide', updatePreviewTimer);
  win.on('minimize', updatePreviewTimer);
  win.on('restore', updatePreviewTimer);
  // 操作ウィンドウを閉じたらアプリを終了する
  win.on('close', () => {
    quitting = true;
    unregisterGlobalShortcuts();
  });
  win.on('closed', () => {
    control = null;
    app.quit();
  });

  win.loadURL(`${server.origin}/app/control/index.html`);
  win.webContents.on('did-finish-load', () => registerGlobalShortcuts());
}

function createOutputWindow(): void {
  const win = new BrowserWindow({
    ...OUTPUT_DEFAULT_SIZE,
    // モードを切り替えても再生を止めないよう、常に枠なしで作る（ウィンドウモードでは画面全体をドラッグして移動する）
    frame: false,
    title: 'StreamPlayer 出力',
    backgroundColor: '#000000',
    show: false, // 起動時は非表示
    webPreferences: webPreferences(),
  });
  output = win;
  harden(win.webContents);
  win.removeMenu();

  const saveBounds = () => {
    if (outputConfig.mode === 'window' && !win.isFullScreen() && !win.isMinimized()) {
      store.setWindowBounds('output', win.getBounds());
    }
  };
  win.on('resized', saveBounds);
  win.on('moved', saveBounds);
  win.on('show', updatePreviewTimer);
  win.on('hide', updatePreviewTimer);
  // 出力ウィンドウは閉じずに隠す（操作ウィンドウの「出力を表示」で戻せる）
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });
  win.webContents.on('did-finish-load', () => win.webContents.send('output:mode', outputConfig.mode));
  win.webContents.on('render-process-gone', () => {
    sendToControl('output:warning', '出力画面でエラーが起きたため、再読み込みしました');
    if (!win.isDestroyed()) win.reload();
  });

  // 右クリックメニュー
  win.webContents.on('context-menu', () => {
    const menu = new Menu();
    menu.append(
      new MenuItem({
        label: '出力ウィンドウを隠す',
        click: () => {
          win.hide();
          sendToControl('output:visibilityChanged', false);
        },
      }),
    );
    menu.append(
      new MenuItem({
        label: '開発者ツールを開く',
        accelerator: 'F12',
        click: () => win.webContents.toggleDevTools(),
      }),
    );
    menu.popup();
  });

  win.loadURL(`${server.origin}/app/output/index.html`);
}

function leaveFullscreen(win: BrowserWindow): void {
  if (isMac) {
    if (win.isSimpleFullScreen()) win.setSimpleFullScreen(false);
  } else if (win.isFullScreen()) {
    win.setFullScreen(false);
  }
}

function applyOutputConfig(config: OutputConfig): void {
  outputConfig = config;
  const win = output;
  if (!win) return;
  const primary = screen.getPrimaryDisplay();
  leaveFullscreen(win);

  if (config.mode === 'fullscreen') {
    const target = screen.getAllDisplays().find((d) => d.id === config.displayId) ?? primary;
    outputDisplayId = target.id;
    win.setAspectRatio(0);
    win.setBounds(target.bounds);
    // Mac は通常の全画面だと別のデスクトップ（スペース）に移ってしまうため、簡易全画面を使う
    if (isMac) win.setSimpleFullScreen(true);
    else win.setFullScreen(true);
  } else {
    outputDisplayId = null;
    const area = primary.workArea;
    const bounds = savedBounds('output') ?? {
      ...OUTPUT_DEFAULT_SIZE,
      x: Math.round(area.x + (area.width - OUTPUT_DEFAULT_SIZE.width) / 2),
      y: Math.round(area.y + (area.height - OUTPUT_DEFAULT_SIZE.height) / 2),
    };
    win.setBounds(bounds);
    win.setAspectRatio(16 / 9);
  }

  win.webContents.send('output:mode', config.mode);
  // 操作ウィンドウのフォーカスを奪わない
  if (!win.isVisible()) win.showInactive();
}

function getDisplays(): DisplayInfo[] {
  const primaryId = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((d, i) => {
    const size = `${d.size.width}×${d.size.height}`;
    const name = d.label ? `${d.label}・` : '';
    return {
      id: d.id,
      primary: d.id === primaryId,
      label: `ディスプレイ ${i + 1}（${name}${size}${d.id === primaryId ? '・メイン' : ''}）`,
    };
  });
}

function notifyDisplaysChanged(): void {
  sendToControl('displays:changed');
}

function sendToControl(channel: string, ...args: unknown[]): void {
  if (control && !control.isDestroyed()) control.webContents.send(channel, ...args);
}

// ---------------------------------------------------------------- グローバルホットキー

function registerGlobalShortcuts(): void {
  if (!control || control.isDestroyed()) return;

  const mod = isMac ? 'Cmd' : 'Ctrl';
  const shortcuts: Record<string, () => void> = {
    [`${mod}+M`]: () => sendToControl('hotkey:mainToggle'),
    [`${mod}+N`]: () => sendToControl('hotkey:mainStop'),
    [`${mod}+B`]: () => sendToControl('hotkey:bgmToggle'),
    [`${mod}+Right`]: () => sendToControl('hotkey:mainNext'),
    [`${mod}+Left`]: () => sendToControl('hotkey:mainPrev'),
    [`${mod}+O`]: () => sendToControl('hotkey:toggleOutput'),
  };

  electronLocalShortcut.register(control, Object.keys(shortcuts), (e) => {
    const handler = shortcuts[e.key];
    if (handler) handler();
  });
}

function unregisterGlobalShortcuts(): void {
  if (!control || control.isDestroyed()) return;
  electronLocalShortcut.unregisterAll(control);
}

// ---------------------------------------------------------------- プレビュー

function updatePreviewTimer(): void {
  const active =
    previewEnabled &&
    !!control?.isVisible() &&
    !control.isMinimized() &&
    !!output?.isVisible();
  if (active && !previewTimer) {
    previewTimer = setInterval(capturePreview, PREVIEW_INTERVAL_MS);
  } else if (!active && previewTimer) {
    clearInterval(previewTimer);
    previewTimer = null;
  }
}

async function capturePreview(): Promise<void> {
  if (previewBusy || !output || output.isDestroyed()) return;
  previewBusy = true;
  try {
    const image = await output.webContents.capturePage();
    if (image.isEmpty()) return;
    const jpeg = image.resize({ width: PREVIEW_WIDTH, quality: 'good' }).toJPEG(70);
    sendToControl('preview:frame', `data:image/jpeg;base64,${jpeg.toString('base64')}`);
  } catch {
    // ウィンドウの切り替え中などは取得に失敗することがあるため、次の周期に任せる
  } finally {
    previewBusy = false;
  }
}

// ---------------------------------------------------------------- IPC

function fromControl(e: IpcMainEvent | Electron.IpcMainInvokeEvent): boolean {
  return !!control && e.sender === control.webContents;
}

function fromOutput(e: IpcMainEvent): boolean {
  return !!output && e.sender === output.webContents;
}

function registerIpc(): void {
  ipcMain.handle('app:mediaBase', () => server.mediaBase);

  ipcMain.handle('state:load', () => store.getState());
  ipcMain.on('state:save', (e, state: AppState) => {
    if (fromControl(e)) store.setState(state);
  });
  ipcMain.handle('state:export', (e, state: AppState) => exportState(state));
  ipcMain.handle('state:import', () => importState());

  ipcMain.handle('dialog:openMedia', (e, kind: MediaDialogKind) => openMediaDialog(kind));
  ipcMain.handle('files:exist', (e, paths: string[]) =>
    paths.map((p) => {
      try {
        return fs.statSync(p).isFile();
      } catch {
        return false;
      }
    }),
  );
  ipcMain.handle('files:findInFolder', (e, names: string[]) => findInFolder(names));
  ipcMain.handle('online:title', (e, url: string) => fetchOnlineTitle(url));

  ipcMain.handle('displays:get', () => getDisplays());
  ipcMain.on('output:configure', (e, config: OutputConfig) => {
    if (fromControl(e)) applyOutputConfig(config);
  });
  ipcMain.on('output:show', (e) => {
    if (!fromControl(e) || !output) return;
    output.showInactive();
    output.moveTop();
  });
  ipcMain.on('output:toggle', (e) => {
    if (!fromControl(e) || !output) return;
    if (output.isVisible()) {
      output.hide();
    } else {
      output.showInactive();
      output.moveTop();
    }
    sendToControl('output:visibilityChanged', !output.isVisible());
  });
  ipcMain.on('output:command', (e, cmd: OutputCommand) => {
    if (fromControl(e)) output?.webContents.send('output:command', cmd);
  });
  ipcMain.on('output:status', (e, status: OutputStatus) => {
    if (fromOutput(e)) sendToControl('output:status', status);
  });
  ipcMain.on('output:ready', (e) => {
    if (fromOutput(e)) sendToControl('output:ready');
  });
  ipcMain.on('preview:set', (e, enabled: boolean) => {
    if (!fromControl(e)) return;
    previewEnabled = enabled;
    updatePreviewTimer();
  });
}

async function openMediaDialog(kind: MediaDialogKind): Promise<string[]> {
  if (!control) return [];
  const filters: Electron.FileFilter[] =
    kind === 'image'
      ? [{ name: '画像', extensions: IMAGE_EXTS }]
      : kind === 'bgm'
        ? [
            { name: '音声', extensions: AUDIO_EXTS },
            { name: '動画（音声だけ再生）', extensions: VIDEO_EXTS },
          ]
        : [{ name: '動画・音声', extensions: [...VIDEO_EXTS, ...AUDIO_EXTS] }];
  const result = await dialog.showOpenDialog(control, {
    title: kind === 'image' ? '待機画面の画像を選択' : 'ファイルを追加',
    properties: kind === 'image' ? ['openFile'] : ['openFile', 'multiSelections'],
    filters: [...filters, { name: 'すべてのファイル', extensions: ['*'] }],
  });
  return result.canceled ? [] : result.filePaths;
}

async function exportState(state: AppState): Promise<boolean> {
  if (!control) return false;
  const date = new Date().toISOString().slice(0, 10);
  const result = await dialog.showSaveDialog(control, {
    title: '設定とプレイリストをエクスポート',
    defaultPath: `streamplayer-${date}.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (result.canceled || !result.filePath) return false;
  const data = { app: 'StreamPlayer', exportedAt: new Date().toISOString(), ...normalizeState(state) };
  await fs.promises.writeFile(result.filePath, JSON.stringify(data, null, 2), 'utf8');
  return true;
}

async function importState(): Promise<AppState | null> {
  if (!control) return null;
  const result = await dialog.showOpenDialog(control, {
    title: '設定とプレイリストをインポート',
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  const raw: unknown = JSON.parse(await fs.promises.readFile(result.filePaths[0], 'utf8'));
  const state = normalizeState(raw);
  // ディスプレイの ID は PC ごとに違うため引き継がない
  state.settings.outputDisplayId = null;
  return state;
}

/** 選んだフォルダの中から、同じファイル名のファイルを探す（別の PC から移したとき用） */
async function findInFolder(names: string[]): Promise<Record<string, string> | null> {
  if (!control) return null;
  const result = await dialog.showOpenDialog(control, {
    title: 'ファイルを探すフォルダを選択',
    properties: ['openDirectory'],
  });
  if (result.canceled || !result.filePaths[0]) return null;

  const wanted = new Set(names.map((n) => n.toLowerCase()));
  const found: Record<string, string> = {};
  const MAX_DEPTH = 8;
  const MAX_ENTRIES = 100_000;
  let visited = 0;
  const stack: Array<{ dir: string; depth: number }> = [{ dir: result.filePaths[0], depth: 0 }];

  while (stack.length > 0 && visited < MAX_ENTRIES && Object.keys(found).length < wanted.size) {
    const { dir, depth } = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      visited++;
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH) stack.push({ dir: full, depth: depth + 1 });
      } else {
        const key = entry.name.toLowerCase();
        if (wanted.has(key) && !found[key]) found[key] = full;
      }
    }
  }
  return found;
}

/** oEmbed で YouTube / Vimeo の動画タイトルを取得する */
async function fetchOnlineTitle(url: string): Promise<string | null> {
  const ref = parseOnlineUrl(url);
  if (!ref) return null;
  const endpoint =
    ref.kind === 'youtube'
      ? `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(ref.url)}`
      : `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(ref.url)}`;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 8000);
  try {
    const res = await net.fetch(endpoint, { signal: abort.signal });
    if (!res.ok) return null;
    const json = (await res.json()) as { title?: unknown };
    return typeof json.title === 'string' ? json.title : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
