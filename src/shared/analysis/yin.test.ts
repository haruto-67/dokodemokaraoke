import { describe, expect, it } from 'vitest'
import { detectPitchYin } from './yin'

const SAMPLE_RATE = 44100

function sineWave(freqHz: number, durationSec: number, sampleRate = SAMPLE_RATE, amplitude = 0.8): Float32Array {
  const length = Math.floor(durationSec * sampleRate)
  const buffer = new Float32Array(length)
  for (let i = 0; i < length; i++) {
    buffer[i] = amplitude * Math.sin((2 * Math.PI * freqHz * i) / sampleRate)
  }
  return buffer
}

function silence(durationSec: number, sampleRate = SAMPLE_RATE): Float32Array {
  return new Float32Array(Math.floor(durationSec * sampleRate))
}

describe('detectPitchYin', () => {
  it('検出する(A2, 110Hz)', () => {
    const hz = detectPitchYin(sineWave(110, 0.05), SAMPLE_RATE)
    expect(hz).toBeGreaterThan(0)
    expect(hz).toBeCloseTo(110, 0)
  })

  it('検出する(A3, 220Hz)', () => {
    const hz = detectPitchYin(sineWave(220, 0.05), SAMPLE_RATE)
    expect(hz).toBeCloseTo(220, 0)
  })

  it('検出する(A4, 440Hz)', () => {
    const hz = detectPitchYin(sineWave(440, 0.05), SAMPLE_RATE)
    expect(hz).toBeCloseTo(440, 0)
  })

  it('検出する(女声域を想定したC5, 523.25Hz)', () => {
    const hz = detectPitchYin(sineWave(523.25, 0.05), SAMPLE_RATE)
    expect(hz).toBeCloseTo(523.25, 0)
  })

  it('無音は0を返す', () => {
    const hz = detectPitchYin(silence(0.05), SAMPLE_RATE)
    expect(hz).toBe(0)
  })

  it('探索レンジ外の高周波はレンジ内のエイリアスに引っ張られうる(YINの既知の限界)', () => {
    // maxHz(既定1000Hz)を大きく超える周波数の真の周期はminLagより短く探索対象外だが、
    // 純音の場合は探索レンジ内の別の遅延(倍数関係にある周期)でも差分が小さくなりうるため、
    // 0になる保証はない。歌唱用途では想定入力(70〜1000Hz)を超えないため実害はないが、
    // 「探索レンジ外は必ず0になる」という誤った前提を置かないためのドキュメント代わりのテスト。
    const hz = detectPitchYin(sineWave(3000, 0.05), SAMPLE_RATE)
    expect(hz === 0 || hz >= 70).toBe(true)
  })

  it('倍音を含む音でも基本周波数を検出する', () => {
    const length = Math.floor(0.05 * SAMPLE_RATE)
    const buffer = new Float32Array(length)
    for (let i = 0; i < length; i++) {
      const t = i / SAMPLE_RATE
      buffer[i] = 0.6 * Math.sin(2 * Math.PI * 220 * t) + 0.3 * Math.sin(2 * Math.PI * 440 * t) + 0.1 * Math.sin(2 * Math.PI * 660 * t)
    }
    const hz = detectPitchYin(buffer, SAMPLE_RATE)
    expect(hz).toBeCloseTo(220, 0)
  })

  it('バッファが短すぎて探索レンジを確保できない場合は0を返す', () => {
    const hz = detectPitchYin(new Float32Array(4), SAMPLE_RATE)
    expect(hz).toBe(0)
  })

  it('minHz/maxHzオプションで探索レンジを変更できる', () => {
    // 既定のminHz(70Hz)より低い50Hzは既定設定では見つからないことがあるが、
    // minHzを下げれば検出できる
    const buffer = sineWave(50, 0.1)
    const hzWithDefault = detectPitchYin(buffer, SAMPLE_RATE)
    const hzWithWiderRange = detectPitchYin(buffer, SAMPLE_RATE, { minHz: 40 })
    expect(hzWithDefault).toBe(0)
    expect(hzWithWiderRange).toBeCloseTo(50, 0)
  })

  it('小さな乱数ノイズが乗っても基本周波数を検出する', () => {
    const length = Math.floor(0.05 * SAMPLE_RATE)
    const buffer = sineWave(330, 0.05)
    // 疑似乱数(シード固定の簡易LCG)でテストの再現性を保つ
    let seed = 42
    const rand = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed / 0x7fffffff - 0.5
    }
    for (let i = 0; i < length; i++) buffer[i] += rand() * 0.02
    const hz = detectPitchYin(buffer, SAMPLE_RATE)
    expect(hz).toBeCloseTo(330, 0)
  })
})
