import { describe, expect, it } from 'vitest'
import { computeTokenPitchesMidi } from './tokenPitch'
import type { DokokaraNote } from '../types'

function note(start: number, end: number, pitchMidi: number): DokokaraNote {
  return { start, end, pitchMidi, amplitude: 1 }
}

describe('computeTokenPitchesMidi', () => {
  it('トークンの範囲と完全に一致するノートが1つなら、そのpitchMidiをそのまま返す', () => {
    const result = computeTokenPitchesMidi([{ start: 0, end: 1 }], [note(0, 1, 69)])
    expect(result).toEqual([69])
  })

  it('複数ノートが重なる場合、重なり時間で重み付け平均する', () => {
    // トークン0〜1秒に対し、0〜0.25(midi60)と0.25〜1(midi72)が重なる → (60*0.25+72*0.75)/1=69
    const result = computeTokenPitchesMidi([{ start: 0, end: 1 }], [note(0, 0.25, 60), note(0.25, 1, 72)])
    expect(result[0]).toBeCloseTo(69)
  })

  it('重なるノートが無いトークンはnullを返す', () => {
    const result = computeTokenPitchesMidi([{ start: 5, end: 6 }], [note(0, 1, 69)])
    expect(result).toEqual([null])
  })

  it('トークン範囲外のノートは重みに含めない', () => {
    const withUnrelated = computeTokenPitchesMidi([{ start: 0, end: 1 }], [note(0, 1, 69), note(10, 11, 40)])
    const withoutUnrelated = computeTokenPitchesMidi([{ start: 0, end: 1 }], [note(0, 1, 69)])
    expect(withUnrelated).toEqual(withoutUnrelated)
  })

  it('複数トークンをまとめて処理し、順序を保ったまま返す', () => {
    const result = computeTokenPitchesMidi(
      [
        { start: 0, end: 0.5 },
        { start: 0.5, end: 1 },
        { start: 2, end: 3 }
      ],
      [note(0, 0.5, 60), note(0.5, 1, 64)]
    )
    expect(result).toEqual([60, 64, null])
  })

  it('start >= endの不正なトークン範囲はnullを返す(ゼロ幅の区切り行等)', () => {
    const result = computeTokenPitchesMidi([{ start: 1, end: 1 }], [note(0, 2, 69)])
    expect(result).toEqual([null])
  })
})
