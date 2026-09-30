# AGENTS.md

配信・画面共有向けの動画／音声プレイヤー（Electron + TypeScript）。仕様は `REQUIREMENTS.md`、使い方は `README.md` を参照。
ユーザーとのやり取りは日本語で行う。

## コマンド

- `npm install`: 依存パッケージを入れる
- `npm run typecheck`: 型チェック（tsc、出力なし）
- `npm run build`: esbuild で `dist/` にビルドする
- `npm start`: ビルドして起動する
- `npm run dist:win` / `npm run dist:mac`: 配布用パッケージを `release/` に作る

自動テストはまだない。動作確認は、アプリを起動して手で行う。

## 構成

- `src/main/main.ts`: 操作ウィンドウと出力ウィンドウを作り、IPC を中継する。出力の全画面／ウィンドウ切り替え、プレビュー（`capturePage` を 500ms ごとに実行）、ダイアログ、oEmbed でのタイトル取得を担当
- `src/main/server.ts`: `127.0.0.1` のランダムなポートで動く HTTP サーバー。`/app/*` で画面を、`/media/<token>?p=<絶対パス>` でローカルファイルを（Range 対応で）返す
- `src/main/store.ts`, `normalize.ts`: userData 内の `state.json` と `window-state.json` に保存する。読み込んだ値は `normalizeState` で検証する
- `src/preload/preload.ts`: `window.api`。両方のウィンドウで共通
- `src/renderer/control/`: 操作ウィンドウ。`control.ts` はプレイリストと UI、`bgm.ts` は BGM の再生（フェード・ダッキング・ループ）
- `src/renderer/output/`: 出力ウィンドウ。`players.ts` に LocalPlayer / YouTubePlayer / VimeoPlayer がある
- `src/shared/`: 共通の型（`types.ts`）と、URL・拡張子の処理（`media.ts`）

データの流れ: 操作ウィンドウ →（`output:command`）→ main → 出力ウィンドウ。出力ウィンドウ →（`output:status`）→ main → 操作ウィンドウ。
メインの「終了後」の動作のうち、ループは出力側で処理する。停止と次へは、`ended` を受けた操作側で処理する。

## 手動テストの観点

- ローカル: mp4 / webm / mov / mkv / mp3 / wav / m4a / flac / ogg の再生、シーク（Range 対応の確認）、音声ファイルのときに待機画面が出ること
- YouTube: 通常の URL、youtu.be、Shorts、`t=` 付きの URL。埋め込み禁止の動画でエラーが出ること（出力画面には出ず、操作画面にトーストで出る）
- Vimeo: 公開動画、限定公開の URL（`vimeo.com/<id>/<hash>`）
- 終了後の動作: 停止／次へ／ループ。再生中に変更したときの反映
- BGM: 全体ループ、1 曲ループ、シャッフル、フェードでの再生と一時停止、再生できないファイルが混ざっていても止まらずに次へ進むこと
- ダッキング: 音量を下げる／一時停止する／何もしない。メインが終わると BGM が戻ること。設定を途中で変えたとき
- 出力: ウィンドウモード（ドラッグで移動、16:9 のままサイズ変更）、全画面モード（表示先の切り替え、カーソル非表示）、出力ウィンドウを閉じて「出力ウィンドウを表示」で戻せること、ディスプレイを外したときにウィンドウモードに戻ること
- 保存: 再起動後にプレイリスト・音量・ウィンドウ位置が戻ること。エクスポート／インポート、見つからないファイルをフォルダから探す機能
- ショートカット: Space / Esc / Ctrl(⌘)+矢印 / B。URL 入力欄にフォーカスがあるときは効かないこと
- パッケージ: `npm run dist:win` のインストーラー版とポータブル版が起動すること。Mac 版は GitHub Actions の Build ワークフローの Artifacts で確認する
