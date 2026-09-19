import { randomUUID } from 'node:crypto'
import { ipcMain, type BrowserWindow } from 'electron'
import {
  IPC,
  type AnalysisDoneEvent,
  type AnalysisErrorEvent,
  type AnalysisProgressEvent,
  type AnalysisStartParams,
  type AnalysisStartResult
} from '../shared/ipc'
import { PythonSidecar } from './pythonSidecar'
import { getPythonExecutablePath, getPythonSidecarScriptPath } from './pythonRuntime'

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
    const sidecar = new PythonSidecar(getPythonExecutablePath(), [getPythonSidecarScriptPath()], {
      onProgress: (_id, progress) => {
        const event: AnalysisProgressEvent = { jobId, progress }
        getWindow()?.webContents.send(IPC.onAnalysisProgress, event)
      }
    })
    jobs.set(jobId, { sidecar })
    sidecar.start()

    sidecar
      .request({ id: jobId, method: 'analyze', params })
      .then((result) => {
        const event: AnalysisDoneEvent = { jobId, result }
        getWindow()?.webContents.send(IPC.onAnalysisDone, event)
      })
      .catch((error: Error) => {
        const event: AnalysisErrorEvent = { jobId, message: error.message }
        getWindow()?.webContents.send(IPC.onAnalysisError, event)
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
