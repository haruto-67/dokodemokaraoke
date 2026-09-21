import { describe, expect, it } from 'vitest'
import { scorePerformance, type SungPitchSample } from './scoring'
import type { DokokaraNote } from '../types'

const A4 = 440 // MIDI69
const A5 = 880 // MIDI81(1オクターブ上)
const C5 = 523.2511306011972 // MIDI72(3半音上、toleranceを超える差)

function note(start: number, end: number, pitchMidi = 69): DokokaraNote {
  return { start, end, pitchMidi, amplitude: 1 }
}

describe('scorePerformance', () => {
  it('ノート区間内で完全に一致するピッチだけを歌った場合、accuracyが1になる', () => {
    const notes = [note(0, 1)]
    const sungPitch: SungPitchSample[] = [{ timeSec: 0.5, hz: A4 }]
    const result = scorePerformance(notes, sungPitch)
    expect(result.notes[0].accuracy).toBe(1)
  })

  it('オクターブ違いでもaccuracyが1になる(オクターブ違いは一致として扱う仕様)', () => {
    const notes = [note(0, 1)]
    const sungPitch: SungPitchSample[] = [{ timeSec: 0.5, hz: A5 }]
    const result = scorePerformance(notes, sungPitch)
    expect(result.notes[0].accuracy).toBe(1)
  })

  it('tolerance(既定1半音)を超える差のピッチを歌った場合、accuracyが0になる', () => {
    const notes = [note(0, 1)]
    const sungPitch: SungPitchSample[] = [{ timeSec: 0.5, hz: C5 }] // 3半音違い
    const result = scorePerformance(notes, sungPitch)
    expect(result.notes[0].accuracy).toBe(0)
  })

  it('ノート区間内に有声サンプルが1つも無い場合、accuracyが0になる(歌わなかった扱い)', () => {
    const notes = [note(0, 1)]
    const sungPitch: SungPitchSample[] = [{ timeSec: 0.5, hz: 0 }] // 無声
    const result = scorePerformance(notes, sungPitch)
    expect(result.notes[0].accuracy).toBe(0)
  })

  it('ノート区間の外のサンプルは結果に一切影響しない', () => {
    const notes = [note(0, 1)]
    const withOutsideNoise: SungPitchSample[] = [
      { timeSec: 0.5, hz: A4 },
      { timeSec: 5, hz: C5 } // ノート区間外(どのノートにも属さない時刻)の全く違うピッチ
    ]
    const withoutOutsideNoise: SungPitchSample[] = [{ timeSec: 0.5, hz: A4 }]
    const resultWith = scorePerformance(notes, withOutsideNoise)
    const resultWithout = scorePerformance(notes, withoutOutsideNoise)
    expect(resultWith.notes[0].accuracy).toBe(resultWithout.notes[0].accuracy)
    expect(resultWith.totalScore).toBe(resultWithout.totalScore)
  })

  it('1つのノート内で一部だけ正解・一部だけ不正解の場合、accuracyが中間の値になる', () => {
    const notes = [note(0, 1)]
    const sungPitch: SungPitchSample[] = [
      { timeSec: 0.25, hz: A4 }, // 正解
      { timeSec: 0.75, hz: C5 } // 不正解
    ]
    const result = scorePerformance(notes, sungPitch)
    expect(result.notes[0].accuracy).toBe(0.5)
  })

  it('複数ノートがある場合、totalScoreは単純平均ではなくノートの長さで重み付けした平均になる', () => {
    // 短いノート(長さ1、歌わなかった=accuracy0)と、圧倒的に長いノート(長さ9、accuracy1)。
    // 単純平均なら50になるが、長さで重み付けすると90になるはず。
    const notes = [note(0, 1), note(1, 10)]
    const sungPitch: SungPitchSample[] = [{ timeSec: 5, hz: A4 }]
    const result = scorePerformance(notes, sungPitch)
    expect(result.notes[0].accuracy).toBe(0)
    expect(result.notes[1].accuracy).toBe(1)
    expect(result.totalScore).toBeCloseTo(90, 5)
  })

  it('notes配列が空の場合、totalScoreが0になる(ゼロ除算を避ける)', () => {
    const result = scorePerformance([], [{ timeSec: 0.5, hz: A4 }])
    expect(result.totalScore).toBe(0)
    expect(result.notes).toEqual([])
  })

  it('toleranceSemitonesオプションを変更すると、境界付近のサンプルの判定が変わる', () => {
    // A4から0.7半音だけずれたピッチ。既定tolerance(1.0)では正解、0.5に狭めると不正解になる。
    const slightlyOffHz = 440 * Math.pow(2, 0.7 / 12)
    const notes = [note(0, 1)]
    const sungPitch: SungPitchSample[] = [{ timeSec: 0.5, hz: slightlyOffHz }]
    const withDefaultTolerance = scorePerformance(notes, sungPitch)
    const withNarrowTolerance = scorePerformance(notes, sungPitch, { toleranceSemitones: 0.5 })
    expect(withDefaultTolerance.notes[0].accuracy).toBe(1)
    expect(withNarrowTolerance.notes[0].accuracy).toBe(0)
  })

  it('keySemitonesを指定すると、移調した分だけ歌唱ピッチとの比較基準がずれる', () => {
    // ノートはMIDI69(A4=440Hz)だが、2半音上げて歌う(キー+2)前提なので、
    // 歌唱ピッチはB4(MIDI71)相当のHzが正解になるはず。
    const notes = [note(0, 1, 69)]
    const bFlat4Hz = 440 * Math.pow(2, 2 / 12)
    const sungPitch: SungPitchSample[] = [{ timeSec: 0.5, hz: bFlat4Hz }]

    const withoutKeyShift = scorePerformance(notes, sungPitch)
    const withKeyShift = scorePerformance(notes, sungPitch, { keySemitones: 2 })

    expect(withoutKeyShift.notes[0].accuracy).toBe(0)
    expect(withKeyShift.notes[0].accuracy).toBe(1)
  })
})
