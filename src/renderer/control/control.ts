// 操作ウィンドウ: プレイリストの編集、メインの再生指示、BGM の再生、設定を担当する
import { baseName, isAudioPath, isVideoPath, parseOnlineUrl, titleFromPath } from '../../shared/media';
import type {
  AppState,
  BgmItem,
  EndAction,
  MainItem,
  OutputCommand,
  OutputConfig,
  OutputStatus,
  PlaybackState,
} from '../../shared/types';
import { formatTime, mediaUrl, newId } from '../common';
import { BgmPlayer } from './bgm';

const api = window.api;
const isMac = api.platform === 'darwin';
const MOD = isMac ? '⌘' : 'Ctrl+';

function $<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

let state: AppState;
let mediaBase = '';
/** 見つからないローカルファイルのパス */
const missing = new Set<string>();
/** 出力ウィンドウが表示されているか（起動時は非表示） */
let outputVisible = false;
/** ブラウザモード: 再生中のYoutube/Vimeo動画 */
let browserUrl = '';
let browserKind: 'youtube' | 'vimeo' | null = null;
let browserPlaying = false;
let selectedBrowserId: string | null = null;

function save(): void {
  api.saveState(state);
}

function toast(message: string, kind: 'error' | 'info' = 'error'): void {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  $('toasts').append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 8000 : 4000);
}

function updateOutputButtonText(): void {
  const btn = $<HTMLButtonElement>('btn-toggle-output');
  btn.textContent = `出力ウィンドウ: ${outputVisible ? '表示' : '非表示'}`;
}

function sendOut(cmd: OutputCommand): void {
  api.sendOutputCommand(cmd);
}

// ================================================================ メインライン

let mainStatus: OutputStatus = { itemId: null, state: 'idle', currentTime: 0, duration: 0 };
/** 最後に再生を指示した項目（停止後も「次へ」の基準にする） */
let currentMainId: string | null = null;
let selectedMainId: string | null = null;
let mainSeeking = false;

const STATE_LABEL: Record<PlaybackState, string> = {
  idle: '待機',
  loading: '読み込み中',
  playing: '再生中',
  paused: '一時停止',
  ended: '終了',
  error: 'エラー',
};

function mainActive(): boolean {
  return mainStatus.state === 'playing' || mainStatus.state === 'paused' || mainStatus.state === 'loading';
}

function mainIndex(id: string | null): number {
  return id ? state.main.findIndex((i) => i.id === id) : -1;
}

function playMain(id: string): void {
  const item = state.main.find((i) => i.id === id);
  if (!item) return;
  if (item.kind === 'local' && missing.has(item.source)) {
    toast(`ファイルが見つかりません: ${baseName(item.source)}`);
    return;
  }
  currentMainId = id;
  selectedMainId = id;
  mainStatus = { itemId: id, state: 'loading', currentTime: 0, duration: 0 };
  sendOut({ type: 'load', item, autoplay: true });
  renderMainList();
  renderMainStatus();
  updateDucking();
}

function toggleMain(): void {
  switch (mainStatus.state) {
    case 'playing':
      sendOut({ type: 'pause' });
      break;
    case 'paused':
      sendOut({ type: 'play' });
      break;
    case 'loading':
      break;
    default: {
      const id = selectedMainId ?? currentMainId ?? state.main[0]?.id;
      if (id) playMain(id);
    }
  }
}

function stopMain(): void {
  sendOut({ type: 'stop' });
}

function nextMain(): void {
  const next = state.main[mainIndex(currentMainId ?? selectedMainId) + 1];
  if (next) playMain(next.id);
}

function prevMain(): void {
  if (mainActive() && mainStatus.currentTime > 3) {
    sendOut({ type: 'seek', time: 0 });
    return;
  }
  const prev = state.main[mainIndex(currentMainId ?? selectedMainId) - 1];
  if (prev) playMain(prev.id);
}

function handleOutputStatus(status: OutputStatus): void {
  // 別の項目に切り替えた直後に届いた、前の項目の通知は無視する
  if (status.itemId !== null && status.itemId !== currentMainId) return;
  const prevState = mainStatus.state;
  mainStatus = status;

  const item = state.main.find((i) => i.id === status.itemId);
  if (item && status.title && item.title === item.source) {
    item.title = status.title;
    save();
    renderMainList();
  }
  if (status.state === 'error' && prevState !== 'error') {
    toast(`${item?.title ?? 'メイン'}: ${status.error ?? '再生できません'}`);
  }
  if (status.state === 'ended' && prevState !== 'ended' && item) {
    const next = state.main[mainIndex(item.id) + 1];
    if (item.endAction === 'next' && next) playMain(next.id);
    else stopMain();
  }
  if (status.state !== prevState) renderMainList();
  renderMainStatus();
  updateDucking();
}

