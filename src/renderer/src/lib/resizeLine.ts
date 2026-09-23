// 行(フレーズ)ブロックの端ドラッグによる長さ変更時のトークン再配置
import type { DokokaraToken } from '@shared/types'

/**
 * 行の長さを変えた時のトークン再配置。均等割り付け(全体の比例伸縮)はしない。
 * - 広げる方向: トークンは一切動かさない(広がった部分は文字の無い空白になる。文字タイミングは人が詰める前提)。
 * - 縮める方向: 新しい行範囲からはみ出す(巻き込まれる)トークンだけを縮める。
 * 手で調整済みの文字タイミングを、行末だけ直したいのに崩してしまう不具合への対応。
 */
export function resizeLineTokens(
  tokens: DokokaraToken[],
  newStart: number,
  newEnd: number,
  minTokenSec = 0.02
): DokokaraToken[] {
  if (tokens.length === 0) return []
  const leftFixed = mirror(squeezeIntoEnd(mirror(tokens), -newStart, -newEnd, minTokenSec))
  return squeezeIntoEnd(leftFixed, newEnd, newStart, minTokenSec)
}

/** 時刻を反転し並びも逆順にする(左端の処理を右端の処理で済ませるため)。2回適用で元に戻る。 */
function mirror(tokens: DokokaraToken[]): DokokaraToken[] {
  return tokens.map((t) => ({ ...t, start: -t.end, end: -t.start })).reverse()
}

/** limitEnd より後ろにはみ出したトークン群だけを、元の比率を保ったまま limitEnd までに収める。 */
function squeezeIntoEnd(tokens: DokokaraToken[], limitEnd: number, limitStart: number, minTokenSec: number): DokokaraToken[] {
  let k = tokens.findIndex((t) => t.end > limitEnd)
  if (k === -1) return tokens.map((t) => ({ ...t }))

  const last = tokens.length - 1
  const groupNewStart = (from: number): number => Math.min(tokens[from].start, limitEnd - (last - from + 1) * minTokenSec)
  let gNewStart = groupNewStart(k)
  while (k > 0 && gNewStart < tokens[k - 1].end) {
    k--
    gNewStart = groupNewStart(k)
  }
  gNewStart = Math.max(gNewStart, Math.min(limitStart, limitEnd))

  const gOldStart = tokens[k].start
  const gOldEnd = tokens[last].end
  const oldSpan = gOldEnd - gOldStart
  const newSpan = limitEnd - gNewStart
  const count = last - k + 1
  return tokens.map((t, i) => {
    if (i < k) return { ...t }
    if (oldSpan <= 0) {
      const step = newSpan / count
      return { ...t, start: gNewStart + (i - k) * step, end: gNewStart + (i - k + 1) * step }
    }
    const map = (x: number): number => gNewStart + ((x - gOldStart) * newSpan) / oldSpan
    return { ...t, start: map(t.start), end: i === last ? limitEnd : map(t.end) }
  })
}
