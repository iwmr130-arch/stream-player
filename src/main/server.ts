// 画面（HTML）とローカルのメディアファイルを配信する、127.0.0.1 限定の HTTP サーバー。
// file:// から読み込むと YouTube の埋め込みがリファラーなしで拒否されるため、http で配信している。
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { extOf } from '../shared/media';

const MIME: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  map: 'application/json',
  json: 'application/json',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/mp4', // Chromium は video/quicktime を嫌うため mp4 として渡す
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
};

const CSP = [
  "default-src 'self'",
  "script-src 'self' https://www.youtube.com https://*.ytimg.com",
  'frame-src https://www.youtube.com https://www.youtube-nocookie.com https://player.vimeo.com',
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
].join('; ');

export interface LocalServer {
  origin: string;
  /** `${mediaBase}?p=<絶対パス>` でローカルファイルを取得できる */
  mediaBase: string;
}

export function startServer(appRoot: string): Promise<LocalServer> {
  // 他のアプリやブラウザから任意のファイルを読まれないよう、推測できないトークンを付ける
  const token = crypto.randomBytes(24).toString('hex');
  const mediaPath = `/media/${token}`;
  const root = path.resolve(appRoot);

  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');

    if (url.pathname.startsWith('/app/')) {
      const file = path.resolve(root, decodeURIComponent(url.pathname.slice('/app/'.length)));
      if (!file.startsWith(root + path.sep)) {
        res.writeHead(403).end();
        return;
      }
      const headers: http.OutgoingHttpHeaders = { 'Cache-Control': 'no-store' };
      if (extOf(file) === 'html') headers['Content-Security-Policy'] = CSP;
      await serveFile(req, res, file, headers);
      return;
    }

    if (url.pathname === mediaPath) {
      const file = url.searchParams.get('p');
      if (!file || !path.isAbsolute(file)) {
        res.writeHead(400).end();
        return;
      }
      await serveFile(req, res, file, {});
      return;
    }

    res.writeHead(404).end();
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      const origin = `http://127.0.0.1:${port}`;
      resolve({ origin, mediaBase: `${origin}${mediaPath}` });
    });
  });
}

/** Range リクエスト（動画のシーク）に対応したファイル配信 */
async function serveFile(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  file: string,
  headers: http.OutgoingHttpHeaders,
): Promise<void> {
  let size: number;
  try {
    const stat = await fs.promises.stat(file);
    if (!stat.isFile()) throw new Error('not a file');
    size = stat.size;
  } catch {
    res.writeHead(404).end();
    return;
  }

  const base: http.OutgoingHttpHeaders = {
    ...headers,
    'Content-Type': MIME[extOf(file)] ?? 'application/octet-stream',
    'Accept-Ranges': 'bytes',
  };

  let start = 0;
  let end = size - 1;
  const range = req.headers.range?.match(/^bytes=(\d*)-(\d*)$/);
  if (range && (range[1] || range[2])) {
    if (range[1]) {
      start = Number(range[1]);
      if (range[2]) end = Math.min(Number(range[2]), size - 1);
    } else {
      start = Math.max(0, size - Number(range[2]));
    }
    if (start > end || start >= size) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end();
      return;
    }
    res.writeHead(206, { ...base, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
  } else {
    res.writeHead(200, { ...base, 'Content-Length': size });
  }

  if (req.method === 'HEAD' || size === 0) {
    res.end();
    return;
  }
  const stream = fs.createReadStream(file, { start, end });
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}
