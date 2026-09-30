// 操作ウィンドウと出力ウィンドウで共通の小さな関数

export function mediaUrl(mediaBase: string, filePath: string): string {
  return `${mediaBase}?p=${encodeURIComponent(filePath)}`;
}

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

export function newId(): string {
  return crypto.randomUUID();
}
