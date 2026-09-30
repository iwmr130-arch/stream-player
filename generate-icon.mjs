#!/usr/bin/env node
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';

const iconDir = 'assets';
if (!fs.existsSync(iconDir)) fs.mkdirSync(iconDir);

// シンプルなアイコン: 再生ボタン + 音波
const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg viewBox="0 0 256 256" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#4F8CFF;stop-opacity:1" />
      <stop offset="100%" style="stop-color:#2563EB;stop-opacity:1" />
    </linearGradient>
  </defs>
  <!-- 背景 -->
  <rect width="256" height="256" fill="url(#grad)"/>

  <!-- 再生ボタン（三角形） -->
  <polygon points="95,70 95,186 155,128" fill="white" opacity="0.95"/>

  <!-- 音波1 -->
  <path d="M 170 110 Q 180 100 190 110" stroke="white" stroke-width="8" fill="none" stroke-linecap="round" opacity="0.9"/>

  <!-- 音波2 -->
  <path d="M 180 95 Q 195 75 210 95" stroke="white" stroke-width="7" fill="none" stroke-linecap="round" opacity="0.75"/>

  <!-- 音波3 -->
  <path d="M 170 146 Q 180 156 190 146" stroke="white" stroke-width="8" fill="none" stroke-linecap="round" opacity="0.9"/>

  <!-- 音波4 -->
  <path d="M 180 161 Q 195 181 210 161" stroke="white" stroke-width="7" fill="none" stroke-linecap="round" opacity="0.75"/>
</svg>`;

const buffer = Buffer.from(svg);

// 複数サイズの PNG を生成
const sizes = [512, 256, 128, 64];
for (const size of sizes) {
  sharp(buffer)
    .resize(size, size)
    .png()
    .toFile(path.join(iconDir, `icon-${size}x${size}.png`))
    .then(() => console.log(`✓ Generated ${size}x${size} icon`))
    .catch((err) => console.error(`✗ Failed to generate ${size}x${size}:`, err.message));
}

// 512x512 を icon.png としても保存（Electron 用）
sharp(buffer)
  .resize(512, 512)
  .png()
  .toFile(path.join(iconDir, 'icon.png'))
  .then(() => console.log('✓ Generated icon.png'))
  .catch((err) => console.error('✗ Failed to generate icon.png:', err.message));
