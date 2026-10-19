// 曲のテンポ(BPM)推定と拍グリッド計算(リズムスナップ・メトロノーム用)

export interface TempoChange {
  /** この時刻(秒、拍の頭)から後ろはbpmで拍が並ぶ */
  atSec: number
  bpm: number
}

export interface Rhythm {
  bpm: number
  /** 基準となる拍の時刻(秒) */
  firstBeatSec: number
  /** 途中のテンポ変更。firstBeatSecより後ろのものだけが有効 */
  changes?: TempoChange[]
}

/** 一定のBPMで拍が並ぶ区間。最初の区間は開始より前にも、最後の区間は終わりより後ろにも拍が続く */
export interface RhythmSegment {
  startSec: number
  /** 次の区間の開始(最後の区間はInfinity) */
  endSec: number
  bpm: number
  /** rhythm.changes内の位置。最初の区間(firstBeatSec〜)はnull */
  changeIndex: number | null
}

const MIN_SEGMENT_SEC = 0.05

/** テンポ変更を時刻順に並べた区間の一覧。最初の区間より前・同時刻の変更は無視する */
export function rhythmSegments(rhythm: Rhythm): RhythmSegment[] {
  const changes = (rhythm.changes ?? [])
    .map((c, i) => ({ ...c, i }))
    .filter((c) => c.bpm > 0 && c.atSec > rhythm.firstBeatSec + MIN_SEGMENT_SEC)
    .sort((a, b) => a.atSec - b.atSec)
  const segments: RhythmSegment[] = [{ startSec: rhythm.firstBeatSec, endSec: Infinity, bpm: rhythm.bpm, changeIndex: null }]
  for (const c of changes) {
    const prev = segments[segments.length - 1]
    if (c.atSec - prev.startSec < MIN_SEGMENT_SEC) continue
    prev.endSec = c.atSec
    segments.push({ startSec: c.atSec, endSec: Infinity, bpm: c.bpm, changeIndex: c.i })
  }
  return segments
}

