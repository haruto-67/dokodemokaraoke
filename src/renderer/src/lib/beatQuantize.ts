// 歌詞の文字の開始を、曲のテンポ(拍の格子)に合わせる
//
// 解析(python/sidecar/vowel_align.py)は音だけを手がかりに配置するため、文字の開始は拍の格子の前後に
// ばらつく。手修正後の正解(いないいないばあ_ショート2)では文字の開始は188BPMの8分音符の格子に
// 平均0.004秒で乗っており、解析結果の75%のモーラは正解から格子の半分以内にあった。
// そこで格子の近くにある開始だけを格子へ寄せる(遠いものは音の聞き取りの誤りなので動かさない)。

import type { DokokaraLine } from '@shared/types'
import { bpmAt, nearestBeatGridTime, type Rhythm } from './tempo'

/** 文字の最小の長さ(秒) */
const MIN_TOKEN_SEC = 0.02
/** 格子の間隔に対して、これより遠い開始は寄せない */
const MAX_SHIFT_RATIO = 0.45
const EPS = 1e-6
const DIVISIONS = [1, 2, 4]

/**
 * 歌詞のリズムに合う拍の分割数(1=4分音符, 2=8分音符, 4=16分音符)。
 * 行の中で隣り合う文字の開始の間隔のうち短い方(下から25%)に、格子の間隔が最も近いものを選ぶ
 * (よく出る短い音符の長さ=格子の1目盛り、とみなす)。
 */
export function autoBeatDivision(lines: DokokaraLine[], rhythm: Rhythm): number {
  const gaps: number[] = []
  for (const line of lines) {
    for (let i = 1; i < line.tokens.length; i++) {
      const gap = line.tokens[i].start - line.tokens[i - 1].start
      if (gap > 0.03) gaps.push(gap)
    }
  }
  if (gaps.length === 0 || rhythm.bpm <= 0) return 2
  gaps.sort((a, b) => a - b)
  const short = gaps[Math.floor(gaps.length * 0.25)]
  const beatSec = 60 / bpmAt(rhythm, lines[0]?.start ?? 0)
  let best = 2
  let bestDist = Infinity
  for (const d of DIVISIONS) {
    const dist = Math.abs(Math.log(beatSec / d / short))
    if (dist < bestDist) {
      bestDist = dist
      best = d
    }
  }
  return best
}

/**
 * 各文字の開始を最寄りの格子へ寄せた歌詞を返す。
 * - 格子の間隔のMAX_SHIFT_RATIOより遠い開始・ロックした文字は動かさない
 * - 前の文字と接していた終了は、次の文字の新しい開始に追従させる(すき間は残す)
 * - 文字の順序・最小の長さ・前後の行との重なりを崩す位置には寄せない
 */
export function quantizeLyricsToBeats(lines: DokokaraLine[], rhythm: Rhythm, division: number): DokokaraLine[] {
  if (division <= 0 || rhythm.bpm <= 0) return lines
  const result: DokokaraLine[] = []
  lines.forEach((line, li) => {
    const tokens = line.tokens
    if (tokens.length === 0) {
      result.push(line)
      return
    }
    const prevEnd = li > 0 ? result[li - 1].end : -Infinity
    const nextStart = li + 1 < lines.length ? lines[li + 1].start : Infinity

    const starts = tokens.map((t) => t.start)
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].locked) continue
      const s = tokens[i].start
      const g = nearestBeatGridTime(s, rhythm, division)
      const step = 60 / bpmAt(rhythm, s) / division
      if (Math.abs(g - s) > step * MAX_SHIFT_RATIO) continue
      const lower = i > 0 ? starts[i - 1] + MIN_TOKEN_SEC : prevEnd
      const upper = i + 1 < tokens.length ? tokens[i + 1].end - 2 * MIN_TOKEN_SEC : nextStart - MIN_TOKEN_SEC
      if (g < lower - EPS || g > upper + EPS) continue
      starts[i] = g
    }

    const newTokens = tokens.map((t, i) => {
      const start = starts[i]
      const isLast = i === tokens.length - 1
      const touching = !isLast && Math.abs(t.end - tokens[i + 1].start) < EPS
      let end: number
      if (touching) end = starts[i + 1]
      else {
        const limit = isLast ? nextStart : starts[i + 1]
        end = Math.min(Math.max(t.end, start + MIN_TOKEN_SEC), limit)
      }
      return start === t.start && end === t.end ? t : { ...t, start, end }
    })
    const changed = newTokens.some((t, i) => t !== tokens[i])
    result.push(
      changed
        ? { ...line, tokens: newTokens, start: newTokens[0].start, end: newTokens[newTokens.length - 1].end }
        : line
    )
  })
  return result
}
