// BGM ライン: 操作ウィンドウ内の <audio> で再生する。
// 音量は「設定の音量 × ダッキング × フェード」で決まり、ダッキングとフェードは別々に滑らかに変化させる。
import type { BgmItem, Settings } from '../../shared/types';

export interface BgmHost {
  items(): BgmItem[];
  settings(): Settings;
  /** 再生用の URL。ファイルが見つからないときは null */
  urlFor(item: BgmItem): string | null;
  /** 再生状態が変わった（表示を更新する） */
  onChange(): void;
  onError(message: string): void;
}

type Gain = 'duck' | 'fade';

interface Tween {
  timer: number;
  resolve: (completed: boolean) => void;
}

const TWEEN_STEP_MS = 20;

export class BgmPlayer {
  readonly audio = new Audio();
  currentId: string | null = null;
  /** ユーザーが再生を望んでいる状態か（ダッキングでの一時停止中も true のまま） */
  wantPlay = false;
  pausedByDuck = false;
  ducked = false;

  private readonly gains: Record<Gain, number> = { duck: 1, fade: 1 };
  private readonly tweens: Partial<Record<Gain, Tween>> = {};
  private errorStreak = 0;

  constructor(private readonly host: BgmHost) {
    const a = this.audio;
    a.preload = 'auto';
    a.addEventListener('ended', () => this.advance(1, true));
    a.addEventListener('playing', () => {
      this.errorStreak = 0;
      host.onChange();
    });
    a.addEventListener('pause', () => host.onChange());
    a.addEventListener('error', () => this.handleError());
    // 音量は設定の読み込み後に applyVolume() で反映する
  }

  get playing(): boolean {
    return !this.audio.paused;
  }

  get current(): BgmItem | undefined {
    return this.host.items().find((i) => i.id === this.currentId);
  }

  applyVolume(): void {
    const s = this.host.settings();
    this.audio.volume = Math.min(1, Math.max(0, (s.bgmVolume / 100) * this.gains.duck * this.gains.fade));
    this.audio.muted = s.bgmMuted;
    this.audio.loop = s.bgmLoopMode === 'one';
  }

  /** 指定した曲を最初から再生する */
  playItem(id: string): void {
    if (!this.load(id)) return;
    this.wantPlay = true;
    this.cancelTween('fade');
    this.gains.fade = 1;
    this.applyVolume();
    if (this.holdForDuck()) return;
    this.audio.play().catch(() => {});
    this.host.onChange();
  }

  /** フェードインで再生を始める（曲が未選択なら startId か先頭の曲） */
  async resume(startId?: string): Promise<void> {
    if (!this.currentId || !this.audio.getAttribute('src')) {
      const id = startId ?? this.host.items()[0]?.id;
      if (id) this.playItem(id);
      return;
    }
    this.wantPlay = true;
    if (this.holdForDuck()) return;
    if (this.audio.paused) {
      this.cancelTween('fade');
      this.gains.fade = 0;
      this.applyVolume();
      this.audio.play().catch(() => {});
    }
    this.host.onChange();
    await this.tween('fade', 1, this.host.settings().fadeMs);
  }

  /** フェードアウトしてから一時停止する */
  async pause(): Promise<void> {
    this.wantPlay = false;
    this.pausedByDuck = false;
    this.host.onChange();
    if (this.audio.paused) return;
    const completed = await this.tween('fade', 0, this.host.settings().fadeMs);
    if (completed && !this.wantPlay) this.audio.pause();
  }

  toggle(startId?: string): void {
    if (this.wantPlay) void this.pause();
    else void this.resume(startId);
  }

  next(): void {
    this.advance(1, false);
  }

  prev(): void {
    if (this.audio.currentTime > 3) {
      this.audio.currentTime = 0;
      return;
    }
    this.advance(-1, false);
  }

  seek(time: number): void {
    if (Number.isFinite(this.audio.duration)) this.audio.currentTime = time;
  }

  /** 再生を止め、曲の選択も解除する（再生中の曲をリストから消したときなど） */
  unload(): void {
    this.wantPlay = false;
    this.pausedByDuck = false;
    this.currentId = null;
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
    this.host.onChange();
  }

