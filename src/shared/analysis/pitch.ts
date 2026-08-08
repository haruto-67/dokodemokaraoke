// STEP 4: ピッチ検出(要件定義書 §4.4.4) — YIN法

export const PITCH_MIN_HZ = 70
export const PITCH_MAX_HZ = 1100
export const HOP_SEC = 0.005
/** YINの絶対閾値。CMNDFがこの値を初めて下回った点を基本周期候補とする(YIN論文の標準的な値) */
const YIN_THRESHOLD = 0.15

export interface PitchFrame {
  timeSec: number
  hz: number // 無声は0
  voiced: boolean
}

/**
 * 1フレーム分のYIN差分関数(d)と累積平均正規化差分関数(CMNDF)を計算し、
 * 閾値を初めて下回る谷を放物線補間してピッチ(Hz)を推定する。
 * 検出できなければ null を返す(無声)。
 */
function yinFrame(frame: Float32Array, sampleRate: number, minHz: number, maxHz: number): number | null {
  const maxLag = Math.min(frame.length - 1, Math.floor(sampleRate / minHz))
  const minLag = Math.max(1, Math.floor(sampleRate / maxHz))
  if (maxLag <= minLag) return null

  const d = new Float64Array(maxLag + 1)
  for (let lag = 1; lag <= maxLag; lag++) {
    let sum = 0
    for (let i = 0; i < frame.length - lag; i++) {
      const diff = frame[i] - frame[i + lag]
      sum += diff * diff
    }
    d[lag] = sum
  }

  const cmndf = new Float64Array(maxLag + 1)
  cmndf[0] = 1
  let runningSum = 0
  for (let lag = 1; lag <= maxLag; lag++) {
    runningSum += d[lag]
    cmndf[lag] = runningSum > 0 ? (d[lag] * lag) / runningSum : 1
  }

  let tau = -1
  for (let lag = minLag; lag <= maxLag; lag++) {
    if (cmndf[lag] < YIN_THRESHOLD) {
      // 閾値を下回った区間内でのローカルミニマムまで進む
      let t = lag
      while (t + 1 <= maxLag && cmndf[t + 1] < cmndf[t]) t++
      tau = t
      break
    }
  }
  if (tau === -1) return null // 閾値を下回る谷が無い = 無声

  // 放物線補間でサブサンプル精度の周期を求める
  let betterTau = tau
  if (tau > minLag && tau < maxLag) {
    const s0 = cmndf[tau - 1]
    const s1 = cmndf[tau]
    const s2 = cmndf[tau + 1]
    const denom = 2 * (2 * s1 - s2 - s0)
    if (Math.abs(denom) > 1e-12) {
      betterTau = tau + (s2 - s0) / denom
    }
  }
  if (betterTau <= 0) return null

  return sampleRate / betterTau
}

export interface DetectPitchOptions {
  minHz?: number
  maxHz?: number
  hopSec?: number
  frameSizeSec?: number
}

/** フレームごとにYINでピッチを検出する(オクターブ補正・平滑化はSTEP4後段の関数で行う) */
export function detectPitchYin(signal: Float32Array, sampleRate: number, options: DetectPitchOptions = {}): PitchFrame[] {
  const minHz = options.minHz ?? PITCH_MIN_HZ
  const maxHz = options.maxHz ?? PITCH_MAX_HZ
  const hopSec = options.hopSec ?? HOP_SEC
  const hopSize = Math.max(1, Math.round(hopSec * sampleRate))
  // 最低周波数を検出するには最低2周期分の窓が要る
  const frameSize = options.frameSizeSec
    ? Math.round(options.frameSizeSec * sampleRate)
    : Math.max(hopSize * 2, Math.round((2 * sampleRate) / minHz))

  const frames: PitchFrame[] = []
  for (let start = 0; start + frameSize <= signal.length; start += hopSize) {
    const frame = signal.subarray(start, start + frameSize)
    const hz = yinFrame(frame, sampleRate, minHz, maxHz)
    frames.push({
      timeSec: start / sampleRate,
      hz: hz ?? 0,
      voiced: hz !== null
    })
  }
  return frames
}

