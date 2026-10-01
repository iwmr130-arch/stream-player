// 出力ウィンドウ: 操作ウィンドウからの命令でメインの項目を再生し、状態を返す。
// 配信に映る画面なので、エラーは画面に出さず操作ウィンドウにだけ通知する。
import { parseOnlineUrl } from '../../shared/media';
import type { MainItem, OutputCommand, OutputStatus, PlaybackState } from '../../shared/types';
import { mediaUrl } from '../common';
import { LocalPlayer, VimeoPlayer, YouTubePlayer, type Player, type PlayerEvents } from './players';

const api = window.api;
const $ = (id: string) => document.getElementById(id) as HTMLElement;

const layers = {
  video: $('video-layer'),
  youtube: $('youtube-layer'),
  vimeo: $('vimeo-layer'),
};
const idleImage = $('idle-image') as HTMLImageElement;
const teleop = $('teleop');
const teleopTitle = $('teleop-title');
const teleopTime = $('teleop-time');

let mediaBase = '';
let player: Player | null = null;
/** 古い読み込みからのイベントを無視するための番号 */
let loadSeq = 0;
let volume = 80;
let muted = false;
let teleopEnabled = false;
let teleopTimer: number | null = null;
let subtitleEnabled = true;
let status: OutputStatus = { itemId: null, state: 'idle', currentTime: 0, duration: 0 };

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

function showTeleop(): void {
  if (!teleopEnabled) return;
  teleop.hidden = false;
  if (teleopTimer !== null) clearTimeout(teleopTimer);
  teleopTimer = window.setTimeout(() => {
    teleop.hidden = true;
    teleopTimer = null;
  }, 4000);
}

function report(patch: Partial<OutputStatus>): void {
  status = { ...status, error: undefined, ...patch };
  if (player) {
    status.currentTime = player.currentTime();
    status.duration = player.duration();
  }
  api.sendOutputStatus(status);

  // テロップの更新
  if (teleopEnabled && status.state === 'playing') {
    teleopTitle.textContent = status.title ?? '—';
    teleopTime.textContent = `${formatTime(status.currentTime)} / ${formatTime(status.duration)}`;
    showTeleop();
  }
}

function teardown(): void {
  loadSeq++;
  player?.destroy();
  player = null;
}

function load(item: MainItem, autoplay: boolean): void {
  teardown();
  const seq = loadSeq;
  status = { itemId: item.id, state: 'loading', currentTime: 0, duration: 0 };
  report({});

  const events: PlayerEvents = {
    onState: (state: PlaybackState, error?: string) => {
      if (seq === loadSeq) report({ state, error });
    },
    onUpdate: () => {
      if (seq === loadSeq) report({});
    },
    onTitle: (title: string) => {
      if (seq === loadSeq) report({ title });
    },
  };
  const opts = { autoplay, volume, muted, loop: item.endAction === 'loop' };

  if (item.kind === 'local') {
    player = new LocalPlayer(layers.video, mediaUrl(mediaBase, item.source), opts, events);
    return;
  }
  const ref = parseOnlineUrl(item.source);
  if (!ref) {
    report({ state: 'error', error: 'URL を読み取れません' });
    return;
  }
  player =
    ref.kind === 'youtube'
      ? new YouTubePlayer(layers.youtube, ref, opts, events)
      : new VimeoPlayer(layers.vimeo, ref, opts, events);
}

function handle(cmd: OutputCommand): void {
  switch (cmd.type) {
    case 'load':
      load(cmd.item, cmd.autoplay);
      break;
    case 'play':
      player?.play();
      break;
    case 'pause':
      player?.pause();
      break;
    case 'stop':
      teardown();
      status = { itemId: null, state: 'idle', currentTime: 0, duration: 0 };
      report({});
      break;
    case 'seek':
      player?.seek(cmd.time);
      break;
    case 'volume':
      volume = cmd.volume;
      muted = cmd.muted;
      player?.setVolume(volume, muted);
      break;
    case 'setLoop':
      player?.setLoop(cmd.loop);
      break;
    case 'idleImage':
      if (cmd.path) {
        idleImage.src = mediaUrl(mediaBase, cmd.path);
        idleImage.hidden = false;
      } else {
        idleImage.removeAttribute('src');
        idleImage.hidden = true;
      }
      break;
    case 'teleopEnabled':
      teleopEnabled = cmd.enabled;
      if (!cmd.enabled) teleop.hidden = true;
      break;
    case 'toggleSubtitle':
      subtitleEnabled = !subtitleEnabled;
      applySubtitleSetting();
      break;
  }
}

function applySubtitleSetting(): void {
  if (player && (player as any).loadModule) {
    const p = player as any;
    try {
      p.loadModule('captions');
      if (subtitleEnabled) {
        p.setOption('captions', 'fontSize', 0);
      } else {
        p.setOption('captions', 'fontSize', -1);
      }
    } catch {
      // API非対応
    }
  }
}

async function init(): Promise<void> {
  mediaBase = await api.getMediaBase();
  api.onOutputMode((mode) => {
    document.body.dataset.mode = mode;
  });
  api.onOutputCommand(handle);
  idleImage.addEventListener('error', () => {
    idleImage.hidden = true;
  });
  // 再生中は再生位置を定期的に知らせる
  setInterval(() => {
    if (player && status.state === 'playing') report({});
  }, 250);
  api.notifyOutputReady();
}

void init();