function renderMainStatus(): void {
  const item = state.main.find((i) => i.id === mainStatus.itemId);
  const badge = $('main-state');
  badge.textContent = STATE_LABEL[mainStatus.state];
  badge.dataset.state = mainStatus.state;
  $('main-title').textContent = item?.title ?? '—';
  $('main-play').textContent = mainStatus.state === 'playing' ? '⏸' : '▶';

  const seek = $<HTMLInputElement>('main-seek');
  const { currentTime, duration } = mainStatus;
  seek.disabled = !(duration > 0) || !mainActive();
  if (!mainSeeking) {
    seek.value = String(duration > 0 ? Math.round((currentTime / duration) * 1000) : 0);
    $('main-time').textContent = formatTime(currentTime);
  }
  $('main-duration').textContent = formatTime(duration);
}

function sendMainVolume(): void {
  const s = state.settings;
  sendOut({ type: 'volume', volume: s.mainVolume, muted: s.mainMuted });
}

function kindLabel(item: MainItem): [string, string] {
  if (item.kind === 'youtube') return ['YouTube', 'youtube'];
  if (item.kind === 'vimeo') return ['Vimeo', 'vimeo'];
  return isAudioPath(item.source) ? ['音声', 'audio'] : ['動画', 'video'];
}

function renderMainList(): void {
  const rows = state.main.map((item, index) => {
    const li = listRow(item.id, index, item.title);
    li.classList.toggle('current', item.id === currentMainId && mainActive());
    li.classList.toggle('selected', item.id === selectedMainId);
    li.classList.toggle('missing', item.kind === 'local' && missing.has(item.source));
    li.title = item.source;

    const [label, cls] = kindLabel(item);
    const kind = document.createElement('span');
    kind.className = `kind ${cls}`;
    kind.textContent = label;
    li.querySelector('.num')!.after(kind);

    const end = document.createElement('select');
    end.title = '再生が終わったら';
    for (const [value, text] of [
      ['stop', '終了後: 停止'],
      ['next', '終了後: 次へ'],
      ['loop', '終了後: ループ'],
    ] as const) {
      end.add(new Option(text, value, false, item.endAction === value));
    }
    end.addEventListener('change', () => {
      item.endAction = end.value as EndAction;
      save();
      if (item.id === currentMainId && mainActive()) sendOut({ type: 'setLoop', loop: item.endAction === 'loop' });
    });
    li.querySelector('.remove')!.before(end);
    return li;
  });
  $('main-list').replaceChildren(...rows);
}

function removeMain(id: string): void {
  if (id === currentMainId) {
    if (mainActive()) stopMain();
    currentMainId = null;
  }
  if (id === selectedMainId) selectedMainId = null;
  state.main = state.main.filter((i) => i.id !== id);
  save();
  renderMainList();
}

function addMainPaths(paths: string[], at = state.main.length): void {
  const ok = paths.filter((p) => isVideoPath(p) || isAudioPath(p));
  if (ok.length < paths.length) toast(`対応していない形式のファイルを ${paths.length - ok.length} 件スキップしました`);
  const items: MainItem[] = ok.map((p) => ({
    id: newId(),
    kind: 'local',
    title: titleFromPath(p),
    source: p,
    endAction: 'stop',
  }));
  for (const p of ok) missing.delete(p);
  state.main.splice(at, 0, ...items);
  save();
  renderMainList();
}

function addMainUrls(text: string, at = state.main.length): boolean {
  const urls = text
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const items: MainItem[] = [];
  for (const url of urls) {
    const ref = parseOnlineUrl(url);
    if (ref) items.push({ id: newId(), kind: ref.kind, title: url, source: url, endAction: 'stop' });
  }
  if (items.length === 0) {
    toast('YouTube または Vimeo の URL を入力してください');
    return false;
  }
  state.main.splice(at, 0, ...items);
  save();
  renderMainList();
  // タイトルは後から取得する（取得できなければ再生時に取得する）
  for (const item of items) {
    void api.fetchOnlineTitle(item.source).then((title) => {
      if (!title || item.title !== item.source) return;
      item.title = title;
      save();
      renderMainList();
      renderMainStatus();
    });
  }
  return true;
}

// ================================================================ BGM ライン

let bgmSeeking = false;
let selectedBgmId: string | null = null;

