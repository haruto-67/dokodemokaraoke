// 解析パイプライン全体のオーケストレーション(要件定義書 §4.4 STEP1〜8)
import { estimateAlignment } from './align'
import { extractDifferenceVocal } from './vocalIsolation'
import { toMono, resampleLinear, preprocess } from './preprocess'
import {
  detectPitchYin,
  correctOctaveErrors,
  medianFilter,
  smoothPitchTrajectory,
  findPitchChangePoints,
  HOP_SEC,
  type PitchFrame
} from './pitch'
import { detectOnsets } from './onset'
import { detectPhrases } from './phrase'
import { assignPhrasesToLines } from './assign'
import { allocateTokenTimings } from './allocate'
import { tokenizeLine, tokenWeight } from '../tokenize'
import type {
  AnalysisResult,
  AnalysisStepId,
  AnalysisStepProgress,
  AnalysisLogEntry,
  DokokaraLine,
  VocalIsolationMethod
} from '../types'

export interface AudioInput {
  channels: Float32Array[]
  sampleRate: number
}

export interface RunAnalysisInput {
  analysis: AudioInput
  /** 未指定(null)の場合、アライメント・差分ボーカル抽出は行わずオンボーカルをそのまま解析する */
  playback: AudioInput | null
}

export type ProgressCallback = (progress: AnalysisStepProgress) => void

const STEP_LABELS: Record<AnalysisStepId, string> = {
  alignment: '時間軸アライメント',
  vocalIsolation: '差分ボーカル抽出',
  preprocess: '前処理',
  pitch: 'ピッチ検出',
  onset: 'オンセット検出',
  phrase: 'フレーズ区間検出',
  assign: '歌詞行への割り当て',
  tokenAllocate: '文字タイミング配分'
}

