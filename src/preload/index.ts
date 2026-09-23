import { contextBridge, ipcRenderer, webUtils } from 'electron'
import {
  IPC,
  type AnalysisDoneEvent,
  type AnalysisErrorEvent,
  type AnalysisProgressEvent,
  type AnalysisStartParams,
  type DokokaraApi,
  type OpenProjectResult,
  type SaveProjectPayload,
  type SourceIngestDoneEvent,
  type SourceIngestErrorEvent,
  type SourceIngestProgressEvent,
  type SourceIngestStartParams
} from '@shared/ipc'
import type { AppSettings } from '@shared/types'

const api: DokokaraApi = {
  listProjects: () => ipcRenderer.invoke(IPC.listProjects),
  openProjectDialog: () => ipcRenderer.invoke(IPC.openProjectDialog),
  openProjectPath: (filePath: string): Promise<OpenProjectResult | null> =>
    ipcRenderer.invoke(IPC.openProject, filePath),
  saveProject: (payload: SaveProjectPayload) => ipcRenderer.invoke(IPC.saveProject, payload),
  saveProjectAs: (payload: SaveProjectPayload, suggestedName: string) =>
    ipcRenderer.invoke(IPC.saveProjectAs, payload, suggestedName),
  backupProject: (payload: SaveProjectPayload) => ipcRenderer.invoke(IPC.backupProject, payload),
  duplicateProject: (filePath: string) => ipcRenderer.invoke(IPC.duplicateProject, filePath),
  renameProject: (filePath: string, newName: string) => ipcRenderer.invoke(IPC.renameProject, filePath, newName),
  trashProject: (filePath: string) => ipcRenderer.invoke(IPC.trashProject, filePath),
  pickAudioFile: () => ipcRenderer.invoke(IPC.pickAudioFile),
  // Electron 32でFile.pathが廃止されたため、ドラッグ&ドロップされたFileから実パスを
  // 取得するにはwebUtils.getPathForFile()が必須(古いコードのfile.pathフォールバックは
  // 常にundefinedになりfile.nameだけが使われてしまう不具合があった)。
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  readFileBuffer: (filePath: string) => ipcRenderer.invoke(IPC.readFileBuffer, filePath),
  readTextFile: (filePath: string) => ipcRenderer.invoke(IPC.readTextFile, filePath),
  pickTextFile: () => ipcRenderer.invoke(IPC.pickTextFile),
  pickDirectory: () => ipcRenderer.invoke(IPC.pickDirectory),
  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke(IPC.getSettings),
  setSettings: (settings: Partial<AppSettings>) => ipcRenderer.invoke(IPC.setSettings, settings),
  getLogs: () => ipcRenderer.invoke(IPC.getLogs),
  appendLog: (step: string, durationMs: number, result: string) =>
    ipcRenderer.invoke(IPC.appendLog, step, durationMs, result),
  onOpenFileFromOs: (cb: (filePath: string) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, filePath: string): void => cb(filePath)
    ipcRenderer.on('app:openFile', listener)
    return () => ipcRenderer.removeListener('app:openFile', listener)
  },
  onMenuAction: (cb: (action: string) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, action: string): void => cb(action)
    ipcRenderer.on('app:menuAction', listener)
    return () => ipcRenderer.removeListener('app:menuAction', listener)
  },
  confirmCloseUnsaved: () => ipcRenderer.invoke(IPC.confirmCloseUnsaved),
  checkForCrashBackup: () => ipcRenderer.invoke(IPC.checkCrashBackup),
  onRequestClose: (cb: () => void) => {
    const listener = (): void => cb()
    ipcRenderer.on(IPC.requestClose, listener)
    return () => ipcRenderer.removeListener(IPC.requestClose, listener)
  },
  closeConfirmed: () => ipcRenderer.send(IPC.closeConfirmed),
  startAnalysis: (params: AnalysisStartParams) => ipcRenderer.invoke(IPC.startAnalysis, params),
  cancelAnalysis: (jobId: string) => ipcRenderer.invoke(IPC.cancelAnalysis, jobId),
  onAnalysisProgress: (cb: (event: AnalysisProgressEvent) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, event: AnalysisProgressEvent): void => cb(event)
    ipcRenderer.on(IPC.onAnalysisProgress, listener)
    return () => ipcRenderer.removeListener(IPC.onAnalysisProgress, listener)
  },
  onAnalysisDone: (cb: (event: AnalysisDoneEvent) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, event: AnalysisDoneEvent): void => cb(event)
    ipcRenderer.on(IPC.onAnalysisDone, listener)
    return () => ipcRenderer.removeListener(IPC.onAnalysisDone, listener)
  },
  onAnalysisError: (cb: (event: AnalysisErrorEvent) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, event: AnalysisErrorEvent): void => cb(event)
    ipcRenderer.on(IPC.onAnalysisError, listener)
    return () => ipcRenderer.removeListener(IPC.onAnalysisError, listener)
  },
  startSourceIngest: (params: SourceIngestStartParams) => ipcRenderer.invoke(IPC.startSourceIngest, params),
  cancelSourceIngest: (jobId: string) => ipcRenderer.invoke(IPC.cancelSourceIngest, jobId),
  onSourceIngestProgress: (cb: (event: SourceIngestProgressEvent) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, event: SourceIngestProgressEvent): void => cb(event)
    ipcRenderer.on(IPC.onSourceIngestProgress, listener)
    return () => ipcRenderer.removeListener(IPC.onSourceIngestProgress, listener)
  },
  onSourceIngestDone: (cb: (event: SourceIngestDoneEvent) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, event: SourceIngestDoneEvent): void => cb(event)
    ipcRenderer.on(IPC.onSourceIngestDone, listener)
    return () => ipcRenderer.removeListener(IPC.onSourceIngestDone, listener)
  },
  onSourceIngestError: (cb: (event: SourceIngestErrorEvent) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, event: SourceIngestErrorEvent): void => cb(event)
    ipcRenderer.on(IPC.onSourceIngestError, listener)
    return () => ipcRenderer.removeListener(IPC.onSourceIngestError, listener)
  },
  updateYtDlp: () => ipcRenderer.invoke(IPC.updateYtDlp)
}

contextBridge.exposeInMainWorld('dokokara', api)
