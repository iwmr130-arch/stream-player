// プレイリスト・設定・ウィンドウ位置を userData フォルダの JSON に保存する
import fs from 'node:fs';
import path from 'node:path';
import type { Rectangle } from 'electron';
import type { AppState } from '../shared/types';
import { normalizeState } from './normalize';

export interface WindowState {
  control?: Rectangle;
  output?: Rectangle;
}

/** 書き込みをまとめて行うための JSON ファイル */
class JsonFile<T> {
  private timer: NodeJS.Timeout | null = null;
  private dirty = false;

  constructor(
    private readonly file: string,
    public value: T,
  ) {}

  static read(file: string): unknown {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  }

  set(value: T): void {
    this.value = value;
    this.dirty = true;
    this.timer ??= setTimeout(() => this.flush(), 300);
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.dirty) return;
    this.dirty = false;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      // 書き込み途中で落ちても壊れないよう、一時ファイルに書いてから置き換える
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.value, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error('保存に失敗しました', this.file, err);
    }
  }
}

export class Store {
  private readonly state: JsonFile<AppState>;
  private readonly windows: JsonFile<WindowState>;

  constructor(dir: string) {
    const statePath = path.join(dir, 'state.json');
    const windowPath = path.join(dir, 'window-state.json');
    this.state = new JsonFile(statePath, normalizeState(JsonFile.read(statePath)));
    const win = JsonFile.read(windowPath);
    this.windows = new JsonFile(windowPath, (typeof win === 'object' && win !== null ? win : {}) as WindowState);
  }

  getState(): AppState {
    return this.state.value;
  }

  setState(state: unknown): void {
    this.state.set(normalizeState(state));
  }

  getWindowState(): WindowState {
    return this.windows.value;
  }

  setWindowBounds(key: keyof WindowState, bounds: Rectangle): void {
    this.windows.set({ ...this.windows.value, [key]: bounds });
  }

  flush(): void {
    this.state.flush();
    this.windows.flush();
  }
}