const bgm = new BgmPlayer({
  items: () => state.bgm,
  settings: () => state.settings,
  urlFor: (item) => (missing.has(item.path) ? null : mediaUrl(mediaBase, item.path)),
  onChange: () => {
    renderBgmStatus();
    renderBgmList();
  },
  onError: (message) => toast(message),
});

function updateDucking(): void {
  bgm.setDucked(mainActive());
  $('duck-indicator').hidden = !(bgm.ducked && state.settings.duckingMode !== 'none');
}

function renderBgmStatus(): void {
  const badge = $('bgm-state');
  if (bgm.pausedByDuck) {
    badge.textContent = 'ダッキングで一時停止';
    badge.dataset.state = 'ducked';
  } else if (bgm.playing && bgm.wantPlay) {
    badge.textContent = '再生中';
    badge.dataset.state = 'playing';
  } else {
    badge.textContent = '停止';
    badge.dataset.state = 'idle';
  }
  $('bgm-title').textContent = bgm.current?.title ?? '—';
  $('bgm-play').textContent = bgm.wantPlay ? '⏸' : '▶';
  renderBgmTime();
}

function renderBgmTime(): void {
  const { currentTime, duration } = bgm.audio;
  const d = Number.isFinite(duration) ? duration : 0;
  const seek = $<HTMLInputElement>('bgm-seek');
  seek.disabled = !(d > 0);
  if (!bgmSeeking) {
    seek.value = String(d > 0 ? Math.round((currentTime / d) * 1000) : 0);
    $('bgm-time').textContent = formatTime(currentTime);
  }
  $('bgm-duration').textContent = formatTime(d);
}

function renderBgmList(): void {
  const rows = state.bgm.map((item, index) => {
    const li = listRow(item.id, index, item.title);
    li.classList.toggle('current', item.id === bgm.currentId);
    li.classList.toggle('selected', item.id === selectedBgmId);
    li.classList.toggle('missing', missing.has(item.path));
    li.title = item.path;
    return li;
  });
  $('bgm-list').replaceChildren(...rows);
}

function removeBgm(id: string): void {
  if (id === bgm.currentId) bgm.unload();
  if (id === selectedBgmId) selectedBgmId = null;
  state.bgm = state.bgm.filter((i) => i.id !== id);
  save();
  renderBgmList();
  renderBgmStatus();
}

function addBgmPaths(paths: string[], at = state.bgm.length): void {
  const ok = paths.filter((p) => isAudioPath(p) || isVideoPath(p));
  if (ok.length < paths.length) toast(`対応していない形式のファイルを ${paths.length - ok.length} 件スキップしました`);
  const items: BgmItem[] = ok.map((p) => ({ id: newId(), title: titleFromPath(p), path: p }));
  for (const p of ok) missing.delete(p);
  state.bgm.splice(at, 0, ...items);
  save();
  renderBgmList();
}

// ================================================================ リスト共通（行・並べ替え・ドロップ）

type ListName = 'main' | 'bgm';
const DRAG_TYPE = 'application/x-streamplayer-item';

function listRow(id: string, index: number, title: string): HTMLLIElement {
  const li = document.createElement('li');
  li.dataset.id = id;
  li.draggable = true;

  const num = document.createElement('span');
  num.className = 'num';
  num.textContent = String(index + 1);

  const name = document.createElement('span');
  name.className = 'title';
  name.textContent = title;

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'remove';
  remove.title = 'リストから削除';
  remove.textContent = '✕';

  li.append(num, name, remove);
  return li;
}

