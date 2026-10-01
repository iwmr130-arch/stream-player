// 保存ファイルやインポートしたファイルの中身を検証し、足りない値を既定値で補う
import crypto from 'node:crypto';
import {
  DEFAULT_SETTINGS,
  type AppState,
  type BgmItem,
  type EndAction,
  type MainItem,
  type MainItemKind,
  type Settings,
} from '../shared/types';
import { titleFromPath } from '../shared/media';

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d);

function num(v: unknown, min: number, max: number, d: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : d;
}

function oneOf<T extends string>(v: unknown, values: readonly T[], d: T): T {
  return values.includes(v as T) ? (v as T) : d;
}

export function normalizeState(raw: unknown): AppState {
  const r = isObj(raw) ? raw : {};
  const ids = new Set<string>();
  const uniqueId = (v: unknown): string => {
    let id = str(v);
    if (!id || ids.has(id)) id = crypto.randomUUID();
    ids.add(id);
    return id;
  };

  const main: MainItem[] = [];
  for (const it of Array.isArray(r.main) ? r.main : []) {
    if (!isObj(it)) continue;
    const source = str(it.source);
    if (!source) continue;
    main.push({
      id: uniqueId(it.id),
      kind: oneOf<MainItemKind>(it.kind, ['local', 'youtube', 'vimeo', 'browser'], 'local'),
      title: str(it.title) ?? titleFromPath(source),
      source,
      endAction: oneOf<EndAction>(it.endAction, ['stop', 'next', 'loop'], 'stop'),
    });
  }

  const bgm: BgmItem[] = [];
  for (const it of Array.isArray(r.bgm) ? r.bgm : []) {
    if (!isObj(it)) continue;
    const p = str(it.path);
    if (!p) continue;
    bgm.push({ id: uniqueId(it.id), title: str(it.title) ?? titleFromPath(p), path: p });
  }

  return { version: 1, main, bgm, settings: normalizeSettings(r.settings) };
}

function normalizeSettings(raw: unknown): Settings {
  const s = isObj(raw) ? raw : {};
  const d = DEFAULT_SETTINGS;
  return {
    outputMode: oneOf(s.outputMode, ['fullscreen', 'window'], d.outputMode),
    outputDisplayId: typeof s.outputDisplayId === 'number' ? s.outputDisplayId : null,
    mainVolume: num(s.mainVolume, 0, 100, d.mainVolume),
    mainMuted: bool(s.mainMuted, d.mainMuted),
    bgmVolume: num(s.bgmVolume, 0, 100, d.bgmVolume),
    bgmMuted: bool(s.bgmMuted, d.bgmMuted),
    bgmLoopMode: oneOf(s.bgmLoopMode, ['all', 'one', 'shuffle'], d.bgmLoopMode),
    duckingMode: oneOf(s.duckingMode, ['lower', 'pause', 'none'], d.duckingMode),
    duckingLevel: num(s.duckingLevel, 0, 100, d.duckingLevel),
    fadeMs: num(s.fadeMs, 0, 10000, d.fadeMs),
    idleImagePath: str(s.idleImagePath),
    previewEnabled: bool(s.previewEnabled, d.previewEnabled),
    teleopEnabled: bool(s.teleopEnabled, d.teleopEnabled),
  };
}
