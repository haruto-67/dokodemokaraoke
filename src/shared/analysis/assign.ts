// STEP 7: 歌詞行への割り当て(要件定義書 §4.4.7)
import type { Phrase } from './phrase'

/** ギャップが最小の隣接区間から順に統合し、区間数をtargetCountまで減らす */
function mergePhrasesToCount(phrases: Phrase[], targetCount: number): Phrase[] {
  const segments = phrases.map((p) => ({ ...p }))
  while (segments.length > targetCount) {
    let minGapIdx = 0
    let minGap = Infinity
    for (let i = 0; i < segments.length - 1; i++) {
      const gap = segments[i + 1].start - segments[i].end
      if (gap < minGap) {
        minGap = gap
        minGapIdx = i
      }
    }
    const merged = { start: segments[minGapIdx].start, end: segments[minGapIdx + 1].end }
    segments.splice(minGapIdx, 2, merged)
  }
  return segments
}

/**
 * 各セグメントがいくつの行を受け持つかを決める。「最も長い区間から分割する」を、
 * duration/現在の受け持ち行数 が最大のセグメントへ優先的に行を追加していく形で実現する。
 */
function distributeLineCounts(segments: Phrase[], lineCount: number): number[] {
  const counts = new Array(segments.length).fill(1)
  let remaining = lineCount - segments.length
  while (remaining > 0) {
    let bestIdx = 0
    let bestRatio = -Infinity
    for (let i = 0; i < segments.length; i++) {
      const duration = segments[i].end - segments[i].start
      const ratio = duration / counts[i]
      if (ratio > bestRatio) {
        bestRatio = ratio
        bestIdx = i
      }
    }
    counts[bestIdx]++
    remaining--
  }
  return counts
}

/** セグメントを重み(モーラ数など)の比で分割する。等分ではなく重み比を用いる(§4.4.7)。 */
function splitSegmentByWeights(segment: Phrase, weights: number[]): Phrase[] {
  const safeWeights = weights.map((w) => (w > 0 ? w : 1))
  const safeTotal = safeWeights.reduce((a, b) => a + b, 0) || safeWeights.length
  const duration = segment.end - segment.start

  const result: Phrase[] = []
  let cursor = segment.start
  for (let i = 0; i < safeWeights.length; i++) {
    const isLast = i === safeWeights.length - 1
    const share = (safeWeights[i] / safeTotal) * duration
    const end = isLast ? segment.end : cursor + share
    result.push({ start: cursor, end })
    cursor = end
  }
  return result
}

/**
 * 検出したフレーズ区間数と歌詞行数を突き合わせて、各行の開始・終了時刻を自動割り当てする(§4.4.7)。
 * @param lineWeights 各行の重み(モーラ数比など)。分割時の按分に使う。要素数=行数。
 * @param totalDurationSec フレーズが1つも検出できない場合のフォールバックで使う楽曲全体の長さ(秒)。
 */
export function assignPhrasesToLines(phrases: Phrase[], lineWeights: number[], totalDurationSec: number): Phrase[] {
  const lineCount = lineWeights.length
  if (lineCount === 0) return []

  if (phrases.length === 0) {
    // フォールバック: 楽曲全体を行数で均等分割する
    const share = totalDurationSec / lineCount
    return lineWeights.map((_, i) => ({ start: i * share, end: (i + 1) * share }))
  }

  const merged = phrases.length > lineCount ? mergePhrasesToCount(phrases, lineCount) : phrases.map((p) => ({ ...p }))

  if (merged.length === lineCount) {
    return merged
  }

  // merged.length < lineCount: 最も長い区間から順に、モーラ数比で分割する
  const counts = distributeLineCounts(merged, lineCount)
  const result: Phrase[] = []
  let lineCursor = 0
  for (let i = 0; i < merged.length; i++) {
    const k = counts[i]
    if (k === 1) {
      result.push(merged[i])
    } else {
      const weights = lineWeights.slice(lineCursor, lineCursor + k)
      result.push(...splitSegmentByWeights(merged[i], weights))
    }
    lineCursor += k
  }
  return result
}
