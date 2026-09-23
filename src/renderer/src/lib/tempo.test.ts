import { describe, expect, it } from 'vitest'
import { beatGridTimes, estimateTempo, nearestBeatGridTime, onsetStrengthEnvelope } from './tempo'

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
