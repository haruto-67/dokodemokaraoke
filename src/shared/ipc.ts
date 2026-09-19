// renderer <-> main 間の contextBridge API 契約
import type { AnalysisStepProgress, AppSettings, ProjectSummary } from './types'

export const IPC = {
  listProjects: 'project:list',
  openProject: 'project:open',
  openProjectDialog: 'project:openDialog',
  newProjectDialog: 'project:newDialogPickAudio',
  saveProject: 'project:save',
  saveProjectAs: 'project:saveAs',
  backupProject: 'project:backup',
  duplicateProject: 'project:duplicate',
  renameProject: 'project:rename',
  trashProject: 'project:trash',
  pickAudioFile: 'audio:pickFile',
  readFileBuffer: 'file:readBuffer',
  readTextFile: 'file:readText',
  pickTextFile: 'file:pickText',
  pickDirectory: 'dir:pick',
  checkCrashBackup: 'project:checkCrashBackup',
  getSettings: 'settings:get',
  setSettings: 'settings:set',
  getLogs: 'log:get',
  appendLog: 'log:append',
  onOpenFileFromOs: 'app:onOpenFile',
  onMenuAction: 'app:onMenuAction',
  confirmCloseUnsaved: 'app:confirmCloseUnsaved',
  requestClose: 'app:requestClose',
  closeConfirmed: 'app:closeConfirmed',
  // Pythonサイドカーでの解析実行(§4.4/§8.2)。1曲5〜10分かかるため、
  // startは即座にjobIdを返し、進捗/完了/失敗はイベントで別途通知する。
  startAnalysis: 'analysis:start',
  cancelAnalysis: 'analysis:cancel',
  onAnalysisProgress: 'analysis:progress',
  onAnalysisDone: 'analysis:done',
  onAnalysisError: 'analysis:error'
} as const

export interface OpenProjectResult {
  filePath: string
  json: unknown
  audio: {
    analysis: { path: string; data: ArrayBuffer; mime: string } | null
    playback: { path: string; data: ArrayBuffer; mime: string } | null
  }
  pitchBin: ArrayBuffer | null
  onsetsBin: ArrayBuffer | null
  brokenParts: string[]
}

export interface SaveProjectPayload {
  filePath: string | null
  json: unknown
  pitchBin: ArrayBuffer | null
  onsetsBin: ArrayBuffer | null
  audio: {
    analysis: { sourcePath: string; ext: string } | null
    playback: { sourcePath: string; ext: string } | null
  }
}

export interface AnalysisStartParams {
  sourceAudioPath: string
  lyricsLines: string[]
  totalDurationSec: number
}

export interface AnalysisStartResult {
  jobId: string
}

export interface AnalysisProgressEvent {
  jobId: string
  progress: AnalysisStepProgress
}

export interface AnalysisDoneEvent {
  jobId: string
  result: unknown
}

export interface AnalysisErrorEvent {
  jobId: string
  message: string
}

export interface DokokaraApi {
  listProjects(): Promise<ProjectSummary[]>
  openProjectDialog(): Promise<OpenProjectResult | null>
  openProjectPath(filePath: string): Promise<OpenProjectResult | null>
  saveProject(payload: SaveProjectPayload): Promise<{ filePath: string }>
  saveProjectAs(payload: SaveProjectPayload, suggestedName: string): Promise<{ filePath: string } | null>
  backupProject(payload: SaveProjectPayload): Promise<void>
  duplicateProject(filePath: string): Promise<void>
  renameProject(filePath: string, newName: string): Promise<{ filePath: string }>
  trashProject(filePath: string): Promise<void>
  pickAudioFile(): Promise<{ path: string; name: string; ext: string; data: ArrayBuffer } | null>
  readFileBuffer(filePath: string): Promise<ArrayBuffer>
  readTextFile(filePath: string): Promise<string>
  pickTextFile(): Promise<string | null>
  pickDirectory(): Promise<string | null>
  getSettings(): Promise<AppSettings>
  setSettings(settings: Partial<AppSettings>): Promise<AppSettings>
  getLogs(): Promise<string[]>
  appendLog(step: string, durationMs: number, result: string): Promise<void>
  onOpenFileFromOs(cb: (filePath: string) => void): () => void
  onMenuAction(cb: (action: string) => void): () => void
  confirmCloseUnsaved(): Promise<'save' | 'discard' | 'cancel'>
  checkForCrashBackup(): Promise<{ filePath: string; backupPath: string } | null>
  onRequestClose(cb: () => void): () => void
  closeConfirmed(): void
  startAnalysis(params: AnalysisStartParams): Promise<AnalysisStartResult>
  cancelAnalysis(jobId: string): Promise<void>
  onAnalysisProgress(cb: (event: AnalysisProgressEvent) => void): () => void
  onAnalysisDone(cb: (event: AnalysisDoneEvent) => void): () => void
  onAnalysisError(cb: (event: AnalysisErrorEvent) => void): () => void
}
