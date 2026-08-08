// メインスレッド <-> 解析Worker間のメッセージ契約
import type { AnalysisStepProgress, AnalysisLogEntry, DokokaraPhrase, DokokaraLine, VocalIsolationMethod } from '@shared/types'

export interface AnalysisWorkerAudioInput {
  channels: ArrayBuffer[]
  sampleRate: number
}

export interface AnalysisWorkerRequest {
  analysis: AnalysisWorkerAudioInput
  /** オフボーカル未指定の場合はnull */
  playback: AnalysisWorkerAudioInput | null
  lyricsLines: string[]
  totalDurationSec: number
}

/** AnalysisResult(shared/types.ts)のTypedArrayをTransferable用にArrayBufferへ差し替えたもの */
export interface SerializedAnalysisResult {
  alignmentOffsetSamples: number
  vocalIsolationUsed: VocalIsolationMethod
  pitchHz: ArrayBuffer
  hopSec: number
  onsetsSec: ArrayBuffer
  phrases: DokokaraPhrase[]
  logs: AnalysisLogEntry[]
}

export type AnalysisWorkerResponse =
  | { type: 'progress'; progress: AnalysisStepProgress }
  | { type: 'done'; analysisResult: SerializedAnalysisResult; lines: DokokaraLine[] }
  | { type: 'error'; message: string }
