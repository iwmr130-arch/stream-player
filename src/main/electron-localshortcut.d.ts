declare module 'electron-localshortcut' {
  import type { BrowserWindow } from 'electron';

  export function register(
    window: BrowserWindow,
    accelerators: string | string[],
    callback: (e: { key: string }) => void,
  ): void;

  export function unregisterAll(window: BrowserWindow): void;

  export default {
    register,
    unregisterAll,
  };
}
