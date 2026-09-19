import { randomUUID } from 'node:crypto'
import { ipcMain, type BrowserWindow } from 'electron'
import {
  IPC,
  type SourceIngestDoneEvent,
  type SourceIngestErrorEvent,
  type SourceIngestProgressEvent,
  type SourceIngestStartParams,
  type SourceIngestStartResult
} from '../shared/ipc'
import { getFfmpegPath, getYtDlpPath } from './mediaTools'
import { runYtDlpUpdate } from './mediaToolsUpdate'
import { runSourceIngest, SourceIngestToolError, type RunningIngest } from './sourceIngestCore'

/**
 * YouTube URLからの音源取り込みの新しいIPC(進捗ストリーム・キャンセル付き)。
 * レンダラ⇔メインはこの層、実際のyt-dlp/ffmpeg起動は `sourceIngestCore.ts` の層と、
 * `analysisManager.ts`/`pythonSidecar.ts` と同じ責務分割にしている。
 */
export function registerSourceIngestHandlers(getWindow: () => BrowserWindow | null): void {
  const jobs = new Map<string, RunningIngest>()

  ipcMain.handle(IPC.startSourceIngest, async (_e, params: SourceIngestStartParams): Promise<SourceIngestStartResult> => {
    const jobId = randomUUID()

    const job = runSourceIngest(
      params.url,
      { ytDlpPath: getYtDlpPath(), ffmpegPath: getFfmpegPath() },
      (stage, progress, detail) => {
        const event: SourceIngestProgressEvent = { jobId, stage, progress, detail }
        getWindow()?.webContents.send(IPC.onSourceIngestProgress, event)
      }
    )
    jobs.set(jobId, job)

    job.result
      .then((r) => {
        const event: SourceIngestDoneEvent = { jobId, path: r.path, fileName: r.fileName, ext: r.ext }
        getWindow()?.webContents.send(IPC.onSourceIngestDone, event)
      })
      .catch((err: Error) => {
        const { message, kind } = err instanceof SourceIngestToolError ? err : { message: err.message, kind: 'unknown' as const }
        const event: SourceIngestErrorEvent = { jobId, message, kind }
        getWindow()?.webContents.send(IPC.onSourceIngestError, event)
      })
      .finally(() => jobs.delete(jobId))

    return { jobId }
  })

  ipcMain.handle(IPC.cancelSourceIngest, async (_e, jobId: string) => {
    jobs.get(jobId)?.cancel()
  })

  ipcMain.handle(IPC.updateYtDlp, async () => runYtDlpUpdate(getYtDlpPath()))
}
