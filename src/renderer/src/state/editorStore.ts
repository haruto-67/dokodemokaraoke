import type { DokokaraLine, DokokaraProject } from '@shared/types'
import { Store } from './store'
import { HistoryManager } from './history'

export interface EditorAudioState {
  analysisBuffer: AudioBuffer | null
  playbackBuffer: AudioBuffer | null
  analysisSourcePath: string | null // ファイルシステム上の一時/元パス（保存時に読み直す）
  playbackSourcePath: string | null
  analysisExt: string | null
  playbackExt: string | null
}

export interface EditorState {
  filePath: string | null
  project: DokokaraProject | null
  pitchHz: Float32Array | null
  onsetsSec: Float32Array | null
  audio: EditorAudioState
  selection: {
    lineId: string | null
    tokenIndex: number | null
  }
  zoom: number // 0.25〜8
  scrollSec: number
  playheadSec: number
  isPlaying: boolean
  playSource: 'playback' | 'analysis'
  showGuides: boolean
  snapEnabled: boolean
  tapMode: boolean
}

function emptyAudioState(): EditorAudioState {
  return {
    analysisBuffer: null,
    playbackBuffer: null,
    analysisSourcePath: null,
    playbackSourcePath: null,
    analysisExt: null,
    playbackExt: null
  }
}

export function createEditorStore() {
  const store = new Store<EditorState>({
    filePath: null,
    project: null,
    pitchHz: null,
    onsetsSec: null,
    audio: emptyAudioState(),
    selection: { lineId: null, tokenIndex: null },
    zoom: 1,
    scrollSec: 0,
    playheadSec: 0,
    isPlaying: false,
    playSource: 'playback',
    showGuides: true,
    snapEnabled: true,
    tapMode: false
  })

  let history = new HistoryManager<DokokaraLine[]>(store.getState().project?.lyrics ?? [])
  let pendingSnapshot: DokokaraLine[] | null = null

  function loadProject(
    filePath: string | null,
    project: DokokaraProject,
    pitchHz: Float32Array | null,
    onsetsSec: Float32Array | null,
    audio: EditorAudioState
  ): void {
    store.setState({
      filePath,
      project,
      pitchHz,
      onsetsSec,
      audio,
      selection: { lineId: null, tokenIndex: null },
      zoom: 1,
      scrollSec: 0,
      playheadSec: 0,
      isPlaying: false
    })
    history = new HistoryManager<DokokaraLine[]>(project.lyrics)
  }

  /** ドラッグ開始時など、コミット前の変更を始める前に呼ぶ */
  function beginChange(): void {
    const p = store.getState().project
    if (p) pendingSnapshot = p.lyrics
  }

  /** ドラッグ中の一時的な更新。履歴には積まない。 */
  function applyTransient(updateLyrics: (lyrics: DokokaraLine[]) => DokokaraLine[]): void {
    const p = store.getState().project
    if (!p) return
    const newLyrics = updateLyrics(p.lyrics)
    store.setState({ project: { ...p, lyrics: newLyrics, updatedAt: new Date().toISOString() } })
  }

  /** pointerup 相当。直前の beginChange 時点を履歴にコミットする。 */
  function commitChange(): void {
    if (pendingSnapshot) {
      history.commit(pendingSnapshot)
      pendingSnapshot = null
    }
  }

  /** 単発操作（結合・分割・削除など）を即座に1操作としてコミットする */
  function applyAndCommit(updateLyrics: (lyrics: DokokaraLine[]) => DokokaraLine[]): void {
    const p = store.getState().project
    if (!p) return
    history.commit(p.lyrics)
    const newLyrics = updateLyrics(p.lyrics)
    store.setState({ project: { ...p, lyrics: newLyrics, updatedAt: new Date().toISOString() } })
  }

  function undo(): void {
    const p = store.getState().project
    if (!p) return
    const prev = history.undo(p.lyrics)
    if (prev) store.setState({ project: { ...p, lyrics: prev } })
  }

  function redo(): void {
    const p = store.getState().project
    if (!p) return
    const next = history.redo(p.lyrics)
    if (next) store.setState({ project: { ...p, lyrics: next } })
  }

  function markSaved(): void {
    const p = store.getState().project
    if (p) history.markSaved(p.lyrics)
  }

  function isDirty(): boolean {
    const p = store.getState().project
    if (!p) return false
    return history.isDirty(p.lyrics)
  }

  function canUndo(): boolean {
    return history.canUndo()
  }
  function canRedo(): boolean {
    return history.canRedo()
  }

  return {
    store,
    loadProject,
    beginChange,
    applyTransient,
    commitChange,
    applyAndCommit,
    undo,
    redo,
    markSaved,
    isDirty,
    canUndo,
    canRedo
  }
}

export type EditorStore = ReturnType<typeof createEditorStore>
