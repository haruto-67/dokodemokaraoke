import { describe, expect, it } from 'vitest'
import { detectPitchYin, correctOctaveErrors, medianFilter, smoothPitchTrajectory, type PitchFrame } from './pitch'
import { sineWave } from './testSignals'

const SAMPLE_RATE = 22050

describe('detectPitchYin', () => {
  it('純音(220Hz)の周波数をほぼ正確に検出する', () => {
    const signal = sineWave(Math.round(SAMPLE_RATE * 0.3), 220, SAMPLE_RATE)
    const frames = detectPitchYin(signal, SAMPLE_RATE)
    expect(frames.length).toBeGreaterThan(10)

    // 先頭・末尾の過渡フレームを除いて評価する
    const middle = frames.slice(3, -3)
    for (const f of middle) {
      expect(f.voiced).toBe(true)
      expect(f.hz).toBeCloseTo(220, 0)
    }
  })

  it('無音区間は無声(voiced=false, hz=0)として扱う', () => {
    const signal = new Float32Array(Math.round(SAMPLE_RATE * 0.2))
    const frames = detectPitchYin(signal, SAMPLE_RATE)
    for (const f of frames) {
      expect(f.voiced).toBe(false)
      expect(f.hz).toBe(0)
    }
  })

  it('440Hzの純音も検出できる(検出範囲内の別周波数)', () => {
    const signal = sineWave(Math.round(SAMPLE_RATE * 0.2), 440, SAMPLE_RATE)
    const frames = detectPitchYin(signal, SAMPLE_RATE)
    const middle = frames.slice(3, -3)
    for (const f of middle) {
      expect(f.hz).toBeCloseTo(440, 0)
    }
  })

  it('timeSecはhopSecに従って単調増加する', () => {
    const signal = sineWave(Math.round(SAMPLE_RATE * 0.1), 220, SAMPLE_RATE)
    const frames = detectPitchYin(signal, SAMPLE_RATE, { hopSec: 0.01 })
    // hopSecはサンプル数に丸められるため、実際のホップ幅はSAMPLE_RATE単位の整数サンプル分になる
    const expectedHopSec = Math.round(0.01 * SAMPLE_RATE) / SAMPLE_RATE
    for (let i = 1; i < frames.length; i++) {
      expect(frames[i].timeSec).toBeCloseTo(frames[i - 1].timeSec + expectedHopSec, 5)
    }
  })
})

function frame(hz: number, voiced = true): PitchFrame {
  return { timeSec: 0, hz, voiced }
}

describe('correctOctaveErrors', () => {
  it('前後の2倍になっている孤立フレームを半分に補正する', () => {
    const frames = [frame(220), frame(220), frame(440), frame(220), frame(220)]
    const corrected = correctOctaveErrors(frames)
    expect(corrected[2].hz).toBeCloseTo(220, 0)
  })

  it('前後の1/2になっている孤立フレームを倍に補正する', () => {
    const frames = [frame(220), frame(220), frame(110), frame(220), frame(220)]
    const corrected = correctOctaveErrors(frames)
    expect(corrected[2].hz).toBeCloseTo(220, 0)
  })

  it('自然な変化(オクターブ跳びでない)は補正しない', () => {
    const frames = [frame(220), frame(230), frame(240), frame(250), frame(260)]
    const corrected = correctOctaveErrors(frames)
    expect(corrected[2].hz).toBe(240)
  })
})

describe('medianFilter', () => {
  it('単発の外れ値を除去する', () => {
    const frames = [frame(220), frame(220), frame(900), frame(220), frame(220)]
    const filtered = medianFilter(frames, 5)
    expect(filtered[2].hz).toBeCloseTo(220, 0)
  })

  it('無声フレームは変更しない', () => {
    const frames = [frame(220), frame(0, false), frame(220)]
    const filtered = medianFilter(frames, 3)
    expect(filtered[1].voiced).toBe(false)
  })
})

describe('smoothPitchTrajectory', () => {
  it('急激な変化を滑らかにする(直前値と新値の間になる)', () => {
    const frames = [frame(220), frame(220), frame(440)]
    const smoothed = smoothPitchTrajectory(frames)
    expect(smoothed[2].hz).toBeGreaterThan(220)
    expect(smoothed[2].hz).toBeLessThan(440)
  })

  it('無声フレームをまたぐと軌跡がリセットされる', () => {
    const frames = [frame(220), frame(0, false), frame(440)]
    const smoothed = smoothPitchTrajectory(frames)
    // 直前が無声なのでリセットされ、440はそのまま
    expect(smoothed[2].hz).toBe(440)
  })
})