function report(
  cb: ProgressCallback | undefined,
  id: AnalysisStepId,
  status: AnalysisStepProgress['status'],
  progress: number,
  detail?: string
): void {
  cb?.({ id, label: STEP_LABELS[id], status, progress, detail })
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

/** STEP1〜6: 音源そのものの解析。歌詞には依存しない。 */
export function runSignalAnalysis(input: RunAnalysisInput, onProgress?: ProgressCallback): AnalysisResult {
  const logs: AnalysisLogEntry[] = []
  const logStep = (step: AnalysisStepId, startedAt: number, detail: string): void => {
    logs.push({ step, label: STEP_LABELS[step], durationMs: now() - startedAt, detail })
  }

  const sourceSampleRate = input.analysis.sampleRate
  const analysisMono = toMono(input.analysis.channels)
  const hasPlayback = input.playback !== null

  // STEP1: 時間軸アライメント
  let alignmentOffsetSamples = 0
  let alignable = false
  let playbackMonoAtAnalysisRate: Float32Array | null = null

  if (hasPlayback) {
    report(onProgress, 'alignment', 'running', 0)
    const start = now()
    const playbackMono = toMono(input.playback!.channels)
    playbackMonoAtAnalysisRate =
      input.playback!.sampleRate === sourceSampleRate
        ? playbackMono
        : resampleLinear(playbackMono, input.playback!.sampleRate, sourceSampleRate)
    const result = estimateAlignment(analysisMono, playbackMonoAtAnalysisRate, sourceSampleRate)
    alignmentOffsetSamples = result.offsetSamples
    alignable = result.alignable
    logStep('alignment', start, `confidence=${result.confidence.toFixed(2)} alignable=${alignable}`)
    report(onProgress, 'alignment', 'done', 1, alignable ? undefined : '相関のピークが不明瞭なため別マスターの可能性があります')
  } else {
    report(onProgress, 'alignment', 'skipped', 1, 'オフボーカル未指定')
  }

  // STEP2: 差分ボーカル抽出
  let isolatedSignal: Float32Array | null = null
  let isolatedStartIndex = 0
  let vocalIsolationUsed: VocalIsolationMethod = 'none'

  if (hasPlayback && alignable && playbackMonoAtAnalysisRate) {
    report(onProgress, 'vocalIsolation', 'running', 0)
    const start = now()
    const iso = extractDifferenceVocal(analysisMono, playbackMonoAtAnalysisRate, alignmentOffsetSamples)
    logStep('vocalIsolation', start, `residualRatio=${iso.residualRatio.toFixed(2)} used=${iso.used}`)
    if (iso.used) {
      isolatedSignal = iso.signal
      isolatedStartIndex = iso.startIndex
      vocalIsolationUsed = 'difference'
    }
    report(onProgress, 'vocalIsolation', 'done', 1, iso.used ? undefined : '打ち消しが不十分なためオンボーカルにフォールバックします')
  } else {
    report(onProgress, 'vocalIsolation', 'skipped', 1)
  }

  // STEP3: 前処理(モノラル化は既に完了しているためリサンプル・ハイパスのみ)
  report(onProgress, 'preprocess', 'running', 0)
  const preStart = now()
  const sourceSignal = isolatedSignal ?? analysisMono
  const { signal: processedSignal, sampleRate: processedSampleRate } = preprocess([sourceSignal], sourceSampleRate)
  logStep('preprocess', preStart, `sampleRate=${processedSampleRate}`)
  report(onProgress, 'preprocess', 'done', 1)

  // 差分抽出により信号の先頭が欠けている場合、以降の時刻はすべて analysis 音源のタイムラインに
  // 揃うようシフトする(§4.11のような表示系オフセットではなく、解析上の欠損を補うためのもの)。
  // pitch.bin は index*hopSec で時刻を復元する仕様(§7.3)のため、欠けた先頭分は無声フレームで埋める。
  const leadingSilentFrames = Math.round(isolatedStartIndex / sourceSampleRate / HOP_SEC)
  const frameOffsetSec = leadingSilentFrames * HOP_SEC

  // STEP4: ピッチ検出
  report(onProgress, 'pitch', 'running', 0)
  const pitchStart = now()
  let frames = detectPitchYin(processedSignal, processedSampleRate)
  frames = correctOctaveErrors(frames)
  frames = medianFilter(frames)
  frames = smoothPitchTrajectory(frames)
  if (leadingSilentFrames > 0) {
    const padding: PitchFrame[] = Array.from({ length: leadingSilentFrames }, (_, i) => ({
      timeSec: i * HOP_SEC,
      hz: 0,
      voiced: false
    }))
    frames = [...padding, ...frames.map((f) => ({ ...f, timeSec: f.timeSec + frameOffsetSec }))]
  }
  logStep('pitch', pitchStart, `frames=${frames.length}`)
  report(onProgress, 'pitch', 'done', 1)

  // STEP5: オンセット検出(ピッチ検出と同じ前処理済み信号・タイムベースを使う)
  report(onProgress, 'onset', 'running', 0)
  const onsetStart = now()
  const rawOnsets = detectOnsets(processedSignal, processedSampleRate)
  const onsetsSec = new Float32Array(rawOnsets.length)
  for (let i = 0; i < rawOnsets.length; i++) onsetsSec[i] = rawOnsets[i] + frameOffsetSec
  logStep('onset', onsetStart, `count=${onsetsSec.length}`)
  report(onProgress, 'onset', 'done', 1)

  // STEP6: フレーズ区間検出
  report(onProgress, 'phrase', 'running', 0)
  const phraseStart = now()
  const phrases = detectPhrases(frames, HOP_SEC)
  logStep('phrase', phraseStart, `count=${phrases.length}`)
  report(onProgress, 'phrase', 'done', 1)

  const pitchHz = new Float32Array(frames.length)
  for (let i = 0; i < frames.length; i++) pitchHz[i] = frames[i].voiced ? frames[i].hz : 0

  return {
    alignmentOffsetSamples,
    vocalIsolationUsed,
    pitchHz,
    hopSec: HOP_SEC,
    onsetsSec,
    phrases,
    logs
  }
}

function generateLineId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `line-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/**
 * STEP7〜8: 歌詞行への割り当てとトークン単位の初期タイミング配分。
 * runSignalAnalysis の結果と歌詞テキスト(1行=1フレーズ)を組み合わせて DokokaraLine[] を作る。
 */
export function assignLyricsTiming(
  lyricsLines: string[],
  analysisResult: AnalysisResult,
  totalDurationSec: number,
  onProgress?: ProgressCallback
): DokokaraLine[] {
  if (lyricsLines.length === 0) return []

  report(onProgress, 'assign', 'running', 0)
  const tokensPerLine = lyricsLines.map((text) => tokenizeLine(text))
  const lineWeights = tokensPerLine.map((tokens) => tokens.reduce((sum, tk) => sum + tokenWeight(tk), 0) || 1)

  const lineTimings = assignPhrasesToLines(analysisResult.phrases, lineWeights, totalDurationSec)
  report(onProgress, 'assign', 'done', 1)

  report(onProgress, 'tokenAllocate', 'running', 0)
  const pitchFrames: PitchFrame[] = []
  for (let i = 0; i < analysisResult.pitchHz.length; i++) {
    const hz = analysisResult.pitchHz[i]
    pitchFrames.push({ timeSec: i * analysisResult.hopSec, hz, voiced: hz > 0 })
  }
  const pitchChangePoints = findPitchChangePoints(pitchFrames)
  const onsetsSec = Array.from(analysisResult.onsetsSec)

  const lines: DokokaraLine[] = lyricsLines.map((text, i) => {
    const timing = lineTimings[i] ?? { start: 0, end: 0 }
    const timedTokens = allocateTokenTimings(tokensPerLine[i], timing.start, timing.end, {
      onsetsSec,
      pitchChangePoints
    })
    return {
      id: generateLineId(),
      text,
      start: timing.start,
      end: timing.end,
      tokens: timedTokens.map((t) => ({ text: t.text, ruby: t.ruby, start: t.start, end: t.end, locked: false }))
    }
  })
  report(onProgress, 'tokenAllocate', 'done', 1)

  return lines
}
