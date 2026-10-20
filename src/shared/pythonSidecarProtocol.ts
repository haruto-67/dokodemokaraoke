import type { AnalysisStepProgress, DokokaraHeardSound, DokokaraNote, DokokaraPhrase } from './types'

/**
 * メインプロセス ⇔ Pythonサイドカー間の通信プロトコル(§8.2)。
 * stdio越しのJSON-RPC風メッセージを改行区切り(1行1メッセージ)でやり取りする。
 *
 * レンダラ⇔メイン間のIPC(`src/shared/ipc.ts`)とは別レイヤーであることに注意。
 * こちらはメインプロセスが子プロセスとして起動したPythonと直接話す経路。
 */

export interface AnalyzeParams {
  sourceAudioPath: string
  lyricsLines: string[]
  totalDurationSec: number
  /** STEP2以降の中間生成物(vocals/instrumental等)を書き出す作業ディレクトリ。呼び出し側(analysisManager.ts)がジョブごとに用意する */
  workDir: string
}

/** メイン → サイドカー(stdin) */
export type SidecarRequest =
  | { id: string; method: 'analyze'; params: AnalyzeParams }
  | { id: string; method: 'cancel'; params: { targetId: string } }

/** `analyze`成功時にサイドカーが返す解析結果(python/sidecar/main.pyの`result`と対応)。 */
export interface AnalyzeSidecarLine {
  text: string
  /** pyopenjtalkの形態素読みで漢字へ自動ルビを付けた歌詞。明示ルビは常に優先する。 */
  annotatedText?: string
  start: number
  end: number
  /** 行の各モーラの母音部分で、歌詞の母音が聞き取れた確率の平均(0..1)。低い行は配置に自信が無い */
  confidence: number
  /** モーラ(拗音は2文字で1つ)ごとの時刻。モーラの間の無音はすき間として空く。表示文字へはtimingsFromMoraeで割り当てる */
  tokenTimings?: Array<{ reading: string; start: number; end: number }>
}

export interface AnalyzeSidecarResult {
  vocalsPath: string
  instrumentalPath: string
  f0Path: string
  notes: DokokaraNote[]
  /** Silero VADで検出したフレーズ区間。歌詞タイミング付け自体には使わず、
   *  編集画面のガイド線・スナップ対象としてのみ使う(§4.4.5)。 */
  phraseSegments: DokokaraPhrase[]
  /**
   * 歌詞行リスト全体を曲全体のvocals音声に一括で配置した結果(python/sidecar/vowel_align.py、
   * 要件定義書v3 §4.4.7)。lyricsLinesと同じ長さ・同じ順序で1行1エントリ、欠落は起きない。
   */
  lyrics: AnalyzeSidecarLine[]
  /** 聞き取った音(母音・ん・無声)の区間。編集画面のタイムラインに表示する */
  heardSounds?: DokokaraHeardSound[]
}

/** サイドカー → メイン(stdout) */
export type SidecarMessage =
  | { type: 'progress'; id: string; progress: AnalysisStepProgress }
  | { type: 'done'; id: string; result: AnalyzeSidecarResult }
  | { type: 'error'; id: string; message: string }
