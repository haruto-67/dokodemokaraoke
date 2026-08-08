// 編集画面での行リサイズ・再配分に使う純粋関数群(§4.6.4)
import { allocateTokenTimings } from '@shared/analysis/allocate'
import type { DokokaraToken } from '@shared/types'

/**
 * 行の長さを変更したときのトークン再配置(§4.6.4)。
 * ロック済みトークンは「長さ」を変えず(位置はカーソル送りに合わせて動く)、
 * 残りの伸縮分をロックされていないトークンだけで比率を保って吸収する。
 */
export function rescaleTokensExcludingLocked(tokens: DokokaraToken[], newStart: number, newEnd: number): DokokaraToken[] {
  if (tokens.length === 0) return []

  const totalNew = Math.max(0, newEnd - newStart)
  const lockedDuration = tokens.filter((t) => t.locked).reduce((s, t) => s + (t.end - t.start), 0)
  const unlockedDurationOld = tokens.filter((t) => !t.locked).reduce((s, t) => s + (t.end - t.start), 0)
  const unlockedDurationNew = Math.max(0, totalNew - lockedDuration)
  const scale = unlockedDurationOld > 0 ? unlockedDurationNew / unlockedDurationOld : 0

  const result: DokokaraToken[] = []
  let cursor = newStart
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    const oldDuration = t.end - t.start
    const duration = t.locked ? oldDuration : oldDuration * scale
    const isLast = i === tokens.length - 1
    const end = isLast ? newEnd : cursor + duration
    result.push({ ...t, start: cursor, end })
    cursor = end
  }
  return result
}

/**
 * 「この行の文字タイミングを再配分」コマンド(§4.6.4)。
 * ロック済みトークンの位置・長さは変更しない。ロックされていない連続区間ごとに
 * 初期配分アルゴリズム(§4.6.3)を再適用する。
 */
export function reallocateRespectingLocks(
  tokens: DokokaraToken[],
  lineStart: number,
  lineEnd: number,
  onsetsSec: number[],
  pitchChangePoints: number[]
): DokokaraToken[] {
  if (tokens.length === 0) return []

  const result: DokokaraToken[] = new Array(tokens.length)
  let runStart = 0
  let rangeStart = lineStart

  const flushRun = (endIdxExclusive: number, rangeEnd: number): void => {
    if (endIdxExclusive <= runStart) return
    const run = tokens.slice(runStart, endIdxExclusive)
    const timed = allocateTokenTimings(
      run.map((t) => ({ text: t.text, ruby: t.ruby })),
      rangeStart,
      rangeEnd,
      { onsetsSec, pitchChangePoints }
    )
    for (let i = 0; i < run.length; i++) {
      result[runStart + i] = { ...run[i], start: timed[i].start, end: timed[i].end, locked: false }
    }
  }

  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].locked) {
      flushRun(i, tokens[i].start)
      result[i] = tokens[i]
      runStart = i + 1
      rangeStart = tokens[i].end
    }
  }
  flushRun(tokens.length, lineEnd)

  return result
}
