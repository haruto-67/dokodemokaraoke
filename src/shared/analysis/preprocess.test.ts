import { describe, expect, it } from 'vitest'
import { toMono, resampleLinear, highpassFilter, preprocess, TARGET_SAMPLE_RATE } from './preprocess'
import { sineWave } from './testSignals'

describe('toMono', () => {
  it('1チャンネルはそのまま返す', () => {
    const ch = new Float32Array([1, 2, 3])
    expect(Array.from(toMono([ch]))).toEqual([1, 2, 3])
  })

  it('複数チャンネルは平均する', () => {
    const l = new Float32Array([1, 1, 1])
    const r = new Float32Array([3, 3, 3])
    expect(Array.from(toMono([l, r]))).toEqual([2, 2, 2])
  })

  it('チャンネルが無い場合は空配列を返す', () => {
    expect(toMono([]).length).toBe(0)
  })
})

describe('resampleLinear', () => {
  it('同じサンプルレートならそのまま返す', () => {
    const input = new Float32Array([1, 2, 3])
    expect(Array.from(resampleLinear(input, 44100, 44100))).toEqual([1, 2, 3])
  })

  it('半分のレートにダウンサンプルすると長さが概ね半分になる', () => {
    const input = new Float32Array(1000)
    const out = resampleLinear(input, 44100, 22050)
    expect(out.length).toBeCloseTo(500, -1)
  })

  it('線形ランプの中間値は補間で正しく求まる', () => {
    // 0,10,20,...,90 を2倍の点数にアップサンプル
    const input = new Float32Array(10)
    for (let i = 0; i < 10; i++) input[i] = i * 10
    const out = resampleLinear(input, 10, 20)
    // 端点は一致する
    expect(out[0]).toBeCloseTo(0, 5)
    expect(out[out.length - 1]).toBeCloseTo(90, 5)
    // 単調増加であること(線形補間なので折り返しや逆転が無い)
    for (let i = 1; i < out.length; i++) {
      expect(out[i]).toBeGreaterThanOrEqual(out[i - 1])
    }
  })
})

describe('highpassFilter', () => {
  it('直流成分は徐々に0へ収束する', () => {
    const n = 2000
    const input = new Float32Array(n).fill(1)
    const out = highpassFilter(input, 22050, 60)
    expect(Math.abs(out[out.length - 1])).toBeLessThan(0.01)
  })

  it('十分高い周波数の正弦波は振幅がほぼ保たれる', () => {
    const sampleRate = 22050
    const n = 4410
    const input = sineWave(n, 2000, sampleRate)
    const out = highpassFilter(input, sampleRate, 60)
    // フィルタの過渡応答が収まった後半部分で振幅を比較
    let maxIn = 0
    let maxOut = 0
    for (let i = n / 2; i < n; i++) {
      maxIn = Math.max(maxIn, Math.abs(input[i]))
      maxOut = Math.max(maxOut, Math.abs(out[i]))
    }
    expect(maxOut / maxIn).toBeGreaterThan(0.9)
  })

  it('空配列を渡してもエラーにならない', () => {
    expect(highpassFilter(new Float32Array(0), 22050).length).toBe(0)
  })
})

describe('preprocess', () => {
  it('モノラル化・リサンプル・ハイパスを一括で適用しTARGET_SAMPLE_RATEを返す', () => {
    const sourceSampleRate = 44100
    const ch = new Float32Array(sourceSampleRate).fill(0.5)
    const result = preprocess([ch, ch], sourceSampleRate)
    expect(result.sampleRate).toBe(TARGET_SAMPLE_RATE)
    expect(result.signal.length).toBeCloseTo(TARGET_SAMPLE_RATE, -1)
  })
})
