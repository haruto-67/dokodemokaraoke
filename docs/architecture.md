# どこでもカラオケセット 処理の流れとソースコードの構成

2026-10-20 時点(歌詞タイミング付けを発音成分DPに置き換えた後)。仕様の正は `カラオケアプリ 要件定義 v3.md`、
コード中の `§4.4.7` などはその節番号。

## 全体像

Electron アプリ。3つのプロセスに分かれる。

| プロセス | 言語 | 場所 | 役割 |
|---|---|---|---|
| メイン | TypeScript (Node) | `src/main/` | ウインドウ、ファイル読み書き(.dokokara)、ffmpeg/yt-dlp の起動、Python の起動 |
| レンダラ(画面) | TypeScript (ブラウザ) | `src/renderer/` | 全画面のUI、音声再生、編集、本番、採点 |
| Python サイドカー | Python 3.11(同梱) | `python/sidecar/` | 重い音声解析(ボーカル分離・音程・歌詞のタイミング付け) |

`src/shared/` はメインとレンダラの両方から使う型・純粋関数。`src/preload/` はレンダラからメインを呼ぶ窓口(`window.dokokara.*`)。

```
レンダラ ──(IPC: src/shared/ipc.ts)──▶ メイン ──(stdin/stdout の JSON 1行1メッセージ:
   ▲                                    │        src/shared/pythonSidecarProtocol.ts)──▶ Python サイドカー
   └────────── 進捗・結果のイベント ◀────┘◀──────────────── progress / done / error ─────┘
```

## 処理の流れ

### 1. 曲を作る(準備画面 → 解析中画面 → 編集画面)

1. **準備画面** `screens/setupScreen.ts`
   音源ファイル(またはYouTube URL → `main/sourceIngest*.ts` が yt-dlp で取得)と歌詞テキストを受け取り、「解析を開始する」で解析中画面へ。
2. **解析中画面** `screens/analyzingScreen.ts` が `window.dokokara.startAnalysis()` を呼ぶ。
3. **メイン** `main/analysisManager.ts`
   - 一時フォルダを作り、ffmpeg で音源を WAV に変換(`main/mediaTools.ts` の `normalizeAudioToWav`)
   - Python サイドカーを1回の解析ごとに1プロセス起動(`main/pythonSidecar.ts`)し、`analyze` を送る
   - 進捗(`progress`)をそのまま画面へ中継し、`done` で結果を渡す
4. **Python** `python/sidecar/main.py` の `handle_analyze` が順に実行:

   | STEP | 内容 | ファイル | 出力 |
   |---|---|---|---|
   | 2 | ボーカル/伴奏分離(Mel-Band RoFormer) | `separation.py` | vocals.wav / instrumental.wav |
   | 3 | 音程(F0)抽出(RMVPE、10ms刻み) | `rmvpe_model.py` | F0 |
   | 4 | F0 からノート化(Basic Pitch の後処理だけ流用) | `f0_notes.py` | notes、f0.bin(86fps) |
   | 5 | フレーズ区間(Silero VAD)。ガイド線・スナップ用 | `vad.py` | phraseSegments |
   | 6/7 | 歌詞のタイミング付け。歌詞の半分以上が英語なら発音記号の強制アライメント、それ以外は発音成分DP | `phoneme_align.py` / `vowel_align.py`(読みは `lyrics_reading.py`・`english_g2p.py`) | 行・モーラ(英語は単語)ごとの時刻、聞き取った音、アタックの位置 |

5. **解析中画面に戻って** `finishAnalysis` → `buildLyricsLines`
   - 歌詞行をトークン(表示の1文字。ルビ付きは1モーラ=1トークン)に分ける: `shared/tokenize.ts`
   - Python が出したモーラごとの時刻をトークンへそのまま割り当てる: `shared/analysis/allocate.ts` の `timingsFromMorae`
     (モーラが無い行だけ `allocateTokenTimings` で行の中に配分)
   - 伴奏からテンポを推定し(`lib/tempo.ts` の `estimateTempo`)、`project.rhythm` に入れる。テンポが曲の途中でも
     保たれている時だけ(`isTempoSteady`)、文字の開始を近くの拍の格子へ寄せる(`lib/beatQuantize.ts`)
   - `project`(`shared/types.ts` の `DokokaraProject`)を組み立て、編集画面へ。**この時点ではまだ保存されていない**

