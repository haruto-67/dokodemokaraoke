import { describe, expect, it } from 'vitest'
import { fft, nextPow2, fftCrossCorrelate } from './fft'

describe('nextPow2', () => {
  it('既に2の冪ならそのまま返す', () => {
    expect(nextPow2(16)).toBe(16)
  })
  it('2の冪でなければ切り上げる', () => {
    expect(nextPow2(17)).toBe(32)
    expect(nextPow2(1)).toBe(1)
    expect(nextPow2(0)).toBe(1)
  })
})

describe('fft', () => {
  it('forward -> inverse で元の信号に戻る(ラウンドトリップ)', () => {
    const n = 64
    const re = new Float64Array(n)
    const im = new Float64Array(n)
    for (let i = 0; i < n; i++) re[i] = Math.sin((2 * Math.PI * 3 * i) / n) + 0.5

    const original = re.slice()
    fft(re, im, false)
    fft(re, im, true)

    for (let i = 0; i < n; i++) {
      expect(re[i]).toBeCloseTo(original[i], 6)
      expect(im[i]).toBeCloseTo(0, 6)
    }
  })

  it('直流成分(全て1)のFFTはDC binにのみエネルギーを持つ', () => {
    const n = 8
    const re = new Float64Array(n).fill(1)
    const im = new Float64Array(n)
    fft(re, im, false)
    expect(re[0]).toBeCloseTo(8, 6)
    for (let i = 1; i < n; i++) {
      expect(re[i]).toBeCloseTo(0, 6)
      expect(im[i]).toBeCloseTo(0, 6)
    }
  })

  it('2の冪でない長さはエラーになる', () => {
    const re = new Float64Array(6)
    const im = new Float64Array(6)
    expect(() => fft(re, im, false)).toThrow()
  })
})

/** 決定的な疑似乱数(LCG)。周期性のないテスト信号を作るため。 */
function pseudoRandomSignal(n: number, seed = 1): Float32Array {
  const out = new Float32Array(n)
  let s = seed
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    out[i] = (s / 0x7fffffff) * 2 - 1
  }
  return out
}

describe('fftCrossCorrelate', () => {
  // 規約: result[k] = sum_n a[n] * b[(n-k) mod N]。
  // 従って a と b が完全一致(ラグ0)なら k=0 でピークになり、
  // b が a に対して delay サンプル遅れている(b[n] = a[n-delay])場合は k = (-delay mod N) でピークになる。

  it('同一の非周期信号の自己相関はk=0で最大になる', () => {
    const a = pseudoRandomSignal(32)
    const result = fftCrossCorrelate(a, a)

    let maxIdx = 0
    for (let i = 1; i < result.length; i++) {
      if (result[i] > result[maxIdx]) maxIdx = i
    }
    expect(maxIdx).toBe(0)
  })

  it('bをDサンプル遅らせた信号との相関はk=(N-D)で最大になる', () => {
    const base = pseudoRandomSignal(40, 7)
    const delay = 6
    const b = new Float32Array(base.length + delay)
    b.set(base, delay)

    const result = fftCrossCorrelate(base, b)
    let maxIdx = 0
    for (let i = 1; i < result.length; i++) {
      if (result[i] > result[maxIdx]) maxIdx = i
    }
    expect(maxIdx).toBe(result.length - delay)
  })
})
