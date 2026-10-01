// TypeScript を esbuild でまとめて dist/ に出力する。型チェックは `npm run typecheck`（tsc）で別に行う。
import { build } from 'esbuild';
import { cp, rm } from 'node:fs/promises';

await rm('dist', { recursive: true, force: true });

const common = { bundle: true, sourcemap: true, logLevel: 'info' };

await Promise.all([
  build({
    ...common,
    entryPoints: ['src/main/main.ts'],
    outfile: 'dist/main/main.js',
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
  }),
  build({
    ...common,
    entryPoints: ['src/preload/preload.ts'],
    outfile: 'dist/preload/preload.js',
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
  }),
  build({
    ...common,
    entryPoints: {
      'control/control': 'src/renderer/control/control.ts',
      'output/output': 'src/renderer/output/output.ts',
      'browser/browser': 'src/renderer/browser/browser.ts',
    },
    outdir: 'dist/renderer',
    platform: 'browser',
    format: 'iife',
    target: 'chrome130',
  }),
]);

for (const page of ['control', 'output', 'browser']) {
  await cp(`src/renderer/${page}`, `dist/renderer/${page}`, {
    recursive: true,
    filter: (src) => !src.endsWith('.ts'),
  });
}
