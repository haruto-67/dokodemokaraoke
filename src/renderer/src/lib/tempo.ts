// 曲のテンポ(BPM)推定と拍グリッド計算(リズムスナップ用)

export interface Rhythm {
  bpm: number
  /** 基準となる拍の時刻(秒) */
  firstBeatSec: number
}

/**
 * 音声のオンセット強度(音の立ち上がりの強さ)の時系列。hopSizeサンプルごとの対数RMSの増加分(半波整流)。
 * 伴奏のドラム・ベース等のアタックを拾う目的なので、周波数分析はせず軽量な方式にしている。
 */
export function onsetStrengthEnvelope(
  channels: Float32Array[],
  sampleRate: number,
  hopSize = 512
): { envelope: Float32Array; frameRate: number } {
  const frameRate = sampleRate / hopSize
  const length = channels[0]?.length ?? 0
  const frameCount = Math.floor(length / hopSize)
  const envelope = new Float32Array(frameCount)
  if (channels.length === 0 || frameCount === 0) return { envelope, frameRate }

  let prevLog = 0
  for (let f = 0; f < frameCount; f++) {
    let sum = 0
    const offset = f * hopSize
    for (let i = 0; i < hopSize; i++) {
      let v = 0
      for (const ch of channels) v += ch[offset + i]
      v /= channels.length
      sum += v * v
    }
    const logRms = Math.log(1e-6 + Math.sqrt(sum / hopSize))
    envelope[f] = f === 0 ? 0 : Math.max(0, logRms - prevLog)
    prevLog = logRms
  }
  return { envelope, frameRate }
}

/**
 * オンセット強度の自己相関からBPMを、櫛形の重ね合わせから拍の位相を推定する。
 * - 1〜4拍分のラグの相関を合算する: 倍/半分のテンポを取り違えにくくなり、長いラグほどBPMの分解能も上がる。
 * - ラグはフレーム単位の小数になるので線形補間で評価する(整数に丸めるとBPMが数%ずれる)。
 * 推定できなければnull(無音・短すぎる等)。
 */
export function estimateTempo(envelope: Float32Array, frameRate: number, minBpm = 70, maxBpm = 180): Rhythm | null {
  const n = envelope.length
  if (n < frameRate * 4) return null
  let mean = 0
  for (let i = 0; i < n; i++) mean += envelope[i]
  mean /= n
  const x = new Float32Array(n)
  for (let i = 0; i < n; i++) x[i] = envelope[i] - mean

  const beatWeights = [1, 0.8, 0.6, 0.5]
  const maxLag = Math.min(n - 1, Math.ceil((60 / minBpm) * frameRate * beatWeights.length) + 1)
  const ac = new Float64Array(maxLag + 1)
  for (let lag = 1; lag <= maxLag; lag++) {
    let sum = 0
    for (let i = 0; i + lag < n; i++) sum += x[i] * x[i + lag]
    // 重なり区間が短いラグほど和が小さくなる偏りを正規化する
    ac[lag] = sum / (n - lag)
  }
  const acAt = (lag: number): number => {
    const lo = Math.floor(lag)
    if (lo < 1 || lo + 1 > maxLag) return 0
    const frac = lag - lo
    return ac[lo] * (1 - frac) + ac[lo + 1] * frac
  }

  let bestBpm = 0
  let bestScore = 0
  for (let bpm = minBpm; bpm <= maxBpm + 1e-9; bpm += 0.1) {
    const lag = (60 / bpm) * frameRate
    let score = 0
    beatWeights.forEach((w, m) => {
      score += w * acAt(lag * (m + 1))
    })
    if (score > bestScore) {
      bestScore = score
      bestBpm = bpm
    }
  }
  if (bestBpm === 0) return null

  // 各フレームの強度はそのフレーム区間内の立ち上がりを表すので、区間の中心時刻の値として扱う
  const envAt = (t: number): number => {
    const pos = t * frameRate - 0.5
    const lo = Math.floor(pos)
    if (lo < 0 || lo + 1 >= n) return 0
    const frac = pos - lo
    return envelope[lo] * (1 - frac) + envelope[lo + 1] * frac
  }
  const period = 60 / bestBpm
  const durationSec = n / frameRate
  let bestPhase = 0
  let bestPhaseScore = -Infinity
  for (let phase = 0; phase < period; phase += 0.005) {
    let score = 0
    for (let t = phase; t < durationSec; t += period) score += envAt(t)
    if (score > bestPhaseScore) {
      bestPhaseScore = score
      bestPhase = phase
    }
  }
  return { bpm: Math.round(bestBpm * 10) / 10, firstBeatSec: Math.round(bestPhase * 1000) / 1000 }
}

/** fromSec〜toSecの範囲にある拍グリッド(1拍をdivision等分した位置)の時刻(昇順) */
export function beatGridTimes(rhythm: Rhythm, division: number, fromSec: number, toSec: number): number[] {
  if (division <= 0 || rhythm.bpm <= 0) return []
  const step = 60 / rhythm.bpm / division
  const first = Math.ceil((fromSec - rhythm.firstBeatSec) / step - 1e-9)
  const last = Math.floor((toSec - rhythm.firstBeatSec) / step + 1e-9)
  const times: number[] = []
  for (let k = first; k <= last; k++) times.push(rhythm.firstBeatSec + k * step)
  return times
}

/** tに最も近い拍グリッドの時刻 */
export function nearestBeatGridTime(t: number, rhythm: Rhythm, division: number): number {
  if (division <= 0 || rhythm.bpm <= 0) return t
  const step = 60 / rhythm.bpm / division
  return rhythm.firstBeatSec + Math.round((t - rhythm.firstBeatSec) / step) * step
}
