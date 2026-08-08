// STEP 3: 前処理(要件定義書 §4.4.3) — モノラル化・リサンプル・ハイパスフィルタ

export const TARGET_SAMPLE_RATE = 22050
export const HIGHPASS_CUTOFF_HZ = 60

/** 複数チャンネルを平均してモノラル化する */
export function toMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 0) return new Float32Array(0)
  if (channels.length === 1) return channels[0].slice()
  const len = channels[0].length
  const out = new Float32Array(len)
  for (let i = 0; i < len; i++) {
    let sum = 0
    for (const ch of channels) sum += ch[i]
    out[i] = sum / channels.length
  }
  return out
}

/** 線形補間によるリサンプル。オフライン処理であり品質よりシンプルさ・依存ゼロを優先する。 */
export function resampleLinear(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate || input.length === 0) return input.slice()
  const outLen = Math.max(1, Math.round((input.length * toRate) / fromRate))
  const out = new Float32Array(outLen)
  const ratio = (input.length - 1) / Math.max(1, outLen - 1)
  for (let i = 0; i < outLen; i++) {
    const srcPos = i * ratio
    const i0 = Math.floor(srcPos)
    const i1 = Math.min(input.length - 1, i0 + 1)
    const frac = srcPos - i0
    out[i] = input[i0] * (1 - frac) + input[i1] * frac
  }
  return out
}

/**
 * 1次IIRハイパスフィルタ(RC回路相当)。低域の残留成分(約60Hz)を除去する。
 * 高次フィルタほどの急峻さはないが、依存ゼロ・オフラインでのシンプルな実装を優先している。
 */
export function highpassFilter(input: Float32Array, sampleRate: number, cutoffHz: number = HIGHPASS_CUTOFF_HZ): Float32Array {
  if (input.length === 0) return input.slice()
  const rc = 1 / (2 * Math.PI * cutoffHz)
  const dt = 1 / sampleRate
  const alpha = rc / (rc + dt)
  const out = new Float32Array(input.length)
  out[0] = input[0]
  for (let i = 1; i < input.length; i++) {
    out[i] = alpha * (out[i - 1] + input[i] - input[i - 1])
  }
  return out
}

export interface PreprocessResult {
  signal: Float32Array
  sampleRate: number
}

/** STEP3一式: モノラル化 → 22,050Hzへリサンプル → ハイパスフィルタ */
export function preprocess(channels: Float32Array[], sourceSampleRate: number): PreprocessResult {
  const mono = toMono(channels)
  const resampled = resampleLinear(mono, sourceSampleRate, TARGET_SAMPLE_RATE)
  const filtered = highpassFilter(resampled, TARGET_SAMPLE_RATE)
  return { signal: filtered, sampleRate: TARGET_SAMPLE_RATE }
}
