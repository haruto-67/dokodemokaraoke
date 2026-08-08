import { describe, expect, it } from 'vitest'
import { detectPhrases } from './phrase'
import type { PitchFrame } from './pitch'

const HOP = 0.01

function buildFrames(pattern: boolean[], hopSec = HOP): PitchFrame[] {
  return pattern.map((voiced, i) => ({ timeSec: i * hopSec, hz: voiced ? 200 : 0, voiced }))
}

describe('detectPhrases', () => {
  it('連続する有声フレームは1つのフレーズになる', () => {
    const frames = buildFrames(Array(20).fill(true))
    const phrases = detectPhrases(frames, HOP, { minDurationSec: 0 })
    expect(phrases.length).toBe(1)
    expect(phrases[0].start).toBeCloseTo(0, 5)
    expect(phrases[0].end).toBeCloseTo(20 * HOP, 5)
  })

  it('短い無声ギャップ(既定0.18秒以下)は結合する', () => {
    // 有声10フレーム、無声10フレーム(=0.1秒ギャップ)、有声10フレーム
    const frames = buildFrames([...Array(10).fill(true), ...Array(10).fill(false), ...Array(10).fill(true)])
    const phrases = detectPhrases(frames, HOP, { minDurationSec: 0 })
    expect(phrases.length).toBe(1)
  })

  it('長い無声ギャップ(既定0.18秒超)は分割する', () => {
    // 無声30フレーム = 0.3秒ギャップ(既定0.18秒を超える)
    const frames = buildFrames([...Array(10).fill(true), ...Array(30).fill(false), ...Array(10).fill(true)])
    const phrases = detectPhrases(frames, HOP, { minDurationSec: 0 })
    expect(phrases.length).toBe(2)
  })

  it('極端に短い区間(既定0.12秒未満)は破棄する', () => {
    // 5フレーム = 0.05秒(既定の最小区間0.12秒未満)
    const frames = buildFrames(Array(5).fill(true))
    const phrases = detectPhrases(frames, HOP)
    expect(phrases.length).toBe(0)
  })

  it('有声フレームが無ければ空配列を返す', () => {
    const frames = buildFrames(Array(20).fill(false))
    expect(detectPhrases(frames, HOP)).toEqual([])
  })

  it('カスタムのgapToleranceSec/minDurationSecを適用できる', () => {
    // ギャップ0.05秒(5フレーム)。既定なら結合されるがtoleranceを0.02秒にすると分割される
    const frames = buildFrames([...Array(10).fill(true), ...Array(5).fill(false), ...Array(10).fill(true)])
    const phrases = detectPhrases(frames, HOP, { gapToleranceSec: 0.02, minDurationSec: 0 })
    expect(phrases.length).toBe(2)
  })
})
