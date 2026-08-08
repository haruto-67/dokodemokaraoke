import type { AppContext } from '../appContext'
import { emptySetupDraft } from '../appContext'
import type { DokokaraProject } from '@shared/types'
import type { OpenProjectResult } from '@shared/ipc'
import { decodeAudio } from './audio'
import type { EditorAudioState } from '../state/editorStore'

const RECENT_KEY = 'dokokara.recentProjectPath'

function rememberRecent(filePath: string): void {
  try {
    localStorage.setItem(RECENT_KEY, filePath)
  } catch {
    /* localStorage が使えない環境では無視 */
  }
}

/** §4.12: 音源デコード失敗時などにユーザーへ伝えるための簡易通知。今は window.alert、後で trueなトースト実装に差し替え可能。 */
export function notifyError(message: string): void {
  window.alert(message)
}

/**
 * 読み込み結果(OpenProjectResult)をエディタ状態へ反映する共通処理。
 * @param editorFilePath 履歴上の保存先パス。既定は result.filePath だが、
 *   クラッシュバックアップ復元時は「元のプロジェクトパス」を渡し、⌘S で元ファイルへ上書きできるようにする。
 */
async function applyOpenResult(
  ctx: AppContext,
  result: OpenProjectResult,
  editorFilePath: string = result.filePath
): Promise<void> {
  if (result.brokenParts.length > 0) {
    notifyError(
      `プロジェクトファイルの一部が破損していたため、以下の項目を読み込めませんでした:\n${result.brokenParts.join(', ')}`
    )
  }

  const json = result.json as DokokaraProject
  const audioState: EditorAudioState = {
    analysisBuffer: null,
    playbackBuffer: null,
    analysisSourcePath: null,
    playbackSourcePath: null,
    analysisExt: null,
    playbackExt: null
  }

  const audioCtx = ctx.playback.audioContext
  if (result.audio.analysis) {
    try {
      audioState.analysisBuffer = await decodeAudio(audioCtx, result.audio.analysis.data)
    } catch (e) {
      notifyError((e as Error).message)
    }
  }
  if (result.audio.playback) {
    try {
      audioState.playbackBuffer = await decodeAudio(audioCtx, result.audio.playback.data)
    } catch (e) {
      notifyError((e as Error).message)
    }
  }

  const pitchHz = result.pitchBin ? new Float32Array(result.pitchBin) : null
  const onsetsSec = result.onsetsBin ? new Float32Array(result.onsetsBin) : null

  ctx.editor.loadProject(editorFilePath, json, pitchHz, onsetsSec, audioState)
  ctx.playback.setBuffer(
    json.playback.defaultSource === 'analysis' ? audioState.analysisBuffer : audioState.playbackBuffer ?? audioState.analysisBuffer
  )
  rememberRecent(editorFilePath)
  ctx.navigate('editor')
}

export async function openProjectByPath(ctx: AppContext, filePath: string): Promise<void> {
  let result
  try {
    result = await window.dokokara.openProjectPath(filePath)
  } catch (e) {
    notifyError(`プロジェクトを開けませんでした: ${(e as Error).message}`)
    return
  }
  if (!result) return
  await applyOpenResult(ctx, result)
}

/** ⌘O: ダイアログでプロジェクトファイルを選んで開く */
export async function openProjectDialogFlow(ctx: AppContext): Promise<void> {
  let result: OpenProjectResult | null
  try {
    result = await window.dokokara.openProjectDialog()
  } catch (e) {
    notifyError(`プロジェクトを開けませんでした: ${(e as Error).message}`)
    return
  }
  if (!result) return
  await applyOpenResult(ctx, result)
}

/** §4.1: クラッシュ後の復帰。バックアップの内容を「元のプロジェクトパス」に紐づけて読み込む。 */
export async function restoreFromBackup(ctx: AppContext, originalFilePath: string, backupPath: string): Promise<void> {
  let result
  try {
    result = await window.dokokara.openProjectPath(backupPath)
  } catch (e) {
    notifyError(`バックアップの復元に失敗しました: ${(e as Error).message}`)
    return
  }
  if (!result) return
  await applyOpenResult(ctx, result, originalFilePath)
}

export function createNewProjectFlow(ctx: AppContext): void {
  ctx.ui.setState({ setupDraft: emptySetupDraft() })
  ctx.navigate('setup')
}

function typedArrayToArrayBuffer(arr: Float32Array): ArrayBuffer {
  return arr.buffer.slice(arr.byteOffset, arr.byteOffset + arr.byteLength) as ArrayBuffer
}

function buildSaveJson(project: DokokaraProject): DokokaraProject {
  return { ...project, updatedAt: new Date().toISOString() }
}

export async function saveProject(ctx: AppContext, saveAs: boolean): Promise<boolean> {
  const state = ctx.editor.store.getState()
  if (!state.project) return false
  const json = buildSaveJson(state.project)

  const payload = {
    filePath: saveAs ? null : state.filePath,
    json,
    pitchBin: state.pitchHz ? typedArrayToArrayBuffer(state.pitchHz) : null,
    onsetsBin: state.onsetsSec ? typedArrayToArrayBuffer(state.onsetsSec) : null,
    audio: {
      analysis:
        state.audio.analysisSourcePath && state.audio.analysisExt
          ? { sourcePath: state.audio.analysisSourcePath, ext: state.audio.analysisExt }
          : null,
      playback:
        state.audio.playbackSourcePath && state.audio.playbackExt
          ? { sourcePath: state.audio.playbackSourcePath, ext: state.audio.playbackExt }
          : null
    }
  }

  try {
    if (saveAs || !state.filePath) {
      const res = await window.dokokara.saveProjectAs(payload, json.name)
      if (!res) return false
      ctx.editor.store.setState({ filePath: res.filePath, project: json })
    } else {
      const res = await window.dokokara.saveProject(payload)
      ctx.editor.store.setState({ filePath: res.filePath, project: json })
    }
    ctx.editor.markSaved()
    return true
  } catch (e) {
    notifyError(`保存に失敗しました: ${(e as Error).message}`)
    return false
  }
}

/** 自動バックアップ・クラッシュ復帰用に .backups へスナップショットを書き出す */
export async function backupProject(ctx: AppContext): Promise<void> {
  const state = ctx.editor.store.getState()
  if (!state.project) return
  const json = buildSaveJson(state.project)
  const payload = {
    filePath: state.filePath,
    json,
    pitchBin: state.pitchHz ? typedArrayToArrayBuffer(state.pitchHz) : null,
    onsetsBin: state.onsetsSec ? typedArrayToArrayBuffer(state.onsetsSec) : null,
    audio: {
      analysis:
        state.audio.analysisSourcePath && state.audio.analysisExt
          ? { sourcePath: state.audio.analysisSourcePath, ext: state.audio.analysisExt }
          : null,
      playback:
        state.audio.playbackSourcePath && state.audio.playbackExt
          ? { sourcePath: state.audio.playbackSourcePath, ext: state.audio.playbackExt }
          : null
    }
  }
  try {
    await window.dokokara.backupProject(payload)
  } catch {
    /* バックアップ失敗はユーザー操作を妨げない */
  }
}

/** §4.1: 未保存の変更がある状態で画面を離れる/閉じる際の確認 */
export async function confirmDiscardIfDirty(ctx: AppContext): Promise<boolean> {
  if (!ctx.editor.isDirty()) return true
  const choice = await window.dokokara.confirmCloseUnsaved()
  if (choice === 'cancel') return false
  if (choice === 'save') {
    const ok = await saveProject(ctx, false)
    return ok
  }
  return true
}