/** 時刻tを含む区間(最初の区間より前はその最初の区間) */
export function segmentAt(rhythm: Rhythm, t: number): RhythmSegment {
  const segments = rhythmSegments(rhythm)
  for (let i = segments.length - 1; i > 0; i--) if (t >= segments[i].startSec) return segments[i]
  return segments[0]
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

export interface BeatGridPoint {
  time: number
  /** 拍の頭か(falseは拍を分割した位置) */
  onBeat: boolean
  /** 区間の開始(テンポ変更の位置)か */
  segmentStart: boolean
}

/** fromSec〜toSecの範囲にある拍グリッド(1拍をdivision等分した位置)。区間ごとのBPMで並べる(昇順) */
export function beatGridPoints(rhythm: Rhythm, division: number, fromSec: number, toSec: number): BeatGridPoint[] {
  if (division <= 0 || rhythm.bpm <= 0) return []
  const points: BeatGridPoint[] = []
  const segments = rhythmSegments(rhythm)
  segments.forEach((seg, si) => {
    const step = 60 / seg.bpm / division
    const lo = si === 0 ? fromSec : Math.max(fromSec, seg.startSec)
    const hi = Math.min(toSec, seg.endSec)
    if (lo > hi) return
    const first = Math.ceil((lo - seg.startSec) / step - 1e-9)
    for (let k = first; ; k++) {
      const time = seg.startSec + k * step
      // 次の区間の開始と同じ位置は次の区間側で数える
      if (time > hi + 1e-9 || time >= seg.endSec - 1e-6) break
      points.push({ time, onBeat: k % division === 0, segmentStart: si > 0 && k === 0 })
    }
  })
  return points
}

/** fromSec〜toSecの範囲にある拍グリッドの時刻(昇順) */
export function beatGridTimes(rhythm: Rhythm, division: number, fromSec: number, toSec: number): number[] {
  return beatGridPoints(rhythm, division, fromSec, toSec).map((p) => p.time)
}

/** tに最も近い拍グリッドの時刻 */
export function nearestBeatGridTime(t: number, rhythm: Rhythm, division: number): number {
  if (division <= 0 || rhythm.bpm <= 0) return t
  // 近傍の区間で最も長い拍間隔だけ前後を見れば、必ず最寄りのグリッドが含まれる
  const span = Math.max(...rhythmSegments(rhythm).map((s) => 60 / s.bpm / division))
  const points = beatGridTimes(rhythm, division, t - span, t + span)
  if (points.length === 0) return t
  return points.reduce((best, p) => (Math.abs(p - t) < Math.abs(best - t) ? p : best))
}

/** 時刻tの区間のBPM */
export function bpmAt(rhythm: Rhythm, t: number): number {
  return segmentAt(rhythm, t).bpm
}

/** 区間の開始時刻を書き換えた新しいRhythm(changeIndexがnullなら最初の拍) */
function withSegmentStart(rhythm: Rhythm, changeIndex: number | null, startSec: number): Rhythm {
  if (changeIndex === null) return { ...rhythm, firstBeatSec: startSec }
  const changes = (rhythm.changes ?? []).map((c, i) => (i === changeIndex ? { ...c, atSec: startSec } : c))
  return { ...rhythm, changes }
}

/** 区間を動かせる範囲(前後の区間の開始を追い越さない)。最初の区間は後ろの区間の手前まで */
function segmentStartBounds(rhythm: Rhythm, seg: RhythmSegment): { lo: number; hi: number } {
  const segments = rhythmSegments(rhythm)
  const i = segments.findIndex((s) => s.changeIndex === seg.changeIndex)
  const lo = i > 0 ? segments[i - 1].startSec + MIN_SEGMENT_SEC : -Infinity
  const hi = i + 1 < segments.length ? segments[i + 1].startSec - MIN_SEGMENT_SEC : Infinity
  return { lo, hi }
}

/** 区間の開始を指定時刻へ動かす(前後の区間を追い越さない範囲に収める) */
export function moveSegmentStart(rhythm: Rhythm, changeIndex: number | null, startSec: number): Rhythm {
  const seg = rhythmSegments(rhythm).find((s) => s.changeIndex === changeIndex)
  if (!seg) return rhythm
  const { lo, hi } = segmentStartBounds(rhythm, seg)
  return withSegmentStart(rhythm, changeIndex, Math.max(lo, Math.min(hi, startSec)))
}

/** 時刻tの区間の拍を、ちょうどtが拍の頭になるようにずらす(区間の長さはなるべく変えない) */
export function alignBeatAt(rhythm: Rhythm, t: number): Rhythm {
  const seg = segmentAt(rhythm, t)
  if (seg.changeIndex === null) return { ...rhythm, firstBeatSec: t }
  // 区間の開始を、tから拍間隔の整数倍だけ戻った位置のうち元の開始に最も近い所へ
  const step = 60 / seg.bpm
  const k = Math.round((t - seg.startSec) / step)
  return moveSegmentStart(rhythm, seg.changeIndex, t - k * step)
}

/** 時刻tの区間の拍をdeltaSecだけずらす */
export function nudgeBeatsAt(rhythm: Rhythm, t: number, deltaSec: number): Rhythm {
  const seg = segmentAt(rhythm, t)
  return moveSegmentStart(rhythm, seg.changeIndex, seg.startSec + deltaSec)
}

/** 時刻tの区間のBPMを書き換える */
export function setBpmAt(rhythm: Rhythm, t: number, bpm: number): Rhythm {
  const seg = segmentAt(rhythm, t)
  if (seg.changeIndex === null) return { ...rhythm, bpm }
  const changes = (rhythm.changes ?? []).map((c, i) => (i === seg.changeIndex ? { ...c, bpm } : c))
  return { ...rhythm, changes }
}

/** 時刻tからテンポを変える区間を追加する(BPMはその時点のものを引き継ぐ)。最初の拍より前や、既存の区間の開始と近すぎる時はnull */
export function addTempoChange(rhythm: Rhythm, t: number): Rhythm | null {
  const segments = rhythmSegments(rhythm)
  if (t <= rhythm.firstBeatSec + MIN_SEGMENT_SEC) return null
  if (segments.some((s) => Math.abs(s.startSec - t) < MIN_SEGMENT_SEC)) return null
  return { ...rhythm, changes: [...(rhythm.changes ?? []), { atSec: t, bpm: bpmAt(rhythm, t) }] }
}

/** テンポ変更を削除する */
export function removeTempoChange(rhythm: Rhythm, changeIndex: number): Rhythm {
  const changes = (rhythm.changes ?? []).filter((_, i) => i !== changeIndex)
  return { ...rhythm, changes }
}

/** 無効になったテンポ変更(最初の拍より前・重複)を取り除いて時刻順に並べ直す */
export function normalizeRhythm(rhythm: Rhythm): Rhythm {
  const segments = rhythmSegments(rhythm)
  const changes = segments.slice(1).map((s) => ({ atSec: s.startSec, bpm: s.bpm }))
  return changes.length > 0 ? { bpm: rhythm.bpm, firstBeatSec: rhythm.firstBeatSec, changes } : { bpm: rhythm.bpm, firstBeatSec: rhythm.firstBeatSec }
}
