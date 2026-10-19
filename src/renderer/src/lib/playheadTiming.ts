// 再生バーの位置で、1文字(トークン)の開始・終了のタイミングを確定する

import type { DokokaraLine } from '@shared/types'

export type TokenEdge = 'start' | 'end'

export interface TokenRef {
  lineIndex: number
  tokenIndex: number
}

/** 文字の最小の長さ(秒)。これより短くなる位置には動かさない */
const MIN_TOKEN_SEC = 0.02
const EPS = 1e-6

/**
 * 時刻tで操作する文字を探す。tに重なっている文字があればそれを使う。
 * どの文字にも重なっていない(文字と文字のすき間にいる)時は、開始なら次の文字、終了なら直前の文字を使う
 * (すき間で押した時も「次の文字はここから」「前の文字はここまで」として延ばせるように)。
 */
export function findTokenForEdge(lines: DokokaraLine[], t: number, edge: TokenEdge): TokenRef | null {
  let before: (TokenRef & { end: number }) | null = null
  let after: (TokenRef & { start: number }) | null = null
  for (let li = 0; li < lines.length; li++) {
    const tokens = lines[li].tokens
    for (let ti = 0; ti < tokens.length; ti++) {
      const tok = tokens[ti]
      // 開始は[start, end)、終了は(start, end]で重なりを判定する(境界ちょうどで隣の文字を選ばないため)
      const covers = edge === 'start' ? tok.start - EPS <= t && t < tok.end - EPS : tok.start + EPS < t && t <= tok.end + EPS
      if (covers) return { lineIndex: li, tokenIndex: ti }
      if (tok.end <= t && (!before || tok.end > before.end)) before = { lineIndex: li, tokenIndex: ti, end: tok.end }
      if (tok.start >= t && (!after || tok.start < after.start)) after = { lineIndex: li, tokenIndex: ti, start: tok.start }
    }
  }
  const fallback = edge === 'start' ? after : before
  return fallback ? { lineIndex: fallback.lineIndex, tokenIndex: fallback.tokenIndex } : null
}

/**
 * 文字の開始(または終了)を時刻tにした歌詞を返す。動かせない時はnull。
 * - 接している隣の文字(境界を共有している)は、その境界も一緒に動かす(文字のドラッグと同じ扱い)
 * - 行の最初の文字の開始・最後の文字の終了なら、行の開始・終了も一緒に動かす。前後の行には重ねない
 * - どの文字も最小の長さを下回らない範囲に収める
 */
export function setTokenEdgeAt(
  lines: DokokaraLine[],
  ref: TokenRef,
  edge: TokenEdge,
  t: number
): DokokaraLine[] | null {
  const line = lines[ref.lineIndex]
  const tokens = line?.tokens
  const tok = tokens?.[ref.tokenIndex]
  if (!line || !tokens || !tok) return null
  const isFirst = ref.tokenIndex === 0
  const isLast = ref.tokenIndex === tokens.length - 1

  if (edge === 'start') {
    const prev = isFirst ? null : tokens[ref.tokenIndex - 1]
    const prevTouching = prev !== null && Math.abs(prev.end - tok.start) < EPS
    const prevLine = lines[ref.lineIndex - 1]
    let lo = -Infinity
    if (prev) lo = prevTouching ? prev.start + MIN_TOKEN_SEC : prev.end
    else if (prevLine) lo = prevLine.end
    else lo = 0
    const hi = tok.end - MIN_TOKEN_SEC
    if (lo > hi) return null
    const newStart = Math.max(lo, Math.min(hi, t))
    const newTokens = tokens.map((x, i) => {
      if (i === ref.tokenIndex) return { ...x, start: newStart }
      if (i === ref.tokenIndex - 1 && prevTouching) return { ...x, end: newStart }
      return x
    })
    const newLine = { ...line, tokens: newTokens, confidence: null, ...(isFirst ? { start: newStart } : {}) }
    return lines.map((l, i) => (i === ref.lineIndex ? newLine : l))
  }

  const next = isLast ? null : tokens[ref.tokenIndex + 1]
  const nextTouching = next !== null && Math.abs(next.start - tok.end) < EPS
  const nextLine = lines[ref.lineIndex + 1]
  const lo = tok.start + MIN_TOKEN_SEC
  let hi = Infinity
  if (next) hi = nextTouching ? next.end - MIN_TOKEN_SEC : next.start
  else if (nextLine) hi = nextLine.start
  if (lo > hi) return null
  const newEnd = Math.max(lo, Math.min(hi, t))
  const newTokens = tokens.map((x, i) => {
    if (i === ref.tokenIndex) return { ...x, end: newEnd }
    if (i === ref.tokenIndex + 1 && nextTouching) return { ...x, start: newEnd }
    return x
  })
  const newLine = { ...line, tokens: newTokens, confidence: null, ...(isLast ? { end: newEnd } : {}) }
  return lines.map((l, i) => (i === ref.lineIndex ? newLine : l))
}