function setupList(list: ListName, ul: HTMLElement): void {
  const items = (): Array<{ id: string }> => (list === 'main' ? state.main : state.bgm);
  const rowOf = (e: Event) => (e.target as Element).closest<HTMLLIElement>('li');

  ul.addEventListener('click', (e) => {
    const li = rowOf(e);
    if (!li) return;
    const id = li.dataset.id!;
    if ((e.target as Element).closest('.remove')) {
      if (list === 'main') removeMain(id);
      else removeBgm(id);
      return;
    }
    if ((e.target as Element).closest('select')) return;
    if (list === 'main') {
      selectedMainId = id;
      renderMainList();
    } else {
      selectedBgmId = id;
      renderBgmList();
    }
  });

  ul.addEventListener('dblclick', (e) => {
    const li = rowOf(e);
    if (!li || (e.target as Element).closest('select, button')) return;
    if (list === 'main') playMain(li.dataset.id!);
    else bgm.playItem(li.dataset.id!);
  });

  ul.addEventListener('dragstart', (e) => {
    const li = rowOf(e);
    if (!li || !e.dataTransfer) return;
    e.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ list, id: li.dataset.id }));
    e.dataTransfer.effectAllowed = 'move';
  });

  const clearMarks = () => {
    ul.classList.remove('drop-target');
    ul.querySelectorAll('.drop-before, .drop-after').forEach((el) => el.classList.remove('drop-before', 'drop-after'));
  };

  /** ドロップ位置（リスト内の挿入位置）を求める */
  const dropIndex = (e: DragEvent): { index: number; li: HTMLLIElement | null; after: boolean } => {
    const li = rowOf(e);
    if (!li) return { index: items().length, li: null, after: true };
    const rect = li.getBoundingClientRect();
    const after = e.clientY > rect.top + rect.height / 2;
    const index = items().findIndex((i) => i.id === li.dataset.id) + (after ? 1 : 0);
    return { index, li, after };
  };

  ul.addEventListener('dragover', (e) => {
    if (!e.dataTransfer) return;
    e.preventDefault();
    const internal = e.dataTransfer.types.includes(DRAG_TYPE);
    e.dataTransfer.dropEffect = internal ? 'move' : 'copy';
    clearMarks();
    const { li, after } = dropIndex(e);
    if (li) li.classList.add(after ? 'drop-after' : 'drop-before');
    else ul.classList.add('drop-target');
  });

  ul.addEventListener('dragleave', (e) => {
    if (!ul.contains(e.relatedTarget as Node)) clearMarks();
  });

  ul.addEventListener('drop', (e) => {
    e.preventDefault();
    clearMarks();
    const dt = e.dataTransfer;
    if (!dt) return;
    const { index } = dropIndex(e);

    const internal = dt.getData(DRAG_TYPE);
    if (internal) {
      const { list: from, id } = JSON.parse(internal) as { list: ListName; id: string };
      if (from === list) moveItem(list, id, index);
      return;
    }

    const paths = [...dt.files].map((f) => api.pathForFile(f)).filter(Boolean);
    if (paths.length > 0) {
      if (list === 'main') addMainPaths(paths, index);
      else addBgmPaths(paths, index);
      return;
    }
    const text = dt.getData('text/uri-list') || dt.getData('text/plain');
    if (text && list === 'main') addMainUrls(text, index);
  });
}

function moveItem(list: ListName, id: string, to: number): void {
  const arr: Array<{ id: string }> = list === 'main' ? state.main : state.bgm;
  const from = arr.findIndex((i) => i.id === id);
  if (from < 0) return;
  const [item] = arr.splice(from, 1);
  arr.splice(from < to ? to - 1 : to, 0, item);
  save();
  if (list === 'main') renderMainList();
  else renderBgmList();
}

// ================================================================ 出力ウィンドウの設定

async function refreshDisplays(): Promise<void> {
  const displays = await api.getDisplays();
  const select = $<HTMLSelectElement>('output-display');
  const s = state.settings;
  // 保存したディスプレイがなければ、メイン以外のディスプレイ（なければメイン）を選ぶ
  const selected =
    displays.find((d) => d.id === s.outputDisplayId) ?? displays.find((d) => !d.primary) ?? displays[0];
  select.replaceChildren(...displays.map((d) => new Option(d.label, String(d.id), false, d.id === selected?.id)));
}

function renderOutputControls(): void {
  const s = state.settings;
  $<HTMLSelectElement>('output-mode').value = s.outputMode;
  $('output-display-group').hidden = s.outputMode !== 'fullscreen';
}

function applyOutputSettings(): void {
  const mode = $<HTMLSelectElement>('output-mode').value as OutputConfig['mode'];
  const displayId = Number($<HTMLSelectElement>('output-display').value);
  state.settings.outputMode = mode;
  state.settings.outputDisplayId = Number.isFinite(displayId) ? displayId : null;
  save();
  renderOutputControls();
  api.configureOutput({ mode, displayId: state.settings.outputDisplayId });
}

function sendIdleImage(): void {
  sendOut({ type: 'idleImage', path: state.settings.idleImagePath });
}

// ================================================================ 設定ダイアログ

function renderSettings(): void {
  const s = state.settings;
  $<HTMLSelectElement>('set-ducking-mode').value = s.duckingMode;
  $<HTMLInputElement>('set-ducking-level').value = String(s.duckingLevel);
  $('set-ducking-level-value').textContent = `${s.duckingLevel}%`;
  $<HTMLInputElement>('set-fade').value = String(s.fadeMs / 1000);
  $('set-idle-image').textContent = s.idleImagePath ? baseName(s.idleImagePath) : '黒い画面';
  $('set-idle-image').title = s.idleImagePath ?? '';
  $<HTMLInputElement>('set-preview').checked = s.previewEnabled;
  $<HTMLInputElement>('set-teleop').checked = s.teleopEnabled;
  $('set-missing-count').textContent = missing.size > 0 ? `${missing.size} 件見つかりません` : '';
}

