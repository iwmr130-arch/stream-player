// 出力ウィンドウのプレイヤー（ローカルファイル / YouTube / Vimeo）を同じ形で扱う
import VimeoSdk from '@vimeo/player';
import type { OnlineRef } from '../../shared/media';
import type { PlaybackState } from '../../shared/types';

export interface PlayerEvents {
  onState(state: PlaybackState, error?: string): void;
  /** 再生位置や長さが変わった */
  onUpdate(): void;
  onTitle(title: string): void;
}

export interface PlayerOptions {
  autoplay: boolean;
  volume: number; // 0-100
  muted: boolean;
  loop: boolean;
}

export interface Player {
  play(): void;
  pause(): void;
  seek(time: number): void;
  setVolume(volume: number, muted: boolean): void;
  setLoop(loop: boolean): void;
  setSubtitle?(lang: string): void;
  currentTime(): number;
  duration(): number;
  destroy(): void;
}

function clearLayer(layer: HTMLElement): void {
  layer.replaceChildren();
  layer.hidden = true;
}

// ---------------------------------------------------------------- ローカルファイル

export class LocalPlayer implements Player {
  private readonly video = document.createElement('video');
  private readonly listeners = new AbortController();

  constructor(
    private readonly layer: HTMLElement,
    src: string,
    opts: PlayerOptions,
    events: PlayerEvents,
  ) {
    const v = this.video;
    const signal = this.listeners.signal;
    v.preload = 'auto';
    v.playsInline = true;
    v.loop = opts.loop;
    this.setVolume(opts.volume, opts.muted);

    v.addEventListener('playing', () => events.onState('playing'), { signal });
    v.addEventListener('pause', () => !v.ended && events.onState('paused'), { signal });
    v.addEventListener('ended', () => events.onState('ended'), { signal });
    v.addEventListener('durationchange', () => events.onUpdate(), { signal });
    v.addEventListener('seeked', () => events.onUpdate(), { signal });
    v.addEventListener(
      'loadedmetadata',
      () => {
        // 音声だけのファイルは映像を出さず、待機画面を見せる
        layer.hidden = v.videoWidth === 0;
        if (!opts.autoplay) events.onState('paused');
      },
      { signal },
    );
    v.addEventListener('error', () => events.onState('error', localErrorMessage(v.error)), { signal });

    v.src = src;
    layer.replaceChildren(v);
    if (opts.autoplay) {
      v.play().catch(() => {
        // 読み込みエラーは error イベントで通知される
      });
    }
  }

  play(): void {
    this.video.play().catch(() => {});
  }
  pause(): void {
    this.video.pause();
  }
  seek(time: number): void {
    this.video.currentTime = time;
  }
  setVolume(volume: number, muted: boolean): void {
    this.video.volume = Math.min(1, Math.max(0, volume / 100));
    this.video.muted = muted;
  }
  setLoop(loop: boolean): void {
    this.video.loop = loop;
  }
  currentTime(): number {
    return this.video.currentTime;
  }
  duration(): number {
    return Number.isFinite(this.video.duration) ? this.video.duration : 0;
  }
  destroy(): void {
    this.listeners.abort();
    this.video.pause();
    this.video.removeAttribute('src');
    this.video.load(); // 読み込み中のデータを解放する
    clearLayer(this.layer);
  }
}

function localErrorMessage(error: MediaError | null): string {
  switch (error?.code) {
    case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
      return 'この形式（コーデック）は再生できません';
    case MediaError.MEDIA_ERR_DECODE:
      return 'ファイルの読み込み中にエラーが起きました（ファイルが壊れている可能性があります）';
    case MediaError.MEDIA_ERR_NETWORK:
      return 'ファイルを読み込めません（移動・削除されていないか確認してください）';
    default:
      return 'ファイルを再生できません';
  }
}

// ---------------------------------------------------------------- YouTube

let youtubeApi: Promise<void> | null = null;

function loadYouTubeApi(): Promise<void> {
  if (window.YT?.Player) return Promise.resolve();
  youtubeApi ??= new Promise<void>((resolve, reject) => {
    const w = window as Window & { onYouTubeIframeAPIReady?: () => void };
    w.onYouTubeIframeAPIReady = () => resolve();
    const script = document.createElement('script');
    script.src = 'https://www.youtube.com/iframe_api';
    script.onerror = () => {
      youtubeApi = null;
      script.remove();
      reject(new Error('YouTube のプレイヤーを読み込めません（インターネット接続を確認してください）'));
    };
    document.head.append(script);
  });
  return youtubeApi;
}

// YT.PlayerState の値（API 読み込み前でも使えるよう数値で持つ）
const YT_ENDED = 0;
const YT_PLAYING = 1;
const YT_PAUSED = 2;
const YT_BUFFERING = 3;
const YT_CUED = 5;

export class YouTubePlayer implements Player {
  private player: YT.Player | null = null;
  private ready = false;
  private destroyed = false;
  private volume: number;
  private muted: boolean;

  constructor(
    private readonly layer: HTMLElement,
    ref: OnlineRef,
    opts: PlayerOptions,
    private readonly events: PlayerEvents,
    private loop = opts.loop,
  ) {
    this.volume = opts.volume;
    this.muted = opts.muted;
    const host = document.createElement('div');
    layer.replaceChildren(host);
    layer.hidden = false;

    loadYouTubeApi()
      .then(() => {
        if (this.destroyed) return;
        this.player = new YT.Player(host, {
          width: '100%',
          height: '100%',
          videoId: ref.id,
          playerVars: {
            autoplay: opts.autoplay ? 1 : 0,
            controls: 0,
            disablekb: 1,
            fs: 0,
            iv_load_policy: 3,
            playsinline: 1,
            rel: 0,
            start: ref.start || undefined,
            origin: location.origin,
          },
          events: {
            onReady: () => {
              this.ready = true;
              this.setVolume(this.volume, this.muted);
              if (opts.autoplay) this.player?.playVideo();
              else events.onState('paused');
            },
            onStateChange: (e) => this.handleState(e.data),
            onError: (e) => events.onState('error', youtubeErrorMessage(e.data)),
          },
        });
      })
      .catch((err: Error) => events.onState('error', err.message));
  }

