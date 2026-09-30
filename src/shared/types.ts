// メインプロセス・プリロード・レンダラーで共有する型

/** メインの項目を再生し終えたときの動作 */
export type EndAction = 'stop' | 'next' | 'loop';
export type MainItemKind = 'local' | 'youtube' | 'vimeo';

export interface MainItem {
  id: string;
  kind: MainItemKind;
  title: string;
  /** local: 絶対パス / youtube・vimeo: URL */
  source: string;
  endAction: EndAction;
}

export interface BgmItem {
  id: string;
  title: string;
  path: string;
}

export type BgmLoopMode = 'all' | 'one' | 'shuffle';
export type DuckingMode = 'lower' | 'pause' | 'none';
export type OutputMode = 'fullscreen' | 'window';

export interface Settings {
  outputMode: OutputMode;
  /** 全画面モードで表示するディスプレイ。null のときは自動で選ぶ */
  outputDisplayId: number | null;
  mainVolume: number; // 0-100
  mainMuted: boolean;
  bgmVolume: number; // 0-100
  bgmMuted: boolean;
  bgmLoopMode: BgmLoopMode;
  duckingMode: DuckingMode;
  /** ダッキング中の BGM 音量（通常時に対する割合 0-100） */
  duckingLevel: number;
  fadeMs: number;
  idleImagePath: string | null;
  previewEnabled: boolean;
  teleopEnabled: boolean;
}

export interface AppState {
  version: 1;
  main: MainItem[];
  bgm: BgmItem[];
  settings: Settings;
}

export const DEFAULT_SETTINGS: Settings = {
  outputMode: 'window',
  outputDisplayId: null,
  mainVolume: 80,
  mainMuted: false,
  bgmVolume: 50,
  bgmMuted: false,
  bgmLoopMode: 'all',
  duckingMode: 'lower',
  duckingLevel: 20,
  fadeMs: 1000,
  idleImagePath: null,
  previewEnabled: true,
  teleopEnabled: true,
};

/** 操作ウィンドウ → 出力ウィンドウ */
export type OutputCommand =
  | { type: 'load'; item: MainItem; autoplay: boolean }
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'stop' }
  | { type: 'seek'; time: number }
  | { type: 'volume'; volume: number; muted: boolean }
  | { type: 'setLoop'; loop: boolean }
  | { type: 'idleImage'; path: string | null }
  | { type: 'teleopEnabled'; enabled: boolean };

export type PlaybackState = 'idle' | 'loading' | 'playing' | 'paused' | 'ended' | 'error';

/** 出力ウィンドウ → 操作ウィンドウ */
export interface OutputStatus {
  itemId: string | null;
  state: PlaybackState;
  currentTime: number;
  duration: number;
  error?: string;
  /** オンライン動画で取得できたタイトル */
  title?: string;
}

export interface OutputConfig {
  mode: OutputMode;
  displayId: number | null;
}

export interface DisplayInfo {
  id: number;
  label: string;
  primary: boolean;
}

export type MediaDialogKind = 'main' | 'bgm' | 'image';
