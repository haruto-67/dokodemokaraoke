// STEP 6: フレーズ区間検出(要件定義書 §4.4.6)
import type { PitchFrame } from './pitch'

export interface Phrase {
  start: number
  end: number
}

export interface PhraseDetectionOptions {
  /** これ以下の無声ギャップは跨いで結合する(秒) */
  gapToleranceSec?: number
  /** これ未満の区間は破棄する(秒) */
  minDurationSec?: number
}

const DEFAULT_GAP_TOLERANCE_SEC = 0.18
const DEFAULT_MIN_DURATION_SEC = 0.12

/**
 * 有声フレームの連続をフレーズ区間としてまとめる(§4.4.6)。
 * 短い無声ギャップ(既定0.18秒以下)は結合し、極端に短い区間(既定0.12秒未満)は破棄する。
 */
export function detectPhrases(frames: PitchFrame[], hopSec: number, options: PhraseDetectionOptions = {}): Phrase[] {
  const gapTolerance = options.gapToleranceSec ?? DEFAULT_GAP_TOLERANCE_SEC
  const minDuration = options.minDurationSec ?? DEFAULT_MIN_DURATION_SEC

  const rawPhrases: Phrase[] = []
  let current: Phrase | null = null
  let gapStart: number | null = null

  for (const f of frames) {
    if (!f.voiced) {
      if (current !== null && gapStart === null) gapStart = f.timeSec
      continue
    }

    if (current === null) {
      current = { start: f.timeSec, end: f.timeSec + hopSec }
      continue
    }

    if (gapStart !== null) {
      const gapDuration = f.timeSec - gapStart
      if (gapDuration > gapTolerance) {
        rawPhrases.push(current)
        current = { start: f.timeSec, end: f.timeSec + hopSec }
        gapStart = null
        continue
      }
      gapStart = null
    }

    current.end = f.timeSec + hopSec
  }
  if (current) rawPhrases.push(current)

  return rawPhrases.filter((p) => p.end - p.start >= minDuration)
}
