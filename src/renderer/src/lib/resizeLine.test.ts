import { describe, expect, it } from 'vitest'
import { resizeLineTokens } from './resizeLine'
import type { DokokaraToken } from '@shared/types'

function tk(start: number, end: number): DokokaraToken {
  return { text: 'あ', ruby: null, start, end, locked: false }
}

function expectTimings(result: DokokaraToken[], expected: [number, number][]): void {
  expect(result).toHaveLength(expected.length)
  result.forEach((t, i) => {
    expect(t.start).toBeCloseTo(expected[i][0])
    expect(t.end).toBeCloseTo(expected[i][1])
  })
}

describe('resizeLineTokens', () => {
  it('行を広げてもトークンは動かない(広がった分は空白になる)', () => {
    const result = resizeLineTokens([tk(0, 1), tk(1, 2), tk(2, 3)], -1, 5)
    expectTimings(result, [
      [0, 1],
      [1, 2],
      [2, 3]
    ])
  })

  it('右端を少し縮めると最後の文字だけが縮む', () => {
    const result = resizeLineTokens([tk(0, 1), tk(1, 2), tk(2, 3)], 0, 2.5)
    expectTimings(result, [
      [0, 1],
      [1, 2],
      [2, 2.5]
    ])
  })

  it('右端を大きく縮めると巻き込まれた文字だけが比率を保って縮む', () => {
    const result = resizeLineTokens([tk(0, 1), tk(1, 2), tk(2, 3)], 0, 1.5)
    expectTimings(result, [
      [0, 1],
      [1, 1.25],
      [1.25, 1.5]
    ])
  })

  it('左端を縮めると先頭の文字だけが縮む', () => {
    const result = resizeLineTokens([tk(0, 1), tk(1, 2), tk(2, 3)], 0.5, 3)
    expectTimings(result, [
      [0.5, 1],
      [1, 2],
      [2, 3]
    ])
  })

  it('範囲の完全に外にある文字は最小長で端に寄せる', () => {
    const result = resizeLineTokens([tk(0, 1), tk(1, 2), tk(4, 5)], 0, 3)
    expectTimings(result, [
      [0, 1],
      [1, 2],
      [2.98, 3]
    ])
  })

  it('入力配列を破壊しない', () => {
    const tokens = [tk(0, 1), tk(1, 2), tk(2, 3)]
    resizeLineTokens(tokens, 0, 1.5)
    expect(tokens[2]).toEqual(tk(2, 3))
  })

  it('空配列なら空配列を返す', () => {
    expect(resizeLineTokens([], 0, 1)).toEqual([])
  })
})