  private handleState(state: number): void {
    switch (state) {
      case YT_PLAYING: {
        this.events.onState('playing');
        const data = (this.player as unknown as { getVideoData?: () => { title?: string } }).getVideoData?.();
        if (data?.title) this.events.onTitle(data.title);
        break;
      }
      case YT_PAUSED:
      case YT_CUED:
        this.events.onState('paused');
        break;
      case YT_BUFFERING:
        this.events.onState('loading');
        break;
      case YT_ENDED:
        if (this.loop) {
          this.player?.seekTo(0, true);
          this.player?.playVideo();
        } else {
          this.events.onState('ended');
        }
        break;
    }
  }

  play(): void {
    if (this.ready) this.player?.playVideo();
  }
  pause(): void {
    if (this.ready) this.player?.pauseVideo();
  }
  seek(time: number): void {
    if (this.ready) this.player?.seekTo(time, true);
  }
  setVolume(volume: number, muted: boolean): void {
    this.volume = volume;
    this.muted = muted;
    if (!this.ready || !this.player) return;
    this.player.setVolume(volume);
    if (muted) this.player.mute();
    else this.player.unMute();
  }
  setLoop(loop: boolean): void {
    this.loop = loop;
  }
  setSubtitle(lang: string): void {
    if (!this.ready || !this.player) return;
    try {
      const player = this.player as any;
      if (lang === '') {
        // 字幕オフ
        player.setOption?.('captions', 'fontSize', -1);
      } else {
        // 字幕を有効にして言語を設定
        player.loadModule?.('captions');
        player.setOption?.('captions', 'fontSize', 0);
        player.setOption?.('captions', 'lang', lang);
      }
    } catch {
      // 字幕API非対応
    }
  }
  currentTime(): number {
    return this.ready ? (this.player?.getCurrentTime() ?? 0) : 0;
  }
  duration(): number {
    return this.ready ? (this.player?.getDuration() ?? 0) : 0;
  }
  destroy(): void {
    this.destroyed = true;
    try {
      this.player?.destroy();
    } catch {
      // すでに破棄されている
    }
    this.player = null;
    clearLayer(this.layer);
  }
}

function youtubeErrorMessage(code: number): string {
  switch (code) {
    case 2:
      return 'YouTube の URL が正しくありません';
    case 5:
      return 'この YouTube 動画はプレイヤーで再生できません';
    case 100:
      return 'YouTube 動画が見つかりません（削除または非公開の可能性があります）';
    case 101:
    case 150:
      return 'この YouTube 動画は埋め込み再生が許可されていません';
    case 153:
      return 'YouTube プレイヤーの設定エラーです（リファラーが送られていません）';
    default:
      return `YouTube 動画を再生できません（エラー ${code}）`;
  }
}

// ---------------------------------------------------------------- Vimeo

export class VimeoPlayer implements Player {
  private readonly player: VimeoSdk;
  private time = 0;
  private length = 0;

  constructor(
    private readonly layer: HTMLElement,
    ref: OnlineRef,
    opts: PlayerOptions,
    events: PlayerEvents,
  ) {
    const host = document.createElement('div');
    host.style.width = '100%';
    host.style.height = '100%';
    layer.replaceChildren(host);
    layer.hidden = false;

    this.player = new VimeoSdk(host, {
      url: ref.url as `https://vimeo.com/${string}`,
      autoplay: opts.autoplay,
      controls: false,
      loop: opts.loop,
      title: false,
      byline: false,
      portrait: false,
      dnt: true,
    });
    const p = this.player;
    p.on('playing', () => events.onState('playing'));
    p.on('pause', () => events.onState('paused'));
    p.on('ended', () => events.onState('ended'));
    p.on('timeupdate', (data) => {
      this.time = data.seconds;
      this.length = data.duration;
      events.onUpdate();
    });
    p.on('error', (data) => events.onState('error', `Vimeo 動画を再生できません（${data.name}）`));

    p.ready()
      .then(async () => {
        this.setVolume(opts.volume, opts.muted);
        if (ref.start) await p.setCurrentTime(ref.start);
        this.length = await p.getDuration();
        events.onTitle(await p.getVideoTitle());
        if (!opts.autoplay) events.onState('paused');
        events.onUpdate();
      })
      .catch(() => events.onState('error', 'Vimeo 動画を読み込めません（非公開・埋め込み禁止の可能性があります）'));
  }

  play(): void {
    this.player.play().catch(() => {});
  }
  pause(): void {
    this.player.pause().catch(() => {});
  }
  seek(time: number): void {
    this.player.setCurrentTime(time).catch(() => {});
  }
  setVolume(volume: number, muted: boolean): void {
    this.player.setVolume(muted ? 0 : Math.min(1, Math.max(0, volume / 100))).catch(() => {});
  }
  setLoop(loop: boolean): void {
    this.player.setLoop(loop).catch(() => {});
  }
  currentTime(): number {
    return this.time;
  }
  duration(): number {
    return this.length;
  }
  destroy(): void {
    this.player.destroy().catch(() => {});
    clearLayer(this.layer);
  }
}
