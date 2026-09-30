// 画面（レンダラー）に公開する API。操作ウィンドウと出力ウィンドウで共通
import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';
import type {
  AppState,
  DisplayInfo,
  MediaDialogKind,
  OutputCommand,
  OutputConfig,
  OutputMode,
  OutputStatus,
} from '../shared/types';

function subscribe<T>(channel: string, callback: (value: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, value: T) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

const api = {
  platform: process.platform,
  getMediaBase: (): Promise<string> => ipcRenderer.invoke('app:mediaBase'),

  // 保存・読み込み
  loadState: (): Promise<AppState> => ipcRenderer.invoke('state:load'),
  saveState: (state: AppState): void => ipcRenderer.send('state:save', state),
  exportState: (state: AppState): Promise<boolean> => ipcRenderer.invoke('state:export', state),
  importState: (): Promise<AppState | null> => ipcRenderer.invoke('state:import'),

  // ファイル
  openMediaDialog: (kind: MediaDialogKind): Promise<string[]> => ipcRenderer.invoke('dialog:openMedia', kind),
  pathForFile: (file: File): string => webUtils.getPathForFile(file),
  filesExist: (paths: string[]): Promise<boolean[]> => ipcRenderer.invoke('files:exist', paths),
  findInFolder: (names: string[]): Promise<Record<string, string> | null> =>
    ipcRenderer.invoke('files:findInFolder', names),
  fetchOnlineTitle: (url: string): Promise<string | null> => ipcRenderer.invoke('online:title', url),

  // 操作ウィンドウ用
  getDisplays: (): Promise<DisplayInfo[]> => ipcRenderer.invoke('displays:get'),
  configureOutput: (config: OutputConfig): void => ipcRenderer.send('output:configure', config),
  showOutput: (): void => ipcRenderer.send('output:show'),
  toggleOutput: (): void => ipcRenderer.send('output:toggle'),
  setPreview: (enabled: boolean): void => ipcRenderer.send('preview:set', enabled),
  sendOutputCommand: (cmd: OutputCommand): void => ipcRenderer.send('output:command', cmd),
  onOutputStatus: (cb: (status: OutputStatus) => void) => subscribe('output:status', cb),
  onOutputReady: (cb: () => void) => subscribe('output:ready', cb),
  onOutputWarning: (cb: (message: string) => void) => subscribe('output:warning', cb),
  onOutputModeChanged: (cb: (config: OutputConfig) => void) => subscribe('output:modeChanged', cb),
  onDisplaysChanged: (cb: () => void) => subscribe('displays:changed', cb),
  onPreviewFrame: (cb: (dataUrl: string) => void) => subscribe('preview:frame', cb),
  onOutputVisibilityChanged: (cb: (visible: boolean) => void) => subscribe('output:visibilityChanged', cb),
  onHotkey: (cb: (action: string) => void) => subscribe('hotkey', (data: unknown) => {
    if (typeof data === 'string') cb(data.split(':')[1] ?? '');
  }),

  // 出力ウィンドウ用
  onOutputCommand: (cb: (cmd: OutputCommand) => void) => subscribe('output:command', cb),
  onOutputMode: (cb: (mode: OutputMode) => void) => subscribe('output:mode', cb),
  sendOutputStatus: (status: OutputStatus): void => ipcRenderer.send('output:status', status),
  notifyOutputReady: (): void => ipcRenderer.send('output:ready'),
};

export type Api = typeof api;

contextBridge.exposeInMainWorld('api', api);
