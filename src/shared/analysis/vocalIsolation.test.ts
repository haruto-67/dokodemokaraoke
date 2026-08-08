import { describe, expect, it } from 'vitest'
import { extractDifferenceVocal } from './vocalIsolation'
import { whiteNoise } from './testSignals'

describe('extractDifferenceVocal', () => {
  it('accompaniment + vocal から accompaniment を差し引くとvocalに近い信号が残り、usedがtrueになる', () => {
    const n = 4000
    const accompaniment = whiteNoise(n, 1)
    const vocal = whiteNoise(n, 2)
    const gainTrue = 0.7
    const analysis = new Float32Array(n)
    for (let i = 0; i < n; i++) analysis[i] = accompaniment[i] * gainTrue + vocal[i]

    const result = extractDifferenceVocal(analysis, accompaniment, 0)

    expect(result.used).toBe(true)
    expect(result.gain).toBeCloseTo(gainTrue, 1)
    expect(result.residualRatio).toBeLessThan(0.75)

    // 差分信号は vocal に近いはず
    let err = 0
    let vocalEnergy = 0
    for (let i = 0; i < result.signal.length; i++) {
      const d = result.signal[i] - vocal[result.startIndex + i]
      err += d * d
      vocalEnergy += vocal[result.startIndex + i] ** 2
    }
    expect(err / vocalEnergy).toBeLessThan(0.05)
  })

  it('playbackがanalysisと無関係な場合、打ち消せずusedがfalseになる', () => {
    const n = 4000
    const analysis = whiteNoise(n, 10)
    const unrelatedPlayback = whiteNoise(n, 20)

    const result = extractDifferenceVocal(analysis, unrelatedPlayback, 0)
    expect(result.used).toBe(false)
  })

  it('offsetSamplesを考慮して重なり区間のみを対象にする', () => {
    const n = 2000
    const accompaniment = whiteNoise(n, 3)
    const vocal = whiteNoise(n, 4)
    const analysis = new Float32Array(n)
    for (let i = 0; i < n; i++) analysis[i] = accompaniment[i] + vocal[i]

    // playback が analysis より 50 サンプル「遅れている」= playback[i] = accompaniment[i-50] 相当にする。
    // playback の長さは analysis と同じ(末尾 delay サンプル分は重なりが取れない)。
    const delay = 50
    const playback = new Float32Array(n)
    for (let i = delay; i < n; i++) playback[i] = accompaniment[i - delay]

    const result = extractDifferenceVocal(analysis, playback, delay)
    expect(result.used).toBe(true)
    expect(result.startIndex).toBe(0)
    expect(result.signal.length).toBe(n - delay)
  })

  it('重なりが無い場合はusedがfalseで空の信号を返す', () => {
    const result = extractDifferenceVocal(new Float32Array(10), new Float32Array(10), 100)
    expect(result.used).toBe(false)
    expect(result.signal.length).toBe(0)
  })
})
