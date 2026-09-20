import { describe, expect, it } from 'vitest'
import { scoreForLine } from './scoreLines'
import type { DokokaraLine } from '@shared/types'
import type { NoteScoreBreakdown } from '@shared/analysis/scoring'

function line(start: number, end: number): DokokaraLine {
  return { id: 'l1', text: '', start, end, tokens: [], confidence: null }
}
function breakdown(start: number, end: number, accuracy: number): NoteScoreBreakdown {
  return { note: { start, end, pitchMidi: 69, amplitude: 1 }, accuracy }
}

describe('scoreForLine', () => {
  it('行と重なるノートが1つの場合、そのaccuracyをそのまま100点満点で返す', () => {
    const result = scoreForLine(line(0, 2), [breakdown(0, 2, 0.75)])
    expect(result).toBeCloseTo(75)
  })

  it('複数ノートがある場合、ノートの長さで重み付けした平均になる', () => {
    const result = scoreForLine(line(0, 10), [breakdown(0, 1, 0), breakdown(1, 10, 1)])
    expect(result).toBeCloseTo(90)
  })

  it('行と重ならないノートは無視する', () => {
    const withUnrelated = scoreForLine(line(0, 1), [breakdown(0, 1, 1), breakdown(5, 6, 0)])
    const withoutUnrelated = scoreForLine(line(0, 1), [breakdown(0, 1, 1)])
    expect(withUnrelated).toBe(withoutUnrelated)
  })

  it('重なるノートが1つも無い行はnullを返す', () => {
    const result = scoreForLine(line(10, 11), [breakdown(0, 1, 1)])
    expect(result).toBeNull()
  })

  it('部分的に重なるノートも含める(行の一部にかかっているだけでも対象にする)', () => {
    // ノートは0.5〜1.5秒、行は0〜1秒 → 重なりはあるので対象になる
    const result = scoreForLine(line(0, 1), [breakdown(0.5, 1.5, 1)])
    expect(result).toBeCloseTo(100)
  })
})