### 2. 歌詞のタイミング付けの中身(`python/sidecar/vowel_align.py`)

入口は `align_lyrics_lines()`。

1. `compute_features()` — 音響特徴を作る
   - wav2vec2(reazon-research、CTC)の出力を「あいうえお・ん」の確率に集約(`ctc_vowel_probs`。初回のDPだけに使う)
   - 母音分類器の入力(`classifier_features`): MFCC と、wav2vec2 の8層目を120ms後ろへずらして軽く混ぜたもの
   - 音量(相対dB、10ms刻み)。F0 は STEP3 のものを使い回す
2. `align()` — 配置
   - 歌詞 → ひらがな読み → モーラ(`lyrics_to_morae`)。各モーラに「子音(省略可)→母音」の状態。子音のあるモーラの開始は母音の始まり(`starts_at_vowel`)
   - フレームごとの無音確率(F0 の有無+音量、`silence_prob`)、切れ目の手がかり(発音の立ち上がり=アタック・音程の跳躍で新しい高さに着いた所・音量の谷・音程の変わり目・ノート開始、`attack_cue`/`glide_cue`/`boundary_cue`/`note_bonus`)、母音のまま大きく音程が跳ぶ・強いアタックを越えるコスト(`hold_cost`/`attack_hold`)。アタックはボーカルの対数メルスペクトルの立ち上がり量(`attack_strength`)
   - `viterbi()` で歌詞の順序を守ったまま曲全体を一括配置。行の間には「歌詞でない声」の状態がある
   - 配置結果を正解ラベルにして母音分類器(MFCC のロジスティック回帰)を学習 → DP をやり直す、を5回(`labels_from_alignment` / `train_and_predict`)
3. `to_aligned_lines()` — 行ごとの `{start, end, confidence, tokenTimings(モーラごと)}` に整形
4. `heard_sounds()` — フレームごとの聞き取り結果(母音の最尤・無声・無音)を区間にまとめる → 編集画面の帯
5. `attack_marks()` — アタックの位置と強さ → 編集画面の帯の上の縦線

歌詞の中の英単語は `english_g2p.py`(CMU 発音辞書+g2p_en の推定モデル。`sidecar/data/`)で音節に分け、
1音節を1単位にする(母音は近い日本語の母音を複数許す。例: 曖昧母音は「あ・う・お」)。結果は単語ごとにまとめる。

### 2'. 英語が主の曲(`python/sidecar/phoneme_align.py`)

母音5種への置き換えでは英語の決め手にならないため、多言語の音素認識モデル
(facebook/wav2vec2-xlsr-53-espeak-cv-ft を半精度にしたもの)の出力に、歌詞の発音記号(IPA)の並びを
曲全体で CTC の強制アライメントする(`forced_align`)。英単語は `english_g2p.py` の ARPAbet を IPA へ、
日本語はかな読みを IPA へ変換する(`lyrics_units`)。単位(英語は単語、日本語はモーラ)の開始は最初の音素が出るフレームを、
±0.1秒以内のアタックへ寄せたもの(`snap_to_attacks`。行の最初の単位は後ろへだけ)。
聞き取った音の帯には、モデルが聞き取った発音記号をそのまま出す(`heard_phonemes`)。

パラメータは `Params`(ファイル先頭)。調整は `python/experiments/` で行う(下記)。

### 3. 編集する(編集画面)

`screens/editorScreen.ts`(約1900行。画面のほぼ全部)。状態は `state/editorStore.ts`、Undo/Redo は `state/history.ts`。

- タイムライン: 上からピッチの帯(波形・ピッチ線・聞き取った音の帯 = `renderRibbon`)、拍の線(`renderBeatGrid`)、行ブロック(`renderBlocks`)、文字(`renderBoundary`)
- ドラッグ時の吸着: `lib/snap.ts`(フレーズ境界・ノート開始など)、拍への吸着とメトロノーム・テンポ推定: `lib/tempo.ts`
- 「歌詞を拍に合わせる」: `lib/beatQuantize.ts`、「文字の開始/終了をここに」: `lib/playheadTiming.ts`、行の長さ変更: `lib/resizeLine.ts`、「この行を再配分」: `lib/retiming.ts` + `allocate.ts`
- キーボードショートカット: `shared/keybindings.ts`
- 再生: `lib/audio.ts` の `PlaybackEngine`(soundtouchjs でキー変更・速度変更)

