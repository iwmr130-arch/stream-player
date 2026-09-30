// ファイル形式の判定と、YouTube / Vimeo の URL 解析

export const VIDEO_EXTS = ['mp4', 'm4v', 'webm', 'mov', 'mkv', 'avi'];
export const AUDIO_EXTS = ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'oga', 'opus'];
export const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'];

/** Windows と Mac のどちらのパスでも最後の要素を返す */
export function baseName(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

export function extOf(p: string): string {
  const name = baseName(p);
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
}

export function titleFromPath(p: string): string {
  const name = baseName(p);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

export function isVideoPath(p: string): boolean {
  return VIDEO_EXTS.includes(extOf(p));
}

export function isAudioPath(p: string): boolean {
  return AUDIO_EXTS.includes(extOf(p));
}

export interface OnlineRef {
  kind: 'youtube' | 'vimeo';
  id: string;
  /** 開始位置（秒） */
  start: number;
  /** 正規化した URL */
  url: string;
}

export function parseOnlineUrl(input: string): OnlineRef | null {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.hostname.toLowerCase().replace(/^(www\.|m\.|music\.)/, '');

  if (host === 'youtu.be' || host === 'youtube.com' || host === 'youtube-nocookie.com') {
    let id: string | null | undefined;
    if (host === 'youtu.be') {
      id = u.pathname.split('/')[1];
    } else if (u.pathname === '/watch') {
      id = u.searchParams.get('v');
    } else {
      id = u.pathname.match(/^\/(?:shorts|embed|live|v)\/([^/]+)/)?.[1];
    }
    if (!id || !/^[\w-]{11}$/.test(id)) return null;
    const start = parseTime(u.searchParams.get('t') ?? u.searchParams.get('start'));
    return { kind: 'youtube', id, start, url: `https://www.youtube.com/watch?v=${id}` };
  }

  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    const segments = u.pathname.split('/').filter(Boolean);
    const idIndex = segments.findIndex((s) => /^\d+$/.test(s));
    if (idIndex < 0) return null;
    const id = segments[idIndex];
    // 限定公開の動画は vimeo.com/<id>/<hash> または ?h=<hash> の形になる
    const next = segments[idIndex + 1];
    const hash = u.searchParams.get('h') ?? (next && /^[0-9a-f]+$/i.test(next) ? next : null);
    const start = parseTime(u.hash.match(/t=([\dhms]+)/)?.[1] ?? null);
    return { kind: 'vimeo', id, start, url: `https://vimeo.com/${id}${hash ? `/${hash}` : ''}` };
  }

  return null;
}

/** "90" / "90s" / "1m30s" / "1h2m3s" を秒に変換する */
function parseTime(value: string | null): number {
  if (!value) return 0;
  if (/^\d+$/.test(value)) return Number(value);
  const m = value.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (!m) return 0;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}
