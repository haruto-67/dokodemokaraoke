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
  /** 自動タイミング付け(§4.4.7)の信頼度(0..1)。手動追加・分割・結合した行や、
   *  検出フレーズ数不足で自動アライメントされなかった行はnull。 */
  confidence: number | null
}

export interface DokokaraPhrase {
  start: number
  end: number
}

export interface DokokaraNote {
  start: number
  end: number
  pitchMidi: number
  amplitude: number
}

export interface DokokaraAudioTrack {
  originalFileName: string
  path: string
  duration: number
  sampleRate: number
}

export type SeparationMethod = 'melband-roformer'
export type PitchMethod = 'rmvpe'
export type AlignMethod = 'wav2vec2-ctc'

/**
 * F0(基本周波数)曲線1フレームあたりの秒数。Basic Pitchのpost-processing座標系
 * (ANNOTATIONS_FPS=86、python/sidecar/f0_notes.py参照)に合わせて固定。
 */
export const DEFAULT_HOP_SEC = 1 / 86

export interface DokokaraProject {
  version: 3
  app: 'dokokara'
  name: string
  createdAt: string
  updatedAt: string

  audio: {
    // v3ではボーカル/伴奏分離(STEP2)の出力を格納する: analysis=分離済みボーカル、
    // playback=分離済み伴奏。両者は同一音源由来のため、旧v2にあった
    // alignmentOffsetSamples(独立収録した2トラックの時間合わせ)は不要。
    analysis: DokokaraAudioTrack | null
    playback: DokokaraAudioTrack | null
  }

  playback: {
    offsetMs: number
    defaultSource: 'playback' | 'analysis'
  }

  analysis: {
    separation: SeparationMethod
    pitchMethod: PitchMethod
    alignMethod: AlignMethod
    hopSec: number
    frameCount: number
    f0File: string
    notes: DokokaraNote[]
    phrases: DokokaraPhrase[]
  }

  lyrics: DokokaraLine[]

  // ホーム画面カードでの波形サムネイル表示用（軽量ダウンサンプル配列、0..1）
  waveformThumb?: number[]
}

export function createEmptyProject(name: string): DokokaraProject {
  const now = new Date().toISOString()
  return {
    version: 3,
    app: 'dokokara',
    name,
    createdAt: now,
    updatedAt: now,
    audio: {
      analysis: null,
      playback: null
    },
    playback: {
      offsetMs: 0,
      defaultSource: 'playback'
    },
    analysis: {
      separation: 'melband-roformer',
      pitchMethod: 'rmvpe',
      alignMethod: 'wav2vec2-ctc',
      hopSec: DEFAULT_HOP_SEC,
      frameCount: 0,
      f0File: 'f0.bin',
      notes: [],
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

// 解析パイプラインの進捗(python/sidecar/main.pyが送るstep idと一致させる)
export type AnalysisStepId = 'vocalIsolation' | 'pitch' | 'phrase' | 'assign'

export interface AnalysisStepProgress {
  id: AnalysisStepId
  label: string
  progress: number // 0..1
  status: 'pending' | 'running' | 'done' | 'skipped' | 'error'
  detail?: string
}

// ログ（§5 ログ要件）
export interface PipelineLogEntry {
  timestamp: string
  step: string
  durationMs: number
  result: string
}

/**
 * 同梱yt-dlpの自己更新(§4.3の実装メモ「同梱版＋任意更新」)。
 * yt-dlpは配信元(YouTube)の仕様変更で壊れやすいため、アプリ内から
 * 同梱バイナリを最新版に更新できる導線を設定画面に用意する。
 */
export type YtDlpUpdateOutcome = 'updated' | 'already_latest' | 'failed'

export interface YtDlpUpdateResult {
  outcome: YtDlpUpdateOutcome
  message: string
}