function setupSettings(): void {
  const dialog = $<HTMLDialogElement>('settings-dialog');
  $('btn-settings').addEventListener('click', () => {
    renderSettings();
    dialog.showModal();
  });

  $('set-ducking-mode').addEventListener('change', (e) => {
    state.settings.duckingMode = (e.target as HTMLSelectElement).value as typeof state.settings.duckingMode;
    save();
    bgm.refreshDucking();
    updateDucking();
  });
  $('set-ducking-level').addEventListener('input', (e) => {
    state.settings.duckingLevel = Number((e.target as HTMLInputElement).value);
    $('set-ducking-level-value').textContent = `${state.settings.duckingLevel}%`;
    save();
  });
  $('set-ducking-level').addEventListener('change', () => bgm.refreshDucking());
  $('set-fade').addEventListener('change', (e) => {
    const sec = Number((e.target as HTMLInputElement).value);
    state.settings.fadeMs = Number.isFinite(sec) ? Math.round(Math.min(10, Math.max(0, sec)) * 1000) : 1000;
    save();
    renderSettings();
  });

  $('set-idle-choose').addEventListener('click', async () => {
    const [file] = await api.openMediaDialog('image');
    if (!file) return;
    state.settings.idleImagePath = file;
    save();
    sendIdleImage();
    renderSettings();
  });
  $('set-idle-clear').addEventListener('click', () => {
    state.settings.idleImagePath = null;
    save();
    sendIdleImage();
    renderSettings();
  });

  $('set-preview').addEventListener('change', (e) => {
    state.settings.previewEnabled = (e.target as HTMLInputElement).checked;
    save();
    applyPreviewSetting();
  });

  $('set-teleop').addEventListener('change', (e) => {
    state.settings.teleopEnabled = (e.target as HTMLInputElement).checked;
    save();
    sendOut({ type: 'teleopEnabled', enabled: state.settings.teleopEnabled });
  });

  $('set-export').addEventListener('click', async () => {
    try {
      if (await api.exportState(state)) toast('エクスポートしました', 'info');
    } catch {
      toast('エクスポートに失敗しました');
    }
  });

  $('set-import').addEventListener('click', async () => {
    let imported: AppState | null;
    try {
      imported = await api.importState();
    } catch {
      toast('インポートできませんでした（ファイルの形式を確認してください）');
      return;
    }
    if (!imported) return;
    if (!confirm('今のプレイリストと設定を、読み込んだ内容で置き換えます。よろしいですか？')) return;
    stopMain();
    bgm.unload();
    currentMainId = null;
    selectedMainId = null;
    selectedBgmId = null;
    // 出力の表示方法はこの PC の設定を使い続ける
    imported.settings.outputMode = state.settings.outputMode;
    imported.settings.outputDisplayId = state.settings.outputDisplayId;
    state = imported;
    save();
    applyAllSettings();
    await checkMissing();
    renderAll();
    renderSettings();
    toast(
      missing.size > 0
        ? `インポートしました。見つからないファイルが ${missing.size} 件あります（「フォルダから探す」で探せます）`
        : 'インポートしました',
      'info',
    );
  });

  $('set-relink').addEventListener('click', relinkMissing);
}

function localPaths(): string[] {
  return [
    ...state.main.filter((i) => i.kind === 'local').map((i) => i.source),
    ...state.bgm.map((i) => i.path),
  ];
}

async function checkMissing(): Promise<void> {
  const paths = localPaths();
  const exists = await api.filesExist(paths);
  missing.clear();
  paths.forEach((p, i) => {
    if (!exists[i]) missing.add(p);
  });
  const hint = $('missing-hint');
  hint.hidden = missing.size === 0;
  hint.textContent = `見つからないファイル: ${missing.size} 件（設定から探せます）`;
}

async function relinkMissing(): Promise<void> {
  if (missing.size === 0) {
    toast('見つからないファイルはありません', 'info');
    return;
  }
  const names = [...new Set([...missing].map((p) => baseName(p)))];
  const found = await api.findInFolder(names);
  if (!found) return;
  const resolve = (p: string) => (missing.has(p) ? found[baseName(p).toLowerCase()] : undefined);
  let count = 0;
  for (const item of state.main) {
    const next = item.kind === 'local' ? resolve(item.source) : undefined;
    if (next) {
      item.source = next;
      count++;
    }
  }
  for (const item of state.bgm) {
    const next = resolve(item.path);
    if (next) {
      item.path = next;
      count++;
    }
  }
  save();
  await checkMissing();
  renderAll();
  renderSettings();
  toast(`${count} 件のファイルを見つけました`, 'info');
}

