import type { AnalysisStepProgress, DokokaraNote, DokokaraPhrase } from './types'

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
  start: number
  end: number
  /** forced alignの平均対数尤度スコア。フレーズ区間数不足で対応するVAD区間が無かった行は含まれない */
  confidence: number
}

export interface AnalyzeSidecarResult {
  vocalsPath: string
  instrumentalPath: string
  f0Path: string
  notes: DokokaraNote[]
  phraseSegments: DokokaraPhrase[]
  /** 歌詞行の出現順に、対応するVAD区間があった行だけを含む(要件定義書v3 §4.4.7の単純化方針)。
   *  歌詞行数がVAD区間数より多い場合、末尾の行はここに含まれない(呼び出し側でフォールバック処理する)。 */
  lyrics: AnalyzeSidecarLine[]
}

/** サイドカー → メイン(stdout) */
export type SidecarMessage =
  | { type: 'progress'; id: string; progress: AnalysisStepProgress }
  | { type: 'done'; id: string; result: AnalyzeSidecarResult }
  | { type: 'error'; id: string; message: string }
