import { ipcMain, dialog, type BrowserWindow } from 'electron'
import { extname, basename } from 'node:path'
import { readFile } from 'node:fs/promises'
import { IPC, type OpenProjectResult, type SaveProjectPayload } from '@shared/ipc'
import type { DokokaraProject } from '@shared/types'
import { loadDokokaraFile, saveDokokaraFile } from './projectFile'
import {
  listProjectSummaries,
  resolveNewProjectPath,
  duplicateProjectFile,
  renameProjectFile,
  trashProjectFile,
  findNewerBackup,
  resolveBackupPath
} from './projectStore'
import { loadSettings, saveSettings } from './settings'
import { appendPipelineLog, readPipelineLogs } from './logger'
import { mimeForExt, SUPPORTED_AUDIO_EXTENSIONS } from './audioMime'

async function toOpenResult(filePath: string): Promise<OpenProjectResult> {
  const loaded = await loadDokokaraFile(filePath)
  return {
    filePath,
    json: loaded.json,
    audio: {
      analysis: loaded.analysisAudio
        ? {
            path: loaded.analysisAudio.path,
            data: bufferToArrayBuffer(loaded.analysisAudio.data),
            mime: mimeForExt(extname(loaded.analysisAudio.path))
          }
        : null,
      playback: loaded.playbackAudio
        ? {
            path: loaded.playbackAudio.path,
            data: bufferToArrayBuffer(loaded.playbackAudio.data),
            mime: mimeForExt(extname(loaded.playbackAudio.path))
          }
        : null
    },
    pitchBin: loaded.pitchBin ? bufferToArrayBuffer(loaded.pitchBin) : null,
    onsetsBin: loaded.onsetsBin ? bufferToArrayBuffer(loaded.onsetsBin) : null,
    brokenParts: loaded.brokenParts
  }
}

function bufferToArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
}

async function persist(payload: SaveProjectPayload, filePath: string): Promise<void> {
  const json = payload.json as DokokaraProject
  const analysisAudio = payload.audio.analysis
    ? { path: `audio/vocal${payload.audio.analysis.ext}`, data: await readFile(payload.audio.analysis.sourcePath) }
    : null
  const playbackAudio = payload.audio.playback
    ? { path: `audio/off${payload.audio.playback.ext}`, data: await readFile(payload.audio.playback.sourcePath) }
    : null

  await saveDokokaraFile(filePath, {
    json,
    pitchBin: payload.pitchBin ? Buffer.from(payload.pitchBin) : null,
    onsetsBin: payload.onsetsBin ? Buffer.from(payload.onsetsBin) : null,
    analysisAudio,
    playbackAudio
  })
}

export function registerIpcHandlers(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle(IPC.listProjects, async () => listProjectSummaries())

  ipcMain.handle(IPC.openProjectDialog, async () => {
    const win = getWindow()
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: [{ name: 'どこでもカラオケセット プロジェクト', extensions: ['dokokara'] }]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return toOpenResult(result.filePaths[0])
  })

  ipcMain.handle(IPC.openProject, async (_e, filePath: string) => toOpenResult(filePath))

  ipcMain.handle(IPC.saveProject, async (_e, payload: SaveProjectPayload) => {
    let filePath = payload.filePath
    if (!filePath) {
      const json = payload.json as DokokaraProject
      filePath = await resolveNewProjectPath(json.name || '無題のプロジェクト')
    }
    await persist(payload, filePath)
    return { filePath }
  })

  ipcMain.handle(IPC.saveProjectAs, async (_e, payload: SaveProjectPayload, suggestedName: string) => {
    const win = getWindow()
    if (!win) return null
    const settings = await loadSettings()
    const result = await dialog.showSaveDialog(win, {
      defaultPath: `${settings.projectsDir}/${suggestedName}.dokokara`,
      filters: [{ name: 'どこでもカラオケセット プロジェクト', extensions: ['dokokara'] }]
    })
    if (result.canceled || !result.filePath) return null
    await persist(payload, result.filePath)
    return { filePath: result.filePath }
  })

  ipcMain.handle(IPC.backupProject, async (_e, payload: SaveProjectPayload) => {
    const json = payload.json as DokokaraProject
    const backupPath = await resolveBackupPath(json.name || '無題のプロジェクト')
    await persist(payload, backupPath)
  })

  ipcMain.handle(IPC.duplicateProject, async (_e, filePath: string) => {
    await duplicateProjectFile(filePath)
  })

  ipcMain.handle(IPC.renameProject, async (_e, filePath: string, newName: string) => {
    const newPath = await renameProjectFile(filePath, newName)
    return { filePath: newPath }
  })

  ipcMain.handle(IPC.trashProject, async (_e, filePath: string) => {
    await trashProjectFile(filePath)
  })

  ipcMain.handle(IPC.pickAudioFile, async () => {
    const win = getWindow()
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: [{ name: '音源ファイル', extensions: SUPPORTED_AUDIO_EXTENSIONS }]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const path = result.filePaths[0]
    const data = await readFile(path)
    return {
      path,
      name: basename(path),
      ext: extname(path),
      data: bufferToArrayBuffer(data)
    }
  })

  ipcMain.handle(IPC.readFileBuffer, async (_e, filePath: string) => {
    const data = await readFile(filePath)
    return bufferToArrayBuffer(data)
  })

  ipcMain.handle(IPC.readTextFile, async (_e, filePath: string) => readFile(filePath, 'utf-8'))

  ipcMain.handle(IPC.pickTextFile, async () => {
    const win = getWindow()
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: [{ name: 'テキストファイル', extensions: ['txt'] }]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return readFile(result.filePaths[0], 'utf-8')
  })

  ipcMain.handle(IPC.pickDirectory, async () => {
    const win = getWindow()
    if (!win) return null
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle(IPC.getSettings, async () => loadSettings())
  ipcMain.handle(IPC.setSettings, async (_e, partial) => saveSettings(partial))

  ipcMain.handle(IPC.getLogs, async () => readPipelineLogs())
  ipcMain.handle(IPC.appendLog, async (_e, step: string, durationMs: number, result: string) =>
    appendPipelineLog(step, durationMs, result)
  )

  ipcMain.handle(IPC.checkCrashBackup, async () => {
    const summaries = await listProjectSummaries()
    for (const s of summaries) {
      const backupPath = await findNewerBackup(s.filePath)
      if (backupPath) return { filePath: s.filePath, backupPath }
    }
    return null
  })

  ipcMain.handle(IPC.confirmCloseUnsaved, async () => {
    const win = getWindow()
    if (!win) return 'cancel'
    const result = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['保存', '保存しない', 'キャンセル'],
      defaultId: 0,
      cancelId: 2,
      message: '変更を保存しますか？',
      detail: '保存しない場合、直前の変更内容は失われます。'
    })
    return (['save', 'discard', 'cancel'] as const)[result.response]
  })
}