  /** メインの再生状態に合わせて BGM を下げる／戻す */
  setDucked(ducked: boolean): void {
    if (ducked === this.ducked) return;
    this.ducked = ducked;
    const s = this.host.settings();
    if (ducked) {
      if (s.duckingMode === 'lower') {
        void this.tween('duck', s.duckingLevel / 100, s.fadeMs);
      } else if (s.duckingMode === 'pause') {
        void this.tween('duck', 0, s.fadeMs).then((completed) => {
          if (completed && this.ducked && !this.audio.paused) {
            this.audio.pause();
            this.pausedByDuck = true;
            this.host.onChange();
          }
        });
      }
    } else {
      if (this.pausedByDuck) {
        this.pausedByDuck = false;
        if (this.wantPlay) this.audio.play().catch(() => {});
      }
      void this.tween('duck', 1, s.fadeMs);
    }
    this.host.onChange();
  }

  /** ダッキングの設定を変えたとき、今の状態に新しい設定を当て直す */
  refreshDucking(): void {
    if (!this.ducked) return;
    this.setDucked(false);
    this.setDucked(true);
  }

  // ---------------------------------------------------------------- 内部処理

  private load(id: string): boolean {
    const item = this.host.items().find((i) => i.id === id);
    if (!item) return false;
    const url = this.host.urlFor(item);
    if (!url) {
      this.host.onError(`BGM のファイルが見つかりません: ${item.title}`);
      return false;
    }
    this.currentId = id;
    this.audio.src = url;
    return true;
  }

  /** 「一時停止する」ダッキング中は再生せず、メインが終わってから再開する */
  private holdForDuck(): boolean {
    if (!this.ducked || this.host.settings().duckingMode !== 'pause') return false;
    this.pausedByDuck = true;
    this.host.onChange();
    return true;
  }

  private advance(step: 1 | -1, auto: boolean): void {
    const items = this.host.items();
    if (items.length === 0) {
      this.unload();
      return;
    }
    const index = items.findIndex((i) => i.id === this.currentId);
    let nextIndex: number;
    if (this.host.settings().bgmLoopMode === 'shuffle' && step === 1 && items.length > 1) {
      do nextIndex = Math.floor(Math.random() * items.length);
      while (nextIndex === index);
    } else if (index < 0) {
      nextIndex = 0;
    } else {
      nextIndex = (index + step + items.length) % items.length;
    }

    // 見つからないファイルをスキップして有効な曲を探す
    let found: string | null = null;
    for (let i = 0; i < items.length; i++) {
      const id = items[nextIndex].id;
      if (this.load(id)) {
        found = id;
        break;
      }
      nextIndex = (nextIndex + step + items.length) % items.length;
    }

    if (!found) {
      this.wantPlay = false;
      this.host.onError('BGM: 再生可能な曲がありません');
      this.host.onChange();
      return;
    }

    // 停止中に「次へ」を押したときは、曲を選ぶだけで再生はしない
    if (!auto && !this.wantPlay) {
      this.host.onChange();
      return;
    }
    this.playItem(found);
  }

  private handleError(): void {
    if (!this.audio.getAttribute('src')) return;
    this.host.onError(`BGM を再生できません: ${this.current?.title ?? ''}`);
    this.errorStreak++;
    // すべての曲が再生できない場合に無限に飛ばし続けないようにする
    if (this.wantPlay && this.errorStreak < this.host.items().length) {
      setTimeout(() => this.advance(1, true), 500);
    } else {
      this.wantPlay = false;
      this.host.onChange();
    }
  }

  private tween(key: Gain, to: number, ms: number): Promise<boolean> {
    this.cancelTween(key);
    const from = this.gains[key];
    if (ms <= 0 || from === to) {
      this.gains[key] = to;
      this.applyVolume();
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const start = performance.now();
      const timer = window.setInterval(() => {
        const t = Math.min(1, (performance.now() - start) / ms);
        this.gains[key] = from + (to - from) * t;
        this.applyVolume();
        if (t >= 1) {
          window.clearInterval(timer);
          delete this.tweens[key];
          resolve(true);
        }
      }, TWEEN_STEP_MS);
      this.tweens[key] = { timer, resolve };
    });
  }

  private cancelTween(key: Gain): void {
    const tween = this.tweens[key];
    if (!tween) return;
    window.clearInterval(tween.timer);
    delete this.tweens[key];
    tween.resolve(false);
  }
}
