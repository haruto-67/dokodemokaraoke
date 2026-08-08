import { describe, expect, it } from 'vitest'
import { estimateAlignment } from './align'
import { whiteNoise, musicalSignal } from './testSignals'

const SAMPLE_RATE = 8000

describe('estimateAlignment', () => {
  it('完全に一致する信号はoffset=0・alignable=trueになる', () => {
    const signal = musicalSignal(SAMPLE_RATE * 2, SAMPLE_RATE)
    const result = estimateAlignment(signal, signal, SAMPLE_RATE)
    expect(result.offsetSamples).toBe(0)
    expect(result.alignable).toBe(true)
    expect(result.confidence).toBeGreaterThan(0.5)
  })

  it('playbackがNサンプル遅れている場合、offsetSamplesが+Nと推定される', () => {
    const base = musicalSignal(SAMPLE_RATE * 2, SAMPLE_RATE)
    const delay = 350
    const playback = new Float32Array(base.length + delay)
    playback.set(base, delay)

    const result = estimateAlignment(base, playback, SAMPLE_RATE, 2)
    expect(result.offsetSamples).toBe(delay)
    expect(result.alignable).toBe(true)
  })

  it('playbackがNサンプル先行している場合、offsetSamplesが負になる', () => {
    const base = musicalSignal(SAMPLE_RATE * 2, SAMPLE_RATE)
    const lead = 200
    const playback = base.subarray(lead)

    const result = estimateAlignment(base, playback, SAMPLE_RATE, 2)
    expect(result.offsetSamples).toBe(-lead)
    expect(result.alignable).toBe(true)
  })

  it('無相関のホワイトノイズ同士はconfidenceが低くalignable=falseになる', () => {
    const a = whiteNoise(SAMPLE_RATE * 2, 11)
    const b = whiteNoise(SAMPLE_RATE * 2, 999)
    const result = estimateAlignment(a, b, SAMPLE_RATE)
    expect(result.alignable).toBe(false)
  })

  it('別マスター相当(似ているが無相関な楽曲)はalignable=falseになる(§4.4.1)', () => {
    const a = musicalSignal(SAMPLE_RATE * 2, SAMPLE_RATE, 5)
    const b = musicalSignal(SAMPLE_RATE * 2, SAMPLE_RATE, 777)
    const result = estimateAlignment(a, b, SAMPLE_RATE)
    expect(result.alignable).toBe(false)
  })

  it('空の音源が渡された場合はalignable=falseを返す', () => {
    const result = estimateAlignment(new Float32Array(0), new Float32Array(10), SAMPLE_RATE)
    expect(result.alignable).toBe(false)
    expect(result.offsetSamples).toBe(0)
  })
})
