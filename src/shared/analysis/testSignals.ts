// テスト専用の決定的な信号生成ユーティリティ(本体コードからは参照しない)

export function xorshift32(seed: number): () => number {
  let x = seed | 0
  if (x === 0) x = 1
  return () => {
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    x |= 0
    return (x >>> 0) / 0xffffffff
  }
}

export function whiteNoise(n: number, seed: number): Float32Array {
  const rand = xorshift32(seed)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = rand() * 2 - 1
  return out
}

/** 複数のサイン波(トーン)+広帯域ノイズを重ねた「楽曲っぽい」テスト信号 */
export function musicalSignal(n: number, sampleRate: number, seed = 1): Float32Array {
  const out = new Float32Array(n)
  const freqs = [110, 220, 440, 880]
  const noise = whiteNoise(n, seed)
  for (let i = 0; i < n; i++) {
    let v = 0
    for (const f of freqs) v += Math.sin((2 * Math.PI * f * i) / sampleRate) / freqs.length
    out[i] = v * 0.6 + noise[i] * 0.4
  }
  return out
}

/** 単一の正弦波(ピッチ検出テスト用) */
export function sineWave(n: number, freqHz: number, sampleRate: number, amplitude = 1): Float32Array {
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = amplitude * Math.sin((2 * Math.PI * freqHz * i) / sampleRate)
  return out
}
