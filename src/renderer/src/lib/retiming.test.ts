import { describe, expect, it } from 'vitest'
import { rescaleTokensExcludingLocked, reallocateRespectingLocks } from './retiming'
import type { DokokaraToken } from '@shared/types'

function tok(text: string, start: number, end: number, locked = false): DokokaraToken {
  return { text, ruby: null, start, end, locked }
}

describe('rescaleTokensExcludingLocked', () => {
  it('ロックが無ければ全トークンが比率を保って伸縮する', () => {
    // 元: [0,1),[1,2) (1:1比率) を [0,6) へ拡大 → [0,3),[3,6)
    const tokens = [tok('あ', 0, 1), tok('い', 1, 2)]
    const result = rescaleTokensExcludingLocked(tokens, 0, 6)
    expect(result[0]).toMatchObject({ start: 0, end: 3 })
    expect(result[1]).toMatchObject({ start: 3, end: 6 })
  })

  it('ロック済みトークンは長さを変えない', () => {
    // [0,1)(ロック), [1,2), [2,3) を [0,10) へ拡大
    // ロック分1秒を除いた残り9秒を、元2秒分の2トークンで按分 → 各4.5秒
    const tokens = [tok('あ', 0, 1, true), tok('い', 1, 2), tok('う', 2, 3)]
    const result = rescaleTokensExcludingLocked(tokens, 0, 10)
    expect(result[0].end - result[0].start).toBeCloseTo(1) // ロック分は不変
    expect(result[1].end - result[1].start).toBeCloseTo(4.5)
    expect(result[2].end - result[2].start).toBeCloseTo(4.5)
    expect(result[2].end).toBe(10)
  })

  it('先頭トークンのstartと末尾トークンのendは常に新しい行範囲に一致する', () => {
    const tokens = [tok('あ', 0, 1), tok('い', 1, 3), tok('う', 3, 4)]
    const result = rescaleTokensExcludingLocked(tokens, 2, 12)
    expect(result[0].start).toBe(2)
    expect(result[result.length - 1].end).toBe(12)
  })

  it('トークンが無ければ空配列を返す', () => {
    expect(rescaleTokensExcludingLocked([], 0, 5)).toEqual([])
  })
})

describe('reallocateRespectingLocks', () => {
  it('ロックが無ければ行全体を通常の初期配分アルゴリズムで再配分する', () => {
    const tokens = [tok('あ', 0, 0.5), tok('い', 0.5, 0.9)]
    const result = reallocateRespectingLocks(tokens, 0, 10, [], [])
    expect(result[0].start).toBe(0)
    expect(result[result.length - 1].end).toBe(10)
    expect(result.every((t) => !t.locked)).toBe(true)
  })

  it('ロック済みトークンの位置・長さは変更されない', () => {
    const tokens = [tok('あ', 0, 1), tok('い', 1, 2, true), tok('う', 2, 3)]
    const result = reallocateRespectingLocks(tokens, 0, 9, [], [])
    expect(result[1]).toEqual(tokens[1])
  })

  it('ロックされていない区間はロック区間の間でだけ再配分される', () => {
    const tokens = [tok('あ', 0, 1), tok('い', 1, 2, true), tok('う', 2, 2.5), tok('え', 2.5, 3)]
    const result = reallocateRespectingLocks(tokens, 0, 9, [], [])
    // 先頭区間(あ)はロック開始(1)まで、末尾区間(う,え)はロック終了(2)から行末(9)まで
    expect(result[0].start).toBe(0)
    expect(result[0].end).toBe(1)
    expect(result[2].start).toBe(2)
    expect(result[3].end).toBe(9)
  })

  it('トークンが無ければ空配列を返す', () => {
    expect(reallocateRespectingLocks([], 0, 5, [], [])).toEqual([])
  })
})
