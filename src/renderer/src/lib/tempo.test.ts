import { describe, expect, it } from 'vitest'
import {
  addTempoChange,
  alignBeatAt,
  beatGridPoints,
  beatGridTimes,
  bpmAt,
  estimateTempo,
  moveSegmentStart,
  nearestBeatGridTime,
  normalizeRhythm,
  nudgeBeatsAt,
  onsetStrengthEnvelope,
  removeTempoChange,
  rhythmSegments,
  setBpmAt,
  type Rhythm
} from './tempo'

function clickTrack(bpm: number, offsetSec: number, durationSec: number, sampleRate = 22050): Float32Array {
  const buffer = new Float32Array(durationSec * sampleRate)
  for (let t = offsetSec; t < durationSec; t += 60 / bpm) {
    const start = Math.floor(t * sampleRate)
    for (let i = 0; i < 200 && start + i < buffer.length; i++) buffer[start + i] = 0.8
  }
  return buffer
}

describe('onsetStrengthEnvelope', () => {
  it('hopSizeごとに1フレームの強度列を返す', () => {
    const buffer = clickTrack(120, 0.25, 4)
    const { frameRate, envelope } = onsetStrengthEnvelope([buffer], 22050)
    expect(frameRate).toBe(22050 / 512)
    expect(envelope.length).toBe(Math.floor((4 * 22050) / 512))
  })
})

describe('estimateTempo', () => {
  it('120BPMのクリックからBPMと拍の位置を推定できる', () => {
    const buffer = clickTrack(120, 0.25, 20)
    const { frameRate, envelope } = onsetStrengthEnvelope([buffer], 22050)
    const r = estimateTempo(envelope, frameRate)
    expect(r).not.toBeNull()
    expect(Math.abs(r!.bpm - 120)).toBeLessThanOrEqual(1)
    expect(Math.abs(r!.firstBeatSec - 0.25)).toBeLessThanOrEqual(0.03)
  })

  it('100BPMのクリックからBPMを推定できる', () => {
    const buffer = clickTrack(100, 0.1, 20)
    const { frameRate, envelope } = onsetStrengthEnvelope([buffer], 22050)
    const r = estimateTempo(envelope, frameRate)
    expect(r).not.toBeNull()
    expect(Math.abs(r!.bpm - 100)).toBeLessThanOrEqual(1)
  })

  it('半拍後にも拍と同じ強さの音があれば倍のテンポにする(94BPMの表と裏 → 188BPM)', () => {
    const buffer = clickTrack(188, 0.1, 30)
    const { frameRate, envelope } = onsetStrengthEnvelope([buffer], 22050)
    const r = estimateTempo(envelope, frameRate)
    expect(r).not.toBeNull()
    expect(Math.abs(r!.bpm - 188)).toBeLessThanOrEqual(1)
  })

  it('1拍おきにしか音が無ければ半分のテンポにする(探索範囲より遅い60BPM)', () => {
    const buffer = clickTrack(60, 0.3, 30)
    const { frameRate, envelope } = onsetStrengthEnvelope([buffer], 22050)
    const r = estimateTempo(envelope, frameRate)
    expect(r).not.toBeNull()
    expect(Math.abs(r!.bpm - 60)).toBeLessThanOrEqual(1)
    expect(Math.abs(r!.firstBeatSec - 0.3)).toBeLessThanOrEqual(0.03)
  })

  it('短すぎる音声ではnullを返す', () => {
    expect(estimateTempo(new Float32Array(10), 43)).toBeNull()
  })
})

describe('beatGridTimes', () => {
  it('4分音符のグリッドを返す', () => {
    const result = beatGridTimes({ bpm: 120, firstBeatSec: 0.25 }, 1, 0, 2)
    const expected = [0.25, 0.75, 1.25, 1.75]
    expect(result).toHaveLength(expected.length)
    result.forEach((time, i) => expect(time).toBeCloseTo(expected[i]))
  })

  it('8分音符のグリッドは基準の拍より前にも並ぶ', () => {
    const result = beatGridTimes({ bpm: 120, firstBeatSec: 0.25 }, 2, 0, 1)
    const expected = [0, 0.25, 0.5, 0.75, 1]
    expect(result).toHaveLength(expected.length)
    result.forEach((time, i) => expect(time).toBeCloseTo(expected[i]))
  })

  it('分割数0なら空配列', () => {
    expect(beatGridTimes({ bpm: 120, firstBeatSec: 0.25 }, 0, 0, 1)).toEqual([])
  })
})

describe('nearestBeatGridTime', () => {
  it('最も近いグリッド時刻を返し、分割数0ならそのまま返す', () => {
    expect(nearestBeatGridTime(0.6, { bpm: 120, firstBeatSec: 0.25 }, 1)).toBeCloseTo(0.75)
    expect(nearestBeatGridTime(0.6, { bpm: 120, firstBeatSec: 0.25 }, 2)).toBeCloseTo(0.5)
    expect(nearestBeatGridTime(0.6, { bpm: 120, firstBeatSec: 0.25 }, 0)).toBeCloseTo(0.6)
  })
})

