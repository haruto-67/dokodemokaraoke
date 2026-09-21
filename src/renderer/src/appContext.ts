import type { AppSettings, ProjectSummary } from '@shared/types'
import type { ScoringResult } from '@shared/analysis/scoring'
import { createEditorStore, type EditorStore } from './state/editorStore'
import { Store } from './state/store'
import { PlaybackEngine } from './lib/audio'

export type ScreenName = 'home' | 'setup' | 'analyzing' | 'editor' | 'perform' | 'result'

export interface NavigateParams {
  // setup 画面: 既存プロジェクトを開いた直後に渡す場合など
  reopen?: boolean
}

export interface SetupAudioFile {
  path: string
  ext: string
  fileName: string
  buffer: AudioBuffer
}

export interface SetupDraft {
  projectName: string
  analysisAudio: SetupAudioFile | null
  playbackAudio: SetupAudioFile | null
  // YouTube URL入力欄のドラフト値(§4.3)。取り込み失敗で準備画面に戻った際も
  // 入力し直さずに済むよう、他のドラフト項目と同様にここへ保持する。
  youtubeUrl: string
  lyricsText: string
  removeSpaces: boolean
}

export function emptySetupDraft(): SetupDraft {
  return {
    projectName: '',
    analysisAudio: null,
    playbackAudio: null,
    youtubeUrl: '',
    lyricsText: '',
    removeSpaces: false
  }
}

export interface UiState {
  screen: ScreenName
  settingsOpen: boolean
  homeSummaries: ProjectSummary[]
  setupDraft: SetupDraft
  /** リザルト画面(§4.12.4)へ渡す採点結果。プロジェクトには保存せず、その場限りの表示に使う */
  lastScoreResult: ScoringResult | null
  /** プロジェクトの読み込み中(ZIP展開・音声デコード)にローディング表示を出すためのフラグ。
   *  ボタンを押してから画面遷移までラグがあり押せたか分かりにくい、という報告への対応。 */
  loadingProject: boolean
}

export interface AppContext {
  editor: EditorStore
  ui: Store<UiState>
  settings: Store<AppSettings>
  playback: PlaybackEngine
  navigate: (screen: ScreenName, params?: NavigateParams) => void
  openSettings: () => void
  closeSettings: () => void
  refreshHome: () => Promise<void>
}

export function createAppContext(initialSettings: AppSettings): AppContext {
  const editor = createEditorStore()
  const ui = new Store<UiState>({
    screen: 'home',
    settingsOpen: false,
    homeSummaries: [],
    setupDraft: emptySetupDraft(),
    lastScoreResult: null,
    loadingProject: false
  })
  const settings = new Store<AppSettings>(initialSettings)
  const playback = new PlaybackEngine()

  const ctx: AppContext = {
    editor,
    ui,
    settings,
    playback,
    navigate: (screen) => ui.setState({ screen }),
    openSettings: () => ui.setState({ settingsOpen: true }),
    closeSettings: () => ui.setState({ settingsOpen: false }),
    refreshHome: async () => {
      const summaries = await window.dokokara.listProjects()
      ui.setState({ homeSummaries: summaries })
    }
  }
  return ctx
}