### 4. 保存・読み込み

- 画面側: `lib/projectActions.ts`(保存・開く・バックアップ・未保存確認)
- メイン側: `main/ipcHandlers.ts` → `main/projectFile.ts`(.dokokara の読み書き)、`main/projectStore.ts`(一覧・複製・名前変更・削除・自動バックアップ)
- 保存先は `~/Documents/どこでもカラオケセット/`。自動バックアップは同じ場所の `.backups/`
- `.dokokara` は ZIP: `project.json`(歌詞・時刻・ノート・リズム等)、`audio/vocal.wav`(ボーカル)、`audio/off.wav`(伴奏)、`audio/original.*`(元音源)、`f0.bin`

### 5. 歌う(本番画面 → リザルト画面)

- `screens/performScreen.ts`: 歌詞の文字送り・ピッチガイド・カウントイン(`audio/performCues.ts`)
- マイクの音程: `audio/micPitchInput.ts` + `audio/pitchWorkletProcessor.ts`(YIN: `shared/analysis/yin.ts`)
- 採点: `shared/analysis/scoring.ts`、行ごとの内訳: `lib/scoreLines.ts` → `screens/resultScreen.ts`
- 入出力の遅れの補正: `audio/latencyCalibration.ts` / `micClickDetection.ts` / `clickDetectorWorkletProcessor.ts`

## ファイルの構成

### ルート

| パス | 中身 |
|---|---|
| `カラオケアプリ 要件定義 v3.md` | 仕様書(コード中の `§` 番号の元) |
| `package.json` | npm スクリプト(`build:mac` = Python同梱物・ffmpeg・モデルの準備 → ビルド → .app/.dmg) |
| `electron.vite.config.ts` / `tsconfig*.json` / `vitest.config.ts` | ビルド・型・テストの設定 |
| `electron-builder.yml` / `build/` | アプリのパッケージ設定、署名・DMG 後処理、アイコン |
| `scripts/` | `build-python-runtime.mjs`(同梱Python+依存)、`build-media-tools.mjs`(ffmpeg/yt-dlp)、`fetch-models.mjs`(モデル重み)、`run-python-tests.mjs` |
| `resources/` | ビルドで作る同梱物(python-runtime / media-tools / models)。git 管理外 |
| `.github/workflows/ci.yml` | CI |

### `src/main/`(メインプロセス)

| ファイル | 中身 |
|---|---|
| `index.ts` | 起動処理。Finder から .dokokara を開いた時の受け付け |
| `window.ts` / `menu.ts` | ウインドウ生成、アプリのメニュー |
| `ipcHandlers.ts` | 画面からの依頼(保存・開く・一覧等)の受け口 |
| `analysisManager.ts` | 解析の開始・キャンセル。ffmpeg 変換 → Python 起動 → 進捗・結果の中継 |
| `pythonSidecar.ts` | Python 子プロセスとの JSON 1行1メッセージのやり取り |
| `pythonRuntime.ts` | 同梱 Python・スクリプト・モデルのパス |
| `sourceIngest.ts` / `sourceIngestCore.ts` | YouTube URL からの音源取得(yt-dlp) |
| `mediaTools.ts` / `mediaToolsUpdate.ts` | ffmpeg/yt-dlp のパス、WAV 変換、yt-dlp の自己更新 |
| `projectFile.ts` | .dokokara(ZIP)の読み書き |
| `projectStore.ts` | プロジェクト一覧・複製・名前変更・ゴミ箱・自動バックアップ |
| `settings.ts` | アプリ設定(保存先フォルダ等) |
| `logger.ts` / `audioMime.ts` / `env.ts` | 解析ログ、音声の MIME、開発/本番の判定 |

### `src/preload/index.ts`

レンダラに `window.dokokara`(メインの機能を呼ぶ関数群)を公開する。

### `src/renderer/src/`(画面)

