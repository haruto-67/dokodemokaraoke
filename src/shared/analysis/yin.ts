/**
 * YINアルゴリズムによるリアルタイムピッチ検出(要件定義書v3 §4.12.1)。
 *
 * RMVPEはオフライン解析専用(python/sidecar/rmvpe_model.py)であり、本番画面での
 * マイク入力にはここで実装する軽量なYINを使う(採点の精度を決めるのは検出精度ではなく
 * 入出力遅延補正であるため、リアルタイム側に重いモデルを持ち込まない方針)。
 *
 * 参考: A. de Cheveigné and H. Kawahara, "YIN, a fundamental frequency estimator
 * for speech and music," J. Acoust. Soc. Am. 111, 1917-1930 (2002).
 */

export interface DetectPitchYinOptions {
  /** 累積正規化差分関数がこの値を下回った最初の谷を基本周期とみなす(論文の既定値付近) */
  threshold?: number
  /** 探索する周波数レンジの下限・上限(Hz)。人の歌声を想定した既定値 */
  minHz?: number
  maxHz?: number
}

/**
 * 単一フレームの音声からYINで基本周波数を推定する。
 * 無声/検出不能な場合は0を返す。
 */
export function detectPitchYin(buffer: Float32Array, sampleRate: number, options: DetectPitchYinOptions = {}): number {
  const threshold = options.threshold ?? 0.15
  const minHz = options.minHz ?? 70
  const maxHz = options.maxHz ?? 1000

  const minLag = Math.max(2, Math.floor(sampleRate / maxHz))
  const maxLag = Math.min(buffer.length - 1, Math.ceil(sampleRate / minHz))
  if (maxLag <= minLag) return 0

  // ステップ1〜2: 差分関数と累積平均正規化差分関数(CMND)
  const cmnd = new Float32Array(maxLag + 1)
  cmnd[0] = 1
  let runningSum = 0
  for (let tau = 1; tau <= maxLag; tau++) {
    let diff = 0
    for (let i = 0; i < buffer.length - tau; i++) {
      const delta = buffer[i] - buffer[i + tau]
      diff += delta * delta
    }
    runningSum += diff
    cmnd[tau] = runningSum === 0 ? 1 : (diff * tau) / runningSum
  }

  // ステップ3: 絶対閾値法で最初の谷を探す(閾値未満に入った直後の局所最小)
  let tauEstimate = -1
  for (let tau = minLag; tau <= maxLag; tau++) {
    if (cmnd[tau] < threshold) {
      while (tau + 1 <= maxLag && cmnd[tau + 1] < cmnd[tau]) tau++
      tauEstimate = tau
      break
    }
  }
  if (tauEstimate === -1) return 0

  // ステップ4: 放物線補間でtauをサブサンプル精度に補正
  let betterTau = tauEstimate
  if (tauEstimate > 0 && tauEstimate < maxLag) {
    const s0 = cmnd[tauEstimate - 1]
    const s1 = cmnd[tauEstimate]
    const s2 = cmnd[tauEstimate + 1]
    const denom = 2 * s1 - s2 - s0
    if (denom !== 0) betterTau = tauEstimate + (s2 - s0) / (2 * denom)
  }

  if (betterTau <= 0) return 0
  return sampleRate / betterTau
}
