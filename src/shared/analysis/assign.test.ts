import { describe, expect, it } from 'vitest'
import { assignPhrasesToLines } from './assign'

describe('assignPhrasesToLines', () => {
  it('フレーズ数と行数が一致する場合はそのまま1:1で割り当てる', () => {
    const phrases = [
      { start: 0, end: 1 },
      { start: 2, end: 3 }
    ]
    const result = assignPhrasesToLines(phrases, [3, 3], 10)
    expect(result).toEqual(phrases)
  })

  it('フレーズが検出できない場合は楽曲全体を行数で均等分割する', () => {
    const result = assignPhrasesToLines([], [5, 3, 10], 9)
    expect(result).toEqual([
      { start: 0, end: 3 },
      { start: 3, end: 6 },
      { start: 6, end: 9 }
    ])
  })

  it('フレーズ数 > 行数: ギャップが最小の隣接区間から順に統合する', () => {
    // 3フレーズ、2行。フレーズ0-1間のギャップ(1.0)よりフレーズ1-2間のギャップ(0.1)の方が小さいので
    // フレーズ1,2が統合される
    const phrases = [
      { start: 0, end: 1 }, // gap to next: 2-1=1.0
      { start: 2, end: 3 }, // gap to next: 3.1-3=0.1
      { start: 3.1, end: 4 }
    ]
    const result = assignPhrasesToLines(phrases, [3, 3], 10)
    expect(result).toEqual([
      { start: 0, end: 1 },
      { start: 2, end: 4 }
    ])
  })

  it('フレーズ数 < 行数: 最も長い区間をモーラ数比で分割する', () => {
    // 1フレーズ(長さ10)、2行(重み1:3)
    const phrases = [{ start: 0, end: 10 }]
    const result = assignPhrasesToLines(phrases, [1, 3], 10)
    expect(result.length).toBe(2)
    expect(result[0].start).toBeCloseTo(0)
    expect(result[0].end).toBeCloseTo(2.5) // 10 * 1/4
    expect(result[1].start).toBeCloseTo(2.5)
    expect(result[1].end).toBeCloseTo(10)
  })

  it('フレーズ数 < 行数かつ複数フレーズある場合、最も長い区間から優先的に分割される', () => {
    // フレーズA(長さ1) フレーズB(長さ9)。3行必要なので1回分割が必要 → 長い方(B)が分割される
    const phrases = [
      { start: 0, end: 1 },
      { start: 5, end: 14 }
    ]
    const result = assignPhrasesToLines(phrases, [1, 1, 1], 20)
    expect(result.length).toBe(3)
    expect(result[0]).toEqual({ start: 0, end: 1 })
    // フレーズBが2分割される
    expect(result[1].start).toBeCloseTo(5)
    expect(result[2].end).toBeCloseTo(14)
  })

  it('行数0の場合は空配列を返す', () => {
    expect(assignPhrasesToLines([{ start: 0, end: 1 }], [], 10)).toEqual([])
  })
})