| パス | 中身 |
|---|---|
| `main.ts` / `app.ts` / `appContext.ts` | 起動、画面の切り替え(ルーター)、画面間で共有する状態 |
| `screens/homeScreen.ts` | ホーム(プロジェクト一覧) |
| `screens/setupScreen.ts` | 準備(音源・歌詞の入力) |
| `screens/analyzingScreen.ts` | 解析中(進捗表示)と、解析結果からプロジェクトを組み立てる処理 |
| `screens/editorScreen.ts` | 編集画面 |
| `screens/performScreen.ts` | 本番(カラオケ再生) |
| `screens/resultScreen.ts` | 採点結果 |
| `components/` | 設定モーダル、入力ダイアログ、ツールチップ、読み込み中表示 |
| `state/` | 編集画面の状態(`editorStore.ts`)、Undo/Redo(`history.ts`)、小さな pub/sub(`store.ts`) |
| `lib/audio.ts` | 音声のデコードと再生(`PlaybackEngine`) |
| `lib/tempo.ts` | BPM 推定、テンポが一定かの判定、拍の格子、テンポ変更 |
| `lib/beatQuantize.ts` | 文字の開始を拍の格子へ寄せる(解析の最後と「歌詞を拍に合わせる」ボタン) |
| `lib/snap.ts` | ドラッグ時の吸着 |
| `lib/playheadTiming.ts` / `resizeLine.ts` / `retiming.ts` | 文字・行のタイミング編集の純粋関数 |
| `lib/projectActions.ts` | 保存・開く・バックアップの流れ |
| `lib/scoreLines.ts` / `waveform.ts` / `lyrics.ts` / `dom.ts` | 行ごとの採点集計、波形のピーク、歌詞の行分割、DOM 補助 |
| `audio/` | マイク入力(音程・クリック検出)の AudioWorklet、本番の効果音、遅延の補正 |
| `styles/` | 画面ごとの CSS。色などは `tokens.css` |

### `src/shared/`(メイン・画面の共通)

| ファイル | 中身 |
|---|---|
| `types.ts` | `project.json` の型(`DokokaraProject` など) |
| `ipc.ts` | 画面⇔メインの IPC の名前と型 |
| `pythonSidecarProtocol.ts` | メイン⇔Python のメッセージと解析結果の型 |
| `tokenize.ts` / `ruby.ts` | 歌詞のトークン分割・モーラ重み、ルビ記法の解析 |
| `keybindings.ts` | ショートカットの定義 |
| `analysis/allocate.ts` | モーラ時刻→トークンへの割り当て(`timingsFromMorae`)、行内の配分(`allocateTokenTimings`) |
| `analysis/scoring.ts` / `yin.ts` / `tokenPitch.ts` | 採点、リアルタイム音程検出、文字ごとの音程 |

### `python/`

| パス | 中身 |
|---|---|
| `requirements.txt` / `models.json` | 同梱 Python の依存、モデル重みの取得元 |
| `sidecar/main.py` | サイドカーの入口。`analyze` で STEP2〜7 を実行 |
| `sidecar/separation.py` | ボーカル/伴奏分離 |
| `sidecar/rmvpe_model.py` | 音程(F0)抽出モデル |
| `sidecar/f0_notes.py` | F0 → ノート |
| `sidecar/vad.py` | フレーズ区間検出 |
| `sidecar/vowel_align.py` | 歌詞のタイミング付け(発音成分DP)と聞き取った音 |
| `sidecar/phoneme_align.py` | 英語が主の曲の歌詞のタイミング付け(発音記号の強制アライメント) |
| `sidecar/english_g2p.py` / `sidecar/data/` | 英単語→発音記号・音節(CMU 発音辞書、g2p_en の推定モデルとライセンス) |
| `sidecar/lyrics_reading.py` | 歌詞→ひらがな読み、自動ルビ、wav2vec2 の読み込みと語彙 |
| `sidecar/paths.py` | 同梱モデルのパス |
| `sidecar/*_test.py` | テスト(`npm run test:python`) |
| `experiments/vowel_dp_align.py` | `vowel_align.py` を展開済みプロジェクトに対して実行(パラメータ調整用) |
| `experiments/phoneme_ctc_align.py` | `phoneme_align.py` を展開済みプロジェクトに対して実行 |
| `experiments/eval_alignment.py` | 結果を手修正済みの正解プロジェクトと比べて誤差を出す(英語は単語ごと) |
| `experiments/vowel_accuracy.py` | 母音の聞き取り(フレームごと)の正解率を正解プロジェクトで測る |

## テストとビルド

- `npm test`(vitest、`*.test.ts`)、`npm run test:python`(`python/sidecar/*_test.py`)、`npm run typecheck`
- `npm run build:mac` で `release/mac-arm64/` に .app ができる。`python/requirements.txt` を変えると同梱 Python が作り直される