// 120BPM(0.5秒間隔)で始まり、2.0秒から60BPM(1秒間隔)に変わる
const withChange: Rhythm = { bpm: 120, firstBeatSec: 0, changes: [{ atSec: 2, bpm: 60 }] }

describe('テンポ変更', () => {
  it('区間ごとのBPMで拍が並ぶ', () => {
    const expected = [0, 0.5, 1, 1.5, 2, 3, 4]
    const result = beatGridTimes(withChange, 1, 0, 4)
    expect(result).toHaveLength(expected.length)
    result.forEach((time, i) => expect(time).toBeCloseTo(expected[i]))
  })

  it('区間の開始は拍の頭として印が付き、拍の分割も区間のBPMで行う', () => {
    const points = beatGridPoints(withChange, 2, 1.5, 3)
    expect(points.map((p) => p.time)).toEqual([1.5, 1.75, 2, 2.5, 3])
    expect(points.find((p) => p.time === 2)).toMatchObject({ onBeat: true, segmentStart: true })
    expect(points.find((p) => p.time === 2.5)).toMatchObject({ onBeat: false })
  })

  it('区間の途中で開始がずれていても、区間の開始から数える', () => {
    const r: Rhythm = { bpm: 120, firstBeatSec: 0, changes: [{ atSec: 2.2, bpm: 60 }] }
    // 最初の区間は2.0で終わらず2.2の直前まで(2.0は最初の区間の拍)、以降は2.2, 3.2, ...
    expect(beatGridTimes(r, 1, 1.9, 3.5).map((t) => Math.round(t * 100) / 100)).toEqual([2, 2.2, 3.2])
  })

  it('最寄りのグリッドは区間の境目をまたいで探す', () => {
    expect(nearestBeatGridTime(2.4, withChange, 1)).toBeCloseTo(2)
    expect(nearestBeatGridTime(2.7, withChange, 1)).toBeCloseTo(3)
    expect(nearestBeatGridTime(1.8, withChange, 1)).toBeCloseTo(2)
  })

  it('BPMは時刻を含む区間のものを返し、書き換えもその区間だけに効く', () => {
    expect(bpmAt(withChange, 1)).toBe(120)
    expect(bpmAt(withChange, 2.5)).toBe(60)
    expect(setBpmAt(withChange, 2.5, 90)).toEqual({ bpm: 120, firstBeatSec: 0, changes: [{ atSec: 2, bpm: 90 }] })
    expect(setBpmAt(withChange, 1, 100).bpm).toBe(100)
  })

  it('最初の拍より前のテンポ変更は無視する', () => {
    const r: Rhythm = { bpm: 120, firstBeatSec: 1, changes: [{ atSec: 0.5, bpm: 60 }] }
    expect(rhythmSegments(r)).toHaveLength(1)
    expect(normalizeRhythm(r)).toEqual({ bpm: 120, firstBeatSec: 1 })
  })

  it('テンポ変更を追加すると、その時点のBPMを引き継ぐ。最初の拍より前や既存の区間の開始と重なる時は追加しない', () => {
    expect(addTempoChange(withChange, 3.5)?.changes).toEqual([
      { atSec: 2, bpm: 60 },
      { atSec: 3.5, bpm: 60 }
    ])
    expect(addTempoChange(withChange, -1)).toBeNull()
    expect(addTempoChange(withChange, 2.01)).toBeNull()
  })

  it('テンポ変更を削除できる', () => {
    expect(removeTempoChange(withChange, 0).changes).toEqual([])
  })

  it('区間の開始は前後の区間を追い越さない', () => {
    const moved = moveSegmentStart(withChange, 0, -5)
    expect(moved.changes![0].atSec).toBeGreaterThan(0)
    expect(moveSegmentStart(withChange, null, 10).firstBeatSec).toBeLessThan(2)
  })

  it('拍を合わせると、再生位置を含む区間だけがずれる', () => {
    // 最初の区間: そのまま再生位置が最初の拍になる
    expect(alignBeatAt(withChange, 0.3).firstBeatSec).toBeCloseTo(0.3)
    // 後ろの区間: 開始が拍間隔の整数倍だけ戻った位置(元の開始に最も近い所)へ
    const aligned = alignBeatAt(withChange, 3.2)
    expect(aligned.firstBeatSec).toBe(0)
    expect(aligned.changes![0].atSec).toBeCloseTo(2.2)
  })

  it('拍を少しずらすと、再生位置を含む区間だけがずれる', () => {
    expect(nudgeBeatsAt(withChange, 1, 0.01).firstBeatSec).toBeCloseTo(0.01)
    expect(nudgeBeatsAt(withChange, 3, -0.05).changes![0].atSec).toBeCloseTo(1.95)
  })
})
