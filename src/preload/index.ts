import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type DokokaraApi, type OpenProjectResult, type SaveProjectPayload } from '@shared/ipc'
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
  closeConfirmed: () => ipcRenderer.send(IPC.closeConfirmed)
}

contextBridge.exposeInMainWorld('dokokara', api)
