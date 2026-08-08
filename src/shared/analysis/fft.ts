// 純粋な radix-2 反復FFT。外部ライブラリを使わず自前実装する(オフライン要件・依存最小化のため)。

export function nextPow2(n: number): number {
  let p = 1
  while (p < n) p <<= 1
  return p
}

/** in-place 反復FFT/IFFT。長さは2の冪であること。 */
export function fft(re: Float64Array, im: Float64Array, invert: boolean): void {
  const n = re.length
  if (n !== im.length) throw new Error('re/im の長さが一致していません')
  if (n === 0) return
  if ((n & (n - 1)) !== 0) throw new Error('FFT長は2の冪である必要があります')

  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      const tr = re[i]
      re[i] = re[j]
      re[j] = tr
      const ti = im[i]
      im[i] = im[j]
      im[j] = ti
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((2 * Math.PI) / len) * (invert ? -1 : 1)
    const wr = Math.cos(ang)
    const wi = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let curWr = 1
      let curWi = 0
      const half = len >> 1
      for (let j = 0; j < half; j++) {
        const ur = re[i + j]
        const ui = im[i + j]
        const vr = re[i + j + half] * curWr - im[i + j + half] * curWi
        const vi = re[i + j + half] * curWi + im[i + j + half] * curWr
        re[i + j] = ur + vr
        im[i + j] = ui + vi
        re[i + j + half] = ur - vr
        im[i + j + half] = ui - vi
        const nextWr = curWr * wr - curWi * wi
        const nextWi = curWr * wi + curWi * wr
        curWr = nextWr
        curWi = nextWi
      }
    }
  }

  if (invert) {
    for (let i = 0; i < n; i++) {
      re[i] /= n
      im[i] /= n
    }
  }
}

/**
 * FFTベースの線形相互相関(STEP1 §4.4.1)。零詰めにより線形相関として扱えるだけの長さを確保する。
 * 戻り値 result[k] = sum_n a[n] * b[(n-k) mod N]。
 * a と b が完全一致(ラグ0)なら k=0 でピークになり、b が a に対し delay サンプル遅れている
 * (b[n] = a[n-delay]) 場合は k = (N - delay) mod N でピークになる。
 * (符号規約の導出根拠はテストを参照)
 */
export function fftCrossCorrelate(a: Float32Array, b: Float32Array): Float64Array {
  const n = nextPow2(a.length + b.length)
  const reA = new Float64Array(n)
  const imA = new Float64Array(n)
  const reB = new Float64Array(n)
  const imB = new Float64Array(n)
  for (let i = 0; i < a.length; i++) reA[i] = a[i]
  for (let i = 0; i < b.length; i++) reB[i] = b[i]

  fft(reA, imA, false)
  fft(reB, imB, false)

  const reC = new Float64Array(n)
  const imC = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    // FFT(a) * conj(FFT(b))
    reC[i] = reA[i] * reB[i] + imA[i] * imB[i]
    imC[i] = imA[i] * reB[i] - reA[i] * imB[i]
  }

  fft(reC, imC, true)
  return reC
}
