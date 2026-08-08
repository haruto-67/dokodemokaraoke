// project.json スキーマ（要件定義書 §7.2）に対応する型定義

export interface DokokaraToken {
  text: string
  ruby: string | null
  start: number
  end: number
  locked: boolean
}

export interface DokokaraLine {
  id: string
  text: string
  start: number
  end: number
  tokens: DokokaraToken[]
}

export interface DokokaraPhrase {
  start: number
  end: number
}

export interface DokokaraAudioTrack {
  originalFileName: string
  path: string
  duration: number
  sampleRate: number
}

export type VocalIsolationMethod = 'difference' | 'none'

export interface DokokaraProject {
  version: 2
  app: 'dokokara'
  name: string
  createdAt: string
  updatedAt: string

  audio: {
    analysis: DokokaraAudioTrack | null
    playback: DokokaraAudioTrack | null
    alignmentOffsetSamples: number
  }

  playback: {
    offsetMs: number
    defaultSource: 'playback' | 'analysis'
  }

  analysis: {
    method: 'yin'
    vocalIsolation: VocalIsolationMethod
    hopSec: number
    frameCount: number
    pitchFile: string
    onsetFile: string
    phrases: DokokaraPhrase[]
  }

  lyrics: DokokaraLine[]

  // ホーム画面カードでの波形サムネイル表示用（軽量ダウンサンプル配列、0..1）
  waveformThumb?: number[]
}

export function createEmptyProject(name: string): DokokaraProject {
  const now = new Date().toISOString()
  return {
    version: 2,
    app: 'dokokara',
    name,
    createdAt: now,
    updatedAt: now,
    audio: {
      analysis: null,
      playback: null,
      alignmentOffsetSamples: 0
    },
    playback: {
      offsetMs: 0,
      defaultSource: 'playback'
    },
    analysis: {
      method: 'yin',
      vocalIsolation: 'none',
      hopSec: 0.005,
      frameCount: 0,
      pitchFile: 'pitch.bin',
      onsetFile: 'onsets.bin',
      phrases: []
    },
    lyrics: []
  }
}

// アプリ全体設定（§4.2）
export interface AppSettings {
  projectsDir: string
  autoBackupIntervalMs: number
  snapEnabled: boolean
  snapDistancePx: number
  seekStepSec: number
  bigSeekStepSec: number
  defaultPerformSource: 'playback' | 'analysis'
  countInEnabled: boolean
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  projectsDir: '', // メインプロセス側で ~/Documents/どこでもカラオケセット/ に解決する
  autoBackupIntervalMs: 3 * 60 * 1000,
  snapEnabled: true,
  snapDistancePx: 8,
  seekStepSec: 0.5,
  bigSeekStepSec: 5,
  defaultPerformSource: 'playback',
  countInEnabled: true
}

// ホーム画面カード用の軽量メタデータ
export interface ProjectSummary {
  filePath: string
  name: string
  durationSec: number
  lineCount: number
  updatedAt: string
  createdAt: string
  waveformThumb: number[] | null
}

// 解析パイプラインの進捗
export type AnalysisStepId =
  | 'alignment'
  | 'vocalIsolation'
  | 'preprocess'
  | 'pitch'
  | 'onset'
  | 'phrase'
  | 'assign'
  | 'tokenAllocate'

export interface AnalysisStepProgress {
  id: AnalysisStepId
  label: string
  progress: number // 0..1
  status: 'pending' | 'running' | 'done' | 'skipped' | 'error'
  detail?: string
}

export interface AnalysisResult {
  alignmentOffsetSamples: number
  vocalIsolationUsed: VocalIsolationMethod
  pitchHz: Float32Array
  hopSec: number
  onsetsSec: Float32Array
  phrases: DokokaraPhrase[]
  logs: AnalysisLogEntry[]
}

export interface AnalysisLogEntry {
  step: AnalysisStepId
  label: string
  durationMs: number
  detail: string
}

// ログ（§5 ログ要件）
export interface PipelineLogEntry {
  timestamp: string
  step: string
  durationMs: number
  result: string
}
