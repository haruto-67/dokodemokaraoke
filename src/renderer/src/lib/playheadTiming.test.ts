import { describe, expect, it } from 'vitest'
import type { DokokaraLine } from '@shared/types'
import { findTokenForEdge, setTokenEdgeAt } from './playheadTiming'

function line(id: string, spans: [number, number][]): DokokaraLine {
  return {
    id,
    text: id,
    start: spans[0][0],
    end: spans[spans.length - 1][1],
    confidence: 0.9,
    tokens: spans.map(([start, end], i) => ({ text: `${id}${i}`, ruby: null, start, end, locked: false }))
  }
}

// 1行目: [1,2][2,3] すき間 [3.5,4]、2行目: [5,6][6,7]
const lyrics = [line('a', [[1, 2], [2, 3], [3.5, 4]]), line('b', [[5, 6], [6, 7]])]

describe('findTokenForEdge', () => {
  it('再生バーが重なっている文字を返す', () => {
    expect(findTokenForEdge(lyrics, 1.5, 'start')).toEqual({ lineIndex: 0, tokenIndex: 0 })
    expect(findTokenForEdge(lyrics, 6.5, 'end')).toEqual({ lineIndex: 1, tokenIndex: 1 })
  })

  it('境界ちょうどでは、開始は後ろの文字・終了は前の文字を選ぶ', () => {
    expect(findTokenForEdge(lyrics, 2, 'start')).toEqual({ lineIndex: 0, tokenIndex: 1 })
    expect(findTokenForEdge(lyrics, 2, 'end')).toEqual({ lineIndex: 0, tokenIndex: 0 })
  })

  it('すき間では、開始は次の文字・終了は直前の文字を選ぶ(行をまたいでも)', () => {
    expect(findTokenForEdge(lyrics, 3.2, 'start')).toEqual({ lineIndex: 0, tokenIndex: 2 })
    expect(findTokenForEdge(lyrics, 3.2, 'end')).toEqual({ lineIndex: 0, tokenIndex: 1 })
    expect(findTokenForEdge(lyrics, 4.5, 'start')).toEqual({ lineIndex: 1, tokenIndex: 0 })
    expect(findTokenForEdge(lyrics, 4.5, 'end')).toEqual({ lineIndex: 0, tokenIndex: 2 })
  })

  it('前後に文字が無ければnull', () => {
    expect(findTokenForEdge(lyrics, 0.5, 'end')).toBeNull()
    expect(findTokenForEdge(lyrics, 8, 'start')).toBeNull()
  })
})

describe('setTokenEdgeAt', () => {
  it('開始を動かすと、接している前の文字の終了も追従する', () => {
    const r = setTokenEdgeAt(lyrics, { lineIndex: 0, tokenIndex: 1 }, 'start', 2.4)!
    expect(r[0].tokens[0].end).toBeCloseTo(2.4)
    expect(r[0].tokens[1].start).toBeCloseTo(2.4)
    expect(r[0].confidence).toBeNull()
    expect(r[1]).toBe(lyrics[1])
  })

  it('終了を動かすと、接している次の文字の開始も追従する', () => {
    const r = setTokenEdgeAt(lyrics, { lineIndex: 0, tokenIndex: 0 }, 'end', 1.6)!
    expect(r[0].tokens[0].end).toBeCloseTo(1.6)
    expect(r[0].tokens[1].start).toBeCloseTo(1.6)
  })

  it('離れている隣の文字は動かさず、そこまでしか延ばさない', () => {
    // 3文字目(3.5〜)の開始をすき間側へ: 2文字目の終了(3)までしか戻らない
    const r = setTokenEdgeAt(lyrics, { lineIndex: 0, tokenIndex: 2 }, 'start', 2.5)!
    expect(r[0].tokens[2].start).toBeCloseTo(3)
    expect(r[0].tokens[1].end).toBeCloseTo(3)
  })

  it('行の最初の文字の開始・最後の文字の終了は、行の開始・終了も動かす(前後の行には重ねない)', () => {
    const s = setTokenEdgeAt(lyrics, { lineIndex: 1, tokenIndex: 0 }, 'start', 4.5)!
    expect(s[1].start).toBeCloseTo(4.5)
    expect(s[1].tokens[0].start).toBeCloseTo(4.5)
    const clamped = setTokenEdgeAt(lyrics, { lineIndex: 1, tokenIndex: 0 }, 'start', 3)!
    expect(clamped[1].start).toBeCloseTo(4)
    const e = setTokenEdgeAt(lyrics, { lineIndex: 0, tokenIndex: 2 }, 'end', 4.6)!
    expect(e[0].end).toBeCloseTo(4.6)
    expect(setTokenEdgeAt(lyrics, { lineIndex: 0, tokenIndex: 2 }, 'end', 9)![0].end).toBeCloseTo(5)
  })

  it('文字が最小の長さより短くなる位置には動かさない', () => {
    const r = setTokenEdgeAt(lyrics, { lineIndex: 0, tokenIndex: 0 }, 'start', 2.5)!
    expect(r[0].tokens[0].start).toBeCloseTo(1.98)
  })
})