/**
 * オクターブ誤り補正(§4.4.4後処理)。
 * 前後フレームと比較して概ね2倍・1/2倍(オクターブ違い)になっている孤立フレームを、
 * 前後の軌跡に合わせて半分/倍にする。
 */
export function correctOctaveErrors(frames: PitchFrame[], toleranceRatio = 0.08): PitchFrame[] {
  const out = frames.map((f) => ({ ...f }))
  for (let i = 1; i < out.length - 1; i++) {
    const cur = out[i]
    if (!cur.voiced) continue
    const prev = out[i - 1]
    const next = out[i + 1]
    if (!prev.voiced || !next.voiced) continue

    const neighborAvg = (prev.hz + next.hz) / 2
    const closeToNeighbor = Math.abs(cur.hz - neighborAvg) / neighborAvg <= toleranceRatio
    if (closeToNeighbor) continue

    for (const factor of [2, 0.5]) {
      const candidate = cur.hz * factor
      if (Math.abs(candidate - neighborAvg) / neighborAvg <= toleranceRatio) {
        cur.hz = candidate
        break
      }
    }
  }
  return out
}

/** 中央値フィルタ(§4.4.4後処理)。単発の外れ値を除去する。windowSize は奇数を推奨。 */
export function medianFilter(frames: PitchFrame[], windowSize = 5): PitchFrame[] {
  const half = Math.floor(windowSize / 2)
  const out = frames.map((f) => ({ ...f }))
  for (let i = 0; i < frames.length; i++) {
    if (!frames[i].voiced) continue
    const windowVals: number[] = []
    for (let j = Math.max(0, i - half); j <= Math.min(frames.length - 1, i + half); j++) {
      if (frames[j].voiced) windowVals.push(frames[j].hz)
    }
    if (windowVals.length === 0) continue
    windowVals.sort((a, b) => a - b)
    out[i].hz = windowVals[Math.floor(windowVals.length / 2)]
  }
  return out
}

/**
 * 連続性を考慮した平滑化(§4.4.4後処理)。フレーム間の急激な変化にペナルティを課しつつ、
 * 指数移動平均的に軌跡を滑らかにする(簡易的なViterbi的経路探索の代替として、
 * 前フレームからの乖離が大きいほど追従を弱める適応的スムージングを用いる)。
 */
export function smoothPitchTrajectory(frames: PitchFrame[], maxJumpRatio = 0.15, smoothing = 0.5): PitchFrame[] {
  const out = frames.map((f) => ({ ...f }))
  let lastHz: number | null = null
  for (let i = 0; i < out.length; i++) {
    if (!out[i].voiced) {
      lastHz = null
      continue
    }
    if (lastHz === null) {
      lastHz = out[i].hz
      continue
    }
    const jumpRatio = Math.abs(out[i].hz - lastHz) / lastHz
    // 急激な変化(オクターブ跳びに近い)ほど強く平滑化して追従を抑える
    const w = jumpRatio > maxJumpRatio ? smoothing * 0.4 : smoothing
    const filtered: number = lastHz * (1 - w) + out[i].hz * w
    out[i].hz = filtered
    lastHz = filtered
  }
  return out
}

/**
 * 有意なピッチ変化点の時刻を抽出する(§4.6.3手順3で境界候補として使う)。
 * 半音(semitone)換算でthresholdSemitones以上の跳躍があったフレームの時刻を返す。
 */
export function findPitchChangePoints(frames: PitchFrame[], thresholdSemitones = 1.5): number[] {
  const points: number[] = []
  let lastHz: number | null = null
  for (const f of frames) {
    if (!f.voiced || f.hz <= 0) {
      lastHz = null
      continue
    }
    if (lastHz !== null) {
      const semitones = Math.abs(12 * Math.log2(f.hz / lastHz))
      if (semitones >= thresholdSemitones) points.push(f.timeSec)
    }
    lastHz = f.hz
  }
  return points
}
