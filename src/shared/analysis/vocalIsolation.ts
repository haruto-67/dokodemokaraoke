// STEP 2: 差分ボーカル抽出(要件定義書 §4.4.2)

export interface VocalIsolationResult {
  /** 差分ボーカル信号。analysis のタイムライン上で [startIndex, startIndex + signal.length) に対応する */
  signal: Float32Array
  /** analysis 内でのこの信号の開始インデックス(アライメントにより先頭が欠ける場合がある) */
  startIndex: number
  /** playback に掛けた最適スカラーゲイン(最小二乗フィット) */
  gain: number
  /** 減算後の残差エネルギー比(diffのエネルギー / analysisのエネルギー)。低いほど良く打ち消せている */
  residualRatio: number
  /** 伴奏が十分に打ち消せたと判定できたか。false の場合は通常経路へのフォールバックを推奨する */
  used: boolean
}

/** これ以上残差エネルギー比が高い場合は「ほとんど打ち消せていない」と判定してフォールバックする */
const RESIDUAL_RATIO_THRESHOLD = 0.75

/**
 * アライメント済みの2信号を減算し、歌声のみに近い信号を得る(§4.4.2)。
 * playback 側は録音レベルが analysis と異なりうるため、減算前に最小二乗フィットで
 * 最適なスカラーゲインを推定してから引く(単純な等倍差分よりも打ち消しの成功率が上がる)。
 */
export function extractDifferenceVocal(
  analysis: Float32Array,
  playback: Float32Array,
  offsetSamples: number
): VocalIsolationResult {
  const startIndex = Math.max(0, -offsetSamples)
  const endIndex = Math.min(analysis.length, playback.length - offsetSamples)
  const len = Math.max(0, endIndex - startIndex)

  if (len === 0) {
    return { signal: new Float32Array(0), startIndex: 0, gain: 0, residualRatio: 1, used: false }
  }

  // 最適ゲイン g = <analysis, playback> / <playback, playback> (最小二乗射影)
  let dot = 0
  let playbackEnergy = 0
  let analysisEnergy = 0
  for (let i = 0; i < len; i++) {
    const av = analysis[startIndex + i]
    const pv = playback[startIndex + i + offsetSamples]
    dot += av * pv
    playbackEnergy += pv * pv
    analysisEnergy += av * av
  }
  const gain = playbackEnergy > 0 ? dot / playbackEnergy : 0

  const signal = new Float32Array(len)
  let diffEnergy = 0
  for (let i = 0; i < len; i++) {
    const av = analysis[startIndex + i]
    const pv = playback[startIndex + i + offsetSamples]
    const d = av - gain * pv
    signal[i] = d
    diffEnergy += d * d
  }

  const residualRatio = analysisEnergy > 0 ? diffEnergy / analysisEnergy : 1
  const used = residualRatio < RESIDUAL_RATIO_THRESHOLD

  return { signal, startIndex, gain, residualRatio, used }
}
