// STEP 1: 2ファイルの時間軸アライメント(要件定義書 §4.4.1)
import { fftCrossCorrelate } from './fft'

export interface AlignmentResult {
  /** playback が analysis に対して何サンプル遅れているか(負値は playback が先行) */
  offsetSamples: number
  /** ピークの明瞭さ(0..1)。低いほど「別マスターの可能性」が高い */
  confidence: number
  /** false の場合、相関のピークが不明瞭でアライメント不能とみなす(STEP2はスキップされる) */
  alignable: boolean
}

const DEFAULT_WINDOW_SEC = 30
/** ピークが十分明瞭とみなす confidence の閾値 */
const CONFIDENCE_THRESHOLD = 0.15
/** 副ピーク探索時にメインピーク周辺を除外する半径(秒) */
const EXCLUSION_RADIUS_SEC = 0.05

function normalize(x: Float32Array): Float32Array {
  const len = x.length
  let mean = 0
  for (let i = 0; i < len; i++) mean += x[i]
  mean /= len || 1

  const out = new Float32Array(len)
  let sumSq = 0
  for (let i = 0; i < len; i++) {
    const v = x[i] - mean
    out[i] = v
    sumSq += v * v
  }
  const rms = Math.sqrt(sumSq / (len || 1)) || 1
  for (let i = 0; i < len; i++) out[i] /= rms
  return out
}

/** result[k] のピークインデックスを、b の a に対する符号付き遅延サンプル数へ変換する。詳細は fft.ts のドキュメントを参照。 */
function peakIndexToSignedDelay(peakIdx: number, n: number): number {
  let delay = (n - peakIdx) % n
  if (delay > n / 2) delay -= n
  return delay
}

/**
 * 生の相互相関 corr[k]=Σa[n]b[n-k] は N 個の項の和であり、無相関同士でも
 * その分散はおおよそ N(=重なりサンプル数)に比例して大きくなる。
 * 「和」をそのまま比較すると、無相関信号同士でも重なりが大きい lag ほど
 * 偶然大きな値が出やすく、見かけ上のピークが生まれてしまう。
 * 分散を lag によらず揃える(ホワイトニングする)には √N で割ればよい
 * (N で割ると平均は揃うが、今度は N が小さい lag ほど分散が相対的に大きくなり、
 * 逆方向にバイアスが生じてしまうため N ではなく √N で割る)。
 */
function overlapCount(lag: number, windowLen: number): number {
  return Math.max(0, windowLen - Math.abs(lag))
}

/** 検索対象とする lag の範囲。重なりが小さすぎる(=正規化後の値が不安定になる)領域は除外する。 */
const MIN_OVERLAP_FRACTION = 0.5

/**
 * ピークの明瞭さを、ピーク以外の領域(除外半径の外側)の統計量に対する
 * z-score として求める。単純な「二番目に高いピーク」との比較だと、周期的な音源
 * (倍音・単純な反復パターン)で複数の近い高さのピークが立つ場合に過小評価しやすいため、
 * 外側領域全体の平均・標準偏差との差を見る方式にしている。
 *
 * ただし候補 lag の個数が多いほど、無相関なノイズ同士でも「たまたま一番大きい値」の
 * z-score は大きくなる(極値統計: N 個から取った最大値の期待z-scoreは概ね √(2 ln N) )。
 * これを補正しないと、候補数が多いだけで無相関な音源にも高いconfidenceを与えてしまう。
 * そこで z を「ノイズ雲の下での期待最大z-score」で割った相対値を confidence の基準にする。
 */
function computeConfidence(normalized: Map<number, number>, peakIdx: number, peakVal: number, n: number, exclusionRadius: number): number {
  let sum = 0
  let sumSq = 0
  let count = 0
  for (const [i, v] of normalized) {
    const dist = Math.min(Math.abs(i - peakIdx), n - Math.abs(i - peakIdx))
    if (dist < exclusionRadius) continue
    sum += v
    sumSq += v * v
    count++
  }
  if (count === 0 || peakVal <= 0) return peakVal > 0 ? 1 : 0
  const mean = sum / count
  const variance = Math.max(0, sumSq / count - mean * mean)
  const std = Math.sqrt(variance) || 1e-9
  const z = (peakVal - mean) / std

  const expectedNoiseMaxZ = Math.sqrt(2 * Math.log(Math.max(2, count + 1)))
  const relativeZ = z / expectedNoiseMaxZ
  // relativeZ ≈ 1 は「無相関ノイズの中から最大値を選んだだけ」と統計的に見分けがつかない状態。
  // 3倍(ノイズ期待値の3倍のズレ)を confidence=1 の基準とする。
  return Math.max(0, Math.min(1, (relativeZ - 1) / 2))
}

/**
 * オンボーカル(analysis)とオフボーカル(playback)の先頭 windowSec 程度を用いて
 * FFTベースの相互相関からサンプル単位のズレ量を推定する(§4.4.1)。
 */
export function estimateAlignment(
  analysis: Float32Array,
  playback: Float32Array,
  sampleRate: number,
  windowSec: number = DEFAULT_WINDOW_SEC
): AlignmentResult {
  const windowLen = Math.max(1, Math.min(analysis.length, playback.length, Math.floor(windowSec * sampleRate)))
  if (analysis.length === 0 || playback.length === 0) {
    return { offsetSamples: 0, confidence: 0, alignable: false }
  }

  const a = normalize(analysis.subarray(0, windowLen))
  const b = normalize(playback.subarray(0, windowLen))

  const corr = fftCrossCorrelate(a, b)
  const n = corr.length
  const minOverlap = windowLen * MIN_OVERLAP_FRACTION

  // 重なりサンプル数で正規化した相関値。重なりが小さすぎる lag は候補から除外する。
  const normalized = new Map<number, number>()
  for (let i = 0; i < n; i++) {
    const lag = peakIndexToSignedDelay(i, n)
    const overlap = overlapCount(lag, windowLen)
    if (overlap < minOverlap) continue
    normalized.set(i, Math.abs(corr[i]) / Math.sqrt(overlap))
  }

  let peakIdx = 0
  let peakVal = -Infinity
  for (const [i, v] of normalized) {
    if (v > peakVal) {
      peakVal = v
      peakIdx = i
    }
  }
  if (normalized.size === 0) {
    return { offsetSamples: 0, confidence: 0, alignable: false }
  }

  const exclusionRadius = Math.max(1, Math.round(EXCLUSION_RADIUS_SEC * sampleRate))
  const confidence = computeConfidence(normalized, peakIdx, peakVal, n, exclusionRadius)

  const offsetSamples = peakIndexToSignedDelay(peakIdx, n)

  return {
    offsetSamples,
    confidence,
    alignable: confidence >= CONFIDENCE_THRESHOLD
  }
}