// ================================================================ プレビュー

function applyPreviewSetting(): void {
  const on = state.settings.previewEnabled;
  api.setPreview(on);
  $('preview').hidden = !on;
  $('preview-off').hidden = on;
}

// ================================================================ ショートカットキー

function setupHotkeys(): void {
  $('shortcut-hint').textContent =
    `Space: メイン再生／一時停止　Esc: メイン停止　${MOD}→ / ${MOD}←: メイン次へ／前へ　B: BGM 再生／一時停止`;

  document.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement;
    const typing =
      t instanceof HTMLTextAreaElement ||
      t instanceof HTMLSelectElement ||
      (t instanceof HTMLInputElement && t.type !== 'range' && t.type !== 'checkbox');
    if (typing || document.querySelector('dialog[open]')) return;
    const mod = isMac ? e.metaKey : e.ctrlKey;

    if (e.code === 'Space' && !mod) {
      e.preventDefault();
      // フォーカス中のボタンが Space で押されないようにする
      if (t instanceof HTMLButtonElement) t.blur();
      toggleMain();
    } else if (e.code === 'Escape') {
      stopMain();
    } else if (mod && e.code === 'ArrowRight') {
      e.preventDefault();
      nextMain();
    } else if (mod && e.code === 'ArrowLeft') {
      e.preventDefault();
      prevMain();
    } else if (e.code === 'KeyB' && !mod && !e.altKey) {
      bgm.toggle(selectedBgmId ?? undefined);
    }
  });
}

// ================================================================ 初期化

function renderAll(): void {
  renderOutputControls();
  updateOutputButtonText();
  renderMainList();
  renderMainStatus();
  renderBgmList();
  renderBgmStatus();
  renderVolumes();
  renderBrowserList();
}

function renderVolumes(): void {
  const s = state.settings;
  $<HTMLInputElement>('main-volume').value = String(s.mainVolume);
  $('main-volume-value').textContent = String(s.mainVolume);
  $('main-mute').textContent = s.mainMuted ? '🔇' : '🔊';
  $<HTMLInputElement>('bgm-volume').value = String(s.bgmVolume);
  $('bgm-volume-value').textContent = String(s.bgmVolume);
  $('bgm-mute').textContent = s.bgmMuted ? '🔇' : '🔊';
  $<HTMLSelectElement>('bgm-loop').value = s.bgmLoopMode;
}

/** 設定を出力ウィンドウと BGM に反映する */
function applyAllSettings(): void {
  sendMainVolume();
  sendIdleImage();
  bgm.applyVolume();
  applyPreviewSetting();
  sendOut({ type: 'teleopEnabled', enabled: state.settings.teleopEnabled });
}

function updateBrowserPlayButton(): void {
  $('browser-play').dataset.playing = browserPlaying ? 'true' : 'false';
}

function playBrowserItem(item: MainItem): void {
  if (item.kind !== 'browser') return;
  selectedBrowserId = item.id;
  browserUrl = item.source;
  const ref = parseOnlineUrl(browserUrl);
  if (!ref) {
    toast('URLが無効です', 'error');
    return;
  }
  browserKind = ref.kind;
  renderBrowserPlayer();
  renderBrowserList();
  // 自動再生
  browserPlaying = true;
  updateBrowserPlayButton();
  const playItem: MainItem = { ...item };
  sendOut({ type: 'load', item: playItem, autoplay: true });
}

function renderBrowserList(): void {
  const ul = $('browser-list');
  const browserItems = state.main.filter((item) => item.kind === 'browser');

  ul.innerHTML = '';

  if (browserItems.length === 0) {
    ul.dataset.empty = 'ブラウザプレイリストが空です';
    return;
  }

  for (const item of browserItems) {
    const li = document.createElement('li');
    li.dataset.id = item.id;
    if (item.id === selectedBrowserId) li.dataset.selected = 'true';

    const titleSpan = document.createElement('span');
    titleSpan.className = 'title';
    titleSpan.textContent = item.title;

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'delete icon small';
    deleteBtn.textContent = '✕';
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      state.main = state.main.filter((i) => i.id !== item.id);
      if (selectedBrowserId === item.id) {
        selectedBrowserId = state.main.find((i) => i.kind === 'browser')?.id ?? null;
        if (selectedBrowserId) {
          const nextItem = state.main.find((i) => i.id === selectedBrowserId);
          if (nextItem) playBrowserItem(nextItem);
        } else {
          browserUrl = '';
          browserKind = null;
          renderBrowserPlayer();
        }
      }
      save();
      renderBrowserList();
    });

    li.appendChild(titleSpan);
    li.appendChild(deleteBtn);
    li.addEventListener('click', () => playBrowserItem(item));
    ul.appendChild(li);
  }
}

