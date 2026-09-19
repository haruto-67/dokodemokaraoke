import type { AnalysisStepProgress } from './types'

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
}

/** メイン → サイドカー(stdin) */
export type SidecarRequest =
  | { id: string; method: 'analyze'; params: AnalyzeParams }
  | { id: string; method: 'cancel'; params: { targetId: string } }

/**
 * サイドカー → メイン(stdout)。
 * `analysisWorkerProtocol.ts` の progress/done/error という形をそのまま踏襲する。
 * `result` の詳細な型は、解析パイプライン各STEPの実装が固まってから定義する
 * (現段階では通信の枠組みだけを確定させる)。
 */
export type SidecarMessage =
  | { type: 'progress'; id: string; progress: AnalysisStepProgress }
  | { type: 'done'; id: string; result: unknown }
  | { type: 'error'; id: string; message: string }
