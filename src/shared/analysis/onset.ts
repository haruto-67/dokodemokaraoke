// STEP 5: オンセット検出(要件定義書 §4.4.5) — スペクトラルフラックス法
import { fft, nextPow2 } from './fft'

export interface OnsetDetectionOptions {
  /** STFTのフレームサイズ(サンプル数、2の冪に切り上げられる) */
  frameSize?: number
  /** STFTのホップサイズ(サンプル数) */
  hopSize?: number
  /** ピーク検出の適応閾値: ローカル平均に対する倍率 */
  thresholdMultiplier?: number
  /** 検出したオンセット同士の最小間隔(秒)。近すぎる二重検出を防ぐ */
  minIntervalSec?: number
}

function hannWindow(size: number): Float64Array {
  const w = new Float64Array(size)
  for (let i = 0; i < size; i++) {
    w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1))
  }
  return w
}

/** フレームごとのスペクトラルフラックス(新規性関数)を計算する */
function computeSpectralFlux(signal: Float32Array, frameSize: number, hopSize: number): Float64Array {
  const fftSize = nextPow2(frameSize)
  const window = hannWindow(frameSize)
  const numFrames = Math.max(0, Math.floor((signal.length - frameSize) / hopSize) + 1)
  const flux = new Float64Array(numFrames)

  let prevMag: Float64Array | null = null
  const re = new Float64Array(fftSize)
  const im = new Float64Array(fftSize)

  for (let f = 0; f < numFrames; f++) {
    const start = f * hopSize
    re.fill(0)
    im.fill(0)
    for (let i = 0; i < frameSize; i++) re[i] = signal[start + i] * window[i]

    fft(re, im, false)

    const half = fftSize / 2
    const mag = new Float64Array(half)
    for (let k = 0; k < half; k++) mag[k] = Math.hypot(re[k], im[k])

    if (prevMag) {
      let sum = 0
      for (let k = 0; k < half; k++) {
        const diff = mag[k] - prevMag[k]
        if (diff > 0) sum += diff
      }
      flux[f] = sum
    } else {
      flux[f] = 0
    }
    prevMag = mag
  }
  return flux
}

/** ローカル平均を用いた適応的ピークピッキング。フレームインデックスの配列を返す。 */
function pickPeaks(flux: Float64Array, thresholdMultiplier: number, minIntervalFrames: number): number[] {
  const n = flux.length
  const localWindowRadius = Math.max(1, minIntervalFrames)
  const peaks: number[] = []
  let lastPeak = -Infinity

  for (let i = 1; i < n - 1; i++) {
    if (flux[i] <= flux[i - 1] || flux[i] < flux[i + 1]) continue

    let sum = 0
    let count = 0
    for (let j = Math.max(0, i - localWindowRadius); j <= Math.min(n - 1, i + localWindowRadius); j++) {
      sum += flux[j]
      count++
    }
    const localMean = count > 0 ? sum / count : 0
    if (flux[i] < localMean * thresholdMultiplier + 1e-9) continue
    if (i - lastPeak < minIntervalFrames) {
      // 直前のピークの方が強ければそちらを優先し、今回のピークは棄却する
      if (peaks.length > 0 && flux[i] > flux[peaks[peaks.length - 1]]) {
        peaks[peaks.length - 1] = i
        lastPeak = i
      }
      continue
    }

    peaks.push(i)
    lastPeak = i
  }
  return peaks
}

/**
 * スペクトラルフラックスによりオンセット(音の立ち上がり)を検出する(§4.4.5)。
 * 戻り値は昇順の時刻(秒)配列。
 */
export function detectOnsets(signal: Float32Array, sampleRate: number, options: OnsetDetectionOptions = {}): Float32Array {
  const frameSize = options.frameSize ?? 1024
  const hopSize = options.hopSize ?? 256
  const thresholdMultiplier = options.thresholdMultiplier ?? 1.5
  const minIntervalSec = options.minIntervalSec ?? 0.05

  if (signal.length < frameSize) return new Float32Array(0)

  const flux = computeSpectralFlux(signal, frameSize, hopSize)
  const minIntervalFrames = Math.max(1, Math.round((minIntervalSec * sampleRate) / hopSize))
  const peakFrames = pickPeaks(flux, thresholdMultiplier, minIntervalFrames)

  const onsets = new Float32Array(peakFrames.length)
  for (let i = 0; i < peakFrames.length; i++) {
    onsets[i] = (peakFrames[i] * hopSize) / sampleRate
  }
  return onsets
}