function loadBrowserUrl(): void {
  const urlInput = $<HTMLInputElement>('browser-url');
  const url = urlInput.value.trim();
  if (!url) {
    toast('URLを入力してください', 'info');
    return;
  }
  const ref = parseOnlineUrl(url);
  if (!ref) {
    toast('YouTubeまたはVimeoのURLを入力してください', 'error');
    return;
  }
  browserUrl = url;
  browserKind = ref.kind;
  renderBrowserPlayer();
}

function renderBrowserPlayer(): void {
  const ytDiv = $('browser-player-youtube');
  const vmDiv = $('browser-player-vimeo');
  ytDiv.innerHTML = '';
  vmDiv.innerHTML = '';

  if (!browserUrl || !browserKind) return;

  const ref = parseOnlineUrl(browserUrl);
  if (!ref) return;

  if (browserKind === 'youtube') {
    const iframe = document.createElement('iframe');
    iframe.src = `https://www.youtube.com/embed/${ref.id}?enablejsapi=1`;
    iframe.allow = 'autoplay';
    ytDiv.appendChild(iframe);
  } else if (browserKind === 'vimeo') {
    const iframe = document.createElement('iframe');
    iframe.src = `https://player.vimeo.com/video/${ref.id}`;
    iframe.allow = 'autoplay';
    vmDiv.appendChild(iframe);
  }
}

