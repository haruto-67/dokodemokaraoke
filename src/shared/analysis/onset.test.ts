import { describe, expect, it } from 'vitest'
import { detectOnsets } from './onset'
import { whiteNoise } from './testSignals'

const SAMPLE_RATE = 22050

/** 指定した時刻(秒)にノイズバーストが立ち上がる信号を作る(オンセット検出のテスト用) */
function burstSignal(durationSec: number, burstStartsSec: number[], burstLenSec: number, sampleRate: number): Float32Array {
  const signal = new Float32Array(Math.round(durationSec * sampleRate))
  const burstLen = Math.round(burstLenSec * sampleRate)
  let seed = 1
  for (const startSec of burstStartsSec) {
    const start = Math.round(startSec * sampleRate)
    const noise = whiteNoise(burstLen, seed++)
    for (let i = 0; i < burstLen && start + i < signal.length; i++) {
      signal[start + i] = noise[i]
    }
  }
  return signal
}

describe('detectOnsets', () => {
  it('無音信号からはオンセットを検出しない', () => {
    const signal = new Float32Array(SAMPLE_RATE * 1)
    const onsets = detectOnsets(signal, SAMPLE_RATE)
    expect(onsets.length).toBe(0)
  })

  it('短すぎる信号は空配列を返す', () => {
    const onsets = detectOnsets(new Float32Array(10), SAMPLE_RATE)
    expect(onsets.length).toBe(0)
  })

  it('ノイズバーストの立ち上がり位置を概ね検出する', () => {
    const burstStarts = [0.3, 0.8, 1.3]
    const signal = burstSignal(2, burstStarts, 0.15, SAMPLE_RATE)
    const onsets = Array.from(detectOnsets(signal, SAMPLE_RATE))

    expect(onsets.length).toBeGreaterThanOrEqual(burstStarts.length)

    // 各バースト開始時刻に対応する検出オンセットが50ms以内に存在すること
    for (const expected of burstStarts) {
      const nearest = onsets.reduce((best, t) => (Math.abs(t - expected) < Math.abs(best - expected) ? t : best))
      expect(Math.abs(nearest - expected)).toBeLessThan(0.05)
    }
  })

  it('近すぎる検出は minIntervalSec でまとめられる', () => {
    const burstStarts = [0.3, 0.31] // 10ms差
    const signal = burstSignal(1, burstStarts, 0.1, SAMPLE_RATE)
    const onsets = detectOnsets(signal, SAMPLE_RATE, { minIntervalSec: 0.1 })
    // 0.1秒未満の間隔では1つにまとめられるはず
    for (let i = 1; i < onsets.length; i++) {
      expect(onsets[i] - onsets[i - 1]).toBeGreaterThanOrEqual(0.099)
    }
  })

  it('戻り値は時刻の昇順である', () => {
    const burstStarts = [0.2, 0.5, 0.9, 1.4]
    const signal = burstSignal(2, burstStarts, 0.1, SAMPLE_RATE)
    const onsets = Array.from(detectOnsets(signal, SAMPLE_RATE))
    for (let i = 1; i < onsets.length; i++) {
      expect(onsets[i]).toBeGreaterThan(onsets[i - 1])
    }
  })
})
