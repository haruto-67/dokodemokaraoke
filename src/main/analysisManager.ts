import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ipcMain, type BrowserWindow } from 'electron'
import {
  IPC,
  type AnalysisDoneEvent,
  type AnalysisErrorEvent,
  type AnalysisProgressEvent,
  type AnalysisStartParams,
  type AnalysisStartResult
} from '../shared/ipc'
import type { AnalyzeSidecarResult } from '../shared/pythonSidecarProtocol'
import { PythonSidecar } from './pythonSidecar'
import { getModelsDir, getPythonExecutablePath, getPythonSidecarScriptPath } from './pythonRuntime'

/**
 * サイドカーに渡す環境変数。ライブラリ既定のキャッシュ(~/.cache/huggingface等)や
 * Hugging Face Hubへの問い合わせを一切行わせず、同梱パスのみを参照させる
 * (§5 オフライン動作要件)。
 */
function buildSidecarEnv(): Record<string, string> {
  return {
    DOKOKARA_MODELS_DIR: getModelsDir(),
    HF_HUB_OFFLINE: '1',
    TRANSFORMERS_OFFLINE: '1',
    HF_HUB_DISABLE_TELEMETRY: '1'
  }
}

interface Job {
  sidecar: PythonSidecar
}

const jobs = new Map<string, Job>()

/**
 * 解析実行の新しいIPC(進捗ストリーム・キャンセル付き)。
 * レンダラ⇔メインはこの層、メイン⇔Pythonサイドカーは `pythonSidecar.ts` の層と、
 * 責務を分けている(§8.2)。
 *
 * 1リクエスト = 1 Pythonサイドカープロセス。ジョブごとに起動し、終了時に必ず
 * プロセスを終了させてjobsから取り除く(取りこぼすとゾンビプロセスが残るため)。
 */
export function registerAnalysisHandlers(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle(IPC.startAnalysis, async (_e, params: AnalysisStartParams): Promise<AnalysisStartResult> => {
    const jobId = randomUUID()
    const workDir = await mkdtemp(join(tmpdir(), 'dokokara-analysis-'))
    const sidecar = new PythonSidecar(getPythonExecutablePath(), [getPythonSidecarScriptPath()], {
      env: buildSidecarEnv(),
      onProgress: (_id, progress) => {
        const event: AnalysisProgressEvent = { jobId, progress }
        getWindow()?.webContents.send(IPC.onAnalysisProgress, event)
      }
    })
    jobs.set(jobId, { sidecar })
    sidecar.start()

    sidecar
      .request({ id: jobId, method: 'analyze', params: { ...params, workDir } })
      .then((result) => {
        const event: AnalysisDoneEvent = { jobId, result: result as AnalyzeSidecarResult }
        getWindow()?.webContents.send(IPC.onAnalysisDone, event)
      })
      .catch((error: Error) => {
        const event: AnalysisErrorEvent = { jobId, message: error.message }
        getWindow()?.webContents.send(IPC.onAnalysisError, event)
        // 失敗時は中間生成物ごと掃除する。成功時はvocals/instrumental等を
        // 後続処理(プロジェクト保存時のコピー等)が参照するためworkDirを残す
        // (sourceIngestCore.tsの「成功時は消さない」方針と同じ理由)。
        void rm(workDir, { recursive: true, force: true })
      })
      .finally(() => {
        sidecar.stop()
        jobs.delete(jobId)
      })

    return { jobId }
  })

  ipcMain.handle(IPC.cancelAnalysis, async (_e, jobId: string) => {
    const job = jobs.get(jobId)
    if (!job) return
    // cancelの要求自体はfire-and-forget。実際の中断確認は、サイドカーが送ってくる
    // 元リクエスト(id=jobId)へのerror応答をpromiseチェーン側が拾って行う。
    job.sidecar.cancel(jobId)
  })
}