function setupControls(): void {
  // メイン
  $('main-play').addEventListener('click', toggleMain);
  $('main-stop').addEventListener('click', stopMain);
  $('main-next').addEventListener('click', nextMain);
  $('main-prev').addEventListener('click', prevMain);
  $('main-play').title = '再生／一時停止 (Space)';
  $('main-stop').title = '停止 (Esc)';
  $('main-next').title = `次へ (${MOD}→)`;
  $('main-prev').title = `前へ・頭出し (${MOD}←)`;

  const mainSeek = $<HTMLInputElement>('main-seek');
  mainSeek.addEventListener('input', () => {
    mainSeeking = true;
    $('main-time').textContent = formatTime((Number(mainSeek.value) / 1000) * mainStatus.duration);
  });
  mainSeek.addEventListener('change', () => {
    sendOut({ type: 'seek', time: (Number(mainSeek.value) / 1000) * mainStatus.duration });
    mainSeeking = false;
  });

  $('main-volume').addEventListener('input', (e) => {
    state.settings.mainVolume = Number((e.target as HTMLInputElement).value);
    renderVolumes();
    sendMainVolume();
    save();
  });
  $('main-mute').addEventListener('click', () => {
    state.settings.mainMuted = !state.settings.mainMuted;
    renderVolumes();
    sendMainVolume();
    save();
  });

  $('main-add-file').addEventListener('click', async () => addMainPaths(await api.openMediaDialog('main')));
  const urlInput = $<HTMLInputElement>('main-url');
  const modeSelect = $<HTMLSelectElement>('main-url-mode');

  const updateModeSelect = () => {
    const url = urlInput.value.trim();
    const ref = url ? parseOnlineUrl(url) : null;
    modeSelect.hidden = !ref;
  };

  const addUrl = () => {
    const url = urlInput.value.trim();
    if (!url) return;
    const ref = parseOnlineUrl(url);
    if (!ref) {
      // ローカルファイルでない場合は何もしない
      return;
    }
    const mode = modeSelect.value as 'normal' | 'browser';
    if (mode === 'browser') {
      // ブラウザモードの場合、state.main に browser kind のアイテムを追加
      const item: MainItem = {
        id: newId(),
        kind: 'browser',
        title: ref.url,
        source: url,
        endAction: 'stop',
      };
      state.main.push(item);
      save();
      renderBrowserList();
      // 最初に追加されたアイテムなら自動再生
      if (!selectedBrowserId) {
        selectedBrowserId = item.id;
        playBrowserItem(item);
      }
    } else {
      // 通常モード: プレイリストに追加
      addMainUrls(url);
    }
    urlInput.value = '';
    updateModeSelect();
  };
  $('main-add-url').addEventListener('click', addUrl);
  urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addUrl();
  });
  urlInput.addEventListener('input', updateModeSelect);

  // BGM
  $('bgm-play').addEventListener('click', () => bgm.toggle(selectedBgmId ?? undefined));
  $('bgm-play').title = 'BGM 再生／一時停止 (B)';
  $('bgm-next').addEventListener('click', () => bgm.next());
  $('bgm-prev').addEventListener('click', () => bgm.prev());
  $('bgm-loop').addEventListener('change', (e) => {
    state.settings.bgmLoopMode = (e.target as HTMLSelectElement).value as typeof state.settings.bgmLoopMode;
    bgm.applyVolume();
    save();
  });

  const bgmSeek = $<HTMLInputElement>('bgm-seek');
  bgmSeek.addEventListener('input', () => {
    bgmSeeking = true;
    $('bgm-time').textContent = formatTime((Number(bgmSeek.value) / 1000) * (bgm.audio.duration || 0));
  });
  bgmSeek.addEventListener('change', () => {
    bgm.seek((Number(bgmSeek.value) / 1000) * (bgm.audio.duration || 0));
    bgmSeeking = false;
  });
  bgm.audio.addEventListener('timeupdate', renderBgmTime);
  bgm.audio.addEventListener('durationchange', renderBgmTime);

  $('bgm-volume').addEventListener('input', (e) => {
    state.settings.bgmVolume = Number((e.target as HTMLInputElement).value);
    renderVolumes();
    bgm.applyVolume();
    save();
  });
  $('bgm-mute').addEventListener('click', () => {
    state.settings.bgmMuted = !state.settings.bgmMuted;
    renderVolumes();
    bgm.applyVolume();
    save();
  });
  $('bgm-add-file').addEventListener('click', async () => addBgmPaths(await api.openMediaDialog('bgm')));

  // ブラウザモード
  $('browser-load').addEventListener('click', loadBrowserUrl);
  $<HTMLInputElement>('browser-url').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') loadBrowserUrl();
  });
  $('browser-play').addEventListener('click', () => {
    browserPlaying = true;
    updateBrowserPlayButton();
    // 出力ウィンドウに再生を開始させる
    const item: MainItem = {
      id: 'browser-' + Date.now(),
      kind: 'browser',
      title: $<HTMLInputElement>('browser-url').value || 'ブラウザコンテンツ',
      source: browserUrl,
      endAction: 'stop',
    };
    sendOut({ type: 'load', item, autoplay: true });
  });
  $('browser-pause').addEventListener('click', () => {
    browserPlaying = false;
    updateBrowserPlayButton();
    sendOut({ type: 'pause' });
  });
  const browserSeek = $<HTMLInputElement>('browser-seek');
  browserSeek.addEventListener('change', () => {
    const time = Number(browserSeek.value);
    sendOut({ type: 'browserSeek', time });
  });

  // 出力
  $('output-mode').addEventListener('change', applyOutputSettings);
  $('output-display').addEventListener('change', applyOutputSettings);
  $('btn-toggle-output').addEventListener('click', () => api.toggleOutput());

  setupList('main', $('main-list'));
  setupList('bgm', $('bgm-list'));

  // リスト以外にファイルを落としても、ページが切り替わらないようにする
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());
}

async function init(): Promise<void> {
  [mediaBase, state] = await Promise.all([api.getMediaBase(), api.loadState()]);

  setupControls();
  setupSettings();
  setupHotkeys();

  api.onOutputStatus(handleOutputStatus);
  api.onOutputReady(() => {
    // 出力画面が（再）読み込みされたら、再生状態をリセットして設定を送り直す
    mainStatus = { itemId: null, state: 'idle', currentTime: 0, duration: 0 };
    applyAllSettings();
    renderMainStatus();
    renderMainList();
    updateDucking();
  });
  api.onOutputWarning((message) => toast(message));
  api.onOutputModeChanged((config) => {
    state.settings.outputMode = config.mode;
    save();
    renderOutputControls();
  });
  api.onDisplaysChanged(() => void refreshDisplays());
  api.onPreviewFrame((dataUrl) => {
    ($('preview') as HTMLImageElement).src = dataUrl;
  });
  api.onHotkey((action) => {
    if (action === 'mainToggle') toggleMain();
    else if (action === 'mainStop') stopMain();
    else if (action === 'mainNext') nextMain();
    else if (action === 'mainPrev') prevMain();
    else if (action === 'bgmToggle') bgm.toggle(selectedBgmId ?? undefined);
    else if (action === 'toggleOutput') api.toggleOutput();
  });
  api.onOutputVisibilityChanged((visible) => {
    outputVisible = visible;
    updateOutputButtonText();
  });

  await refreshDisplays();
  await checkMissing();
  applyAllSettings();
  renderAll();
}

void init();
