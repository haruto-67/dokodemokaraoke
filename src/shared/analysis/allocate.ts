// STEP 8: 文字タイミングの初期配分(要件定義書 §4.4.8, §4.6.3)
import { tokenWeight, type Token } from '../tokenize'

export interface TimedToken extends Token {
  start: number
  end: number
}

/** 行区間内で実際にメロディノートが鳴っている範囲。前後の無音を文字へ配らないために使う。 */
export function melodyRangeForLine(
  lineStart: number,
  lineEnd: number,
  notes: Array<{ start: number; end: number }>
): { start: number; end: number } {
  const overlapping = notes.filter((note) => note.start < lineEnd && note.end > lineStart)
  if (overlapping.length === 0) return { start: lineStart, end: lineEnd }
  const start = Math.max(lineStart, Math.min(...overlapping.map((note) => note.start)))
  const end = Math.min(lineEnd, Math.max(...overlapping.map((note) => note.end)))
  return end > start ? { start, end } : { start: lineStart, end: lineEnd }
}

export interface AllocateTokenTimingsOptions {
  /** STEP5で検出したオンセット時刻(秒、行の範囲外も含めて渡してよい) */
  onsetsSec?: number[]
  /** 有意なピッチ変化点の時刻(秒) */
  pitchChangePoints?: number[]
  /** 境界をスナップ候補へ吸着させる許容誤差(秒)。省略時は行の長さに応じて決める */
  snapToleranceSec?: number
  /** CTCアライメントで得た読みトークン。指定時は均等配分よりこちらを優先する。 */
  alignedReadingTokens?: Array<{ reading: string; start: number; end: number }>
}

const READING_SMALL_KANA = new Set(['ゃ', 'ゅ', 'ょ', 'ぁ', 'ぃ', 'ぅ', 'ぇ', 'ぉ', 'ャ', 'ュ', 'ョ', 'ァ', 'ィ', 'ゥ', 'ェ', 'ォ'])

function readingWeight(reading: string): number {
  if (/^<[^>]+>$/.test(reading)) return 1
  let count = 0
  for (const ch of reading) {
    if (!READING_SMALL_KANA.has(ch)) count++
  }
  return Math.max(1, count)
}

function alignedBoundaryAtWeight(
  aligned: Array<{ reading: string; start: number; end: number }>,
  targetWeight: number,
  totalTargetWeight: number
): number | null {
  if (aligned.length === 0 || totalTargetWeight <= 0) return null
  const weights = aligned.map((item) => readingWeight(item.reading))
  const sourceTotal = weights.reduce((sum, weight) => sum + weight, 0)
  const sourceTarget = (targetWeight / totalTargetWeight) * sourceTotal
  let accumulated = 0
  for (let i = 0; i < aligned.length; i++) {
    const next = accumulated + weights[i]
    if (sourceTarget <= next || i === aligned.length - 1) {
      const ratio = weights[i] > 0 ? (sourceTarget - accumulated) / weights[i] : 0
      return aligned[i].start + (aligned[i].end - aligned[i].start) * Math.max(0, Math.min(1, ratio))
    }
    accumulated = next
  }
  return null
}

/**
 * 行の時間 [lineStart, lineEnd) をトークンへ配分する(§4.6.3)。
 * 1. モーラ重み比での線形配分を初期境界とする
 * 2〜3. 内部境界をオンセット位置・ピッチ変化点の近傍にスナップする
 * 4. スナップ候補が無い/遠い区間は重み比のままとする
 */
export function allocateTokenTimings(
  tokens: Token[],
  lineStart: number,
  lineEnd: number,
  options: AllocateTokenTimingsOptions = {}
): TimedToken[] {
  if (tokens.length === 0) return []

  const duration = Math.max(0, lineEnd - lineStart)
  const weights = tokens.map(tokenWeight)
  const totalWeight = weights.reduce((a, b) => a + b, 0) || tokens.length

  // 1. 重み付き配分
  const boundaries: number[] = [lineStart]
  let acc = 0
  for (const w of weights) {
    acc += w
    boundaries.push(lineStart + duration * (acc / totalWeight))
  }
  boundaries[boundaries.length - 1] = lineEnd // 丸め誤差を吸収し、必ず行末に一致させる

  // CTCの読みタイミングを、表示トークン側のモーラ重みの累積位置へ対応付ける。語彙が
  // 複数文字を1ラベルにする場合は、そのラベル区間内をモーラ数で補間する。
  const aligned = options.alignedReadingTokens?.filter((item) => item.end >= lineStart && item.start <= lineEnd) ?? []
  if (aligned.length > 0) {
    let targetWeight = 0
    for (let i = 1; i < boundaries.length - 1; i++) {
      targetWeight += weights[i - 1]
      const alignedTime = alignedBoundaryAtWeight(aligned, targetWeight, totalWeight)
      if (alignedTime !== null) boundaries[i] = Math.max(lineStart, Math.min(lineEnd, alignedTime))
    }
  }

  // 2〜3. 内部境界(先頭・末尾は行の開始/終了に固定するため対象外)をスナップ候補に吸着させる
  const snapCandidates = [...(options.onsetsSec ?? []), ...(options.pitchChangePoints ?? [])]
    .filter((t) => t > lineStart && t < lineEnd)
    .sort((a, b) => a - b)
  const tolerance = options.snapToleranceSec ?? Math.min(aligned.length > 0 ? 0.22 : 0.15, duration * 0.2)

  const usedCandidates = new Set<number>()
  for (let i = 1; i < boundaries.length - 1; i++) {
    let nearest: number | null = null
    let nearestDist = Infinity
    for (const c of snapCandidates) {
      if (usedCandidates.has(c)) continue
      const dist = Math.abs(c - boundaries[i])
      if (dist < nearestDist) {
        nearestDist = dist
        nearest = c
      }
    }
    if (nearest !== null && nearestDist <= tolerance) {
      boundaries[i] = nearest
      usedCandidates.add(nearest)
    }
  }

  // スナップにより境界の前後関係が崩れないようクランプする
  for (let i = 1; i < boundaries.length; i++) {
    if (boundaries[i] < boundaries[i - 1]) boundaries[i] = boundaries[i - 1]
  }

  return tokens.map((t, i) => ({ ...t, start: boundaries[i], end: boundaries[i + 1] }))
}

export interface PitchFrame {
  timeSec: number
  hz: number
  voiced: boolean
}

/**
 * 有意なピッチ変化点の時刻を抽出する(§4.6.3手順3で境界候補として使う)。
 * 半音(semitone)換算でthresholdSemitones以上の跳躍があったフレームの時刻を返す。
 */
export function findPitchChangePoints(frames: PitchFrame[], thresholdSemitones = 1.5): number[] {
  const points: number[] = []
  let lastHz: number | null = null
  for (const f of frames) {
    if (!f.voiced || f.hz <= 0) {
      lastHz = null
      continue
    }
    if (lastHz !== null) {
      const semitones = Math.abs(12 * Math.log2(f.hz / lastHz))
      if (semitones >= thresholdSemitones) points.push(f.timeSec)
    }
    lastHz = f.hz
  }
  return points
}
