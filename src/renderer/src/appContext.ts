import type { AppSettings, ProjectSummary } from '@shared/types'
import { createEditorStore, type EditorStore } from './state/editorStore'
import { Store } from './state/store'
import { PlaybackEngine } from './lib/audio'

export type ScreenName = 'home' | 'setup' | 'analyzing' | 'editor' | 'perform'

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
  lyricsText: string
  removeSpaces: boolean
}

export function emptySetupDraft(): SetupDraft {
  return {
    projectName: '',
    analysisAudio: null,
    playbackAudio: null,
    lyricsText: '',
    removeSpaces: false
  }
}

export interface UiState {
  screen: ScreenName
  settingsOpen: boolean
  homeSummaries: ProjectSummary[]
  setupDraft: SetupDraft
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
    setupDraft: emptySetupDraft()
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
