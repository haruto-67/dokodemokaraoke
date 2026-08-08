// renderer <-> main 間の contextBridge API 契約
import type { AppSettings, ProjectSummary } from './types'

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
  checkCrashBackup: 'project:checkCrashBackup',
  getSettings: 'settings:get',
  setSettings: 'settings:set',
  getLogs: 'log:get',
  appendLog: 'log:append',
  onOpenFileFromOs: 'app:onOpenFile',
  onMenuAction: 'app:onMenuAction',
  confirmCloseUnsaved: 'app:confirmCloseUnsaved',
  requestClose: 'app:requestClose',
  closeConfirmed: 'app:closeConfirmed'
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
}
