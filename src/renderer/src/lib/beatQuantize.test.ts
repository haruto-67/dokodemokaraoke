import { describe, expect, it } from 'vitest'
import type { DokokaraLine } from '@shared/types'
import { autoBeatDivision, quantizeLyricsToBeats } from './beatQuantize'

function line(id: string, spans: [number, number][], locked: boolean[] = []): DokokaraLine {
  return {
    id,
    text: id,
    start: spans[0][0],
    end: spans[spans.length - 1][1],
    confidence: 0.9,
    tokens: spans.map(([start, end], i) => ({ text: `${id}${i}`, ruby: null, start, end, locked: locked[i] ?? false }))
  }
}

// 120BPM: 拍は0.5秒ごと、8分音符は0.25秒ごと
const rhythm = { bpm: 120, firstBeatSec: 0 }

describe('quantizeLyricsToBeats', () => {
  it('格子の近くの開始を寄せ、接していた前の文字の終了も追従させる', () => {
    const r = quantizeLyricsToBeats([line('a', [[1.03, 1.27], [1.27, 1.48], [1.48, 2]])], rhythm, 2)
    expect(r[0].tokens.map((t) => t.start)).toEqual([1, 1.25, 1.5])
    expect(r[0].tokens.map((t) => t.end)).toEqual([1.25, 1.5, 2])
    expect(r[0].start).toBe(1)
  })

  it('格子から遠い開始は動かさない(音の聞き取りの誤りかもしれないため)', () => {
    const r = quantizeLyricsToBeats([line('a', [[1.12, 1.4], [1.4, 2]])], rhythm, 2)
    expect(r[0].tokens[0].start).toBeCloseTo(1.12)
  })

  it('息継ぎのすき間は残す', () => {
    const r = quantizeLyricsToBeats([line('a', [[1.02, 1.3], [1.77, 2]])], rhythm, 2)
    expect(r[0].tokens[0]).toMatchObject({ start: 1, end: 1.3 })
    expect(r[0].tokens[1].start).toBeCloseTo(1.75)
  })

  it('ロックした文字と、前の行に重なる位置へは寄せない', () => {
    const r = quantizeLyricsToBeats([line('a', [[0.4, 1.02]]), line('b', [[1.03, 1.5]], [true])], rhythm, 2)
    expect(r[1].tokens[0].start).toBeCloseTo(1.03)
    const r2 = quantizeLyricsToBeats([line('a', [[0.4, 1.02]]), line('b', [[1.03, 1.5]])], rhythm, 2)
    // 1.0へ寄せると前の行(〜1.02)に重なるため寄せない
    expect(r2[1].tokens[0].start).toBeCloseTo(1.03)
  })
})

describe('autoBeatDivision', () => {
  it('よく出る短い間隔に最も近い格子を選ぶ', () => {
    const eighths = line('a', [[0, 0.25], [0.25, 0.5], [0.5, 0.75], [0.75, 1.25], [1.25, 1.5]])
    expect(autoBeatDivision([eighths], rhythm)).toBe(2)
    const quarters = line('b', [[0, 0.5], [0.5, 1], [1, 1.5], [1.5, 2.5]])
    expect(autoBeatDivision([quarters], rhythm)).toBe(1)
  })
})
