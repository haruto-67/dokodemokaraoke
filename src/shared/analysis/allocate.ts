// STEP 8: 文字タイミングの初期配分(要件定義書 §4.4.8, §4.6.3)
import { tokenWeight, type Token } from '../tokenize'

export interface TimedToken extends Token {
  start: number
  end: number
}

/** 行区間内で実際にメロディノートが鳴っている範囲。前後の無音を文字へ配らないために使う。 */
export function melodyRangeForLine(
  lineStart: number,
  lineEnd: number,
  notes: Array<{ start: number; end: number }>
): { start: number; end: number } {
  const overlapping = notes.filter((note) => note.start < lineEnd && note.end > lineStart)
  if (overlapping.length === 0) return { start: lineStart, end: lineEnd }
  const start = Math.max(lineStart, Math.min(...overlapping.map((note) => note.start)))
  const end = Math.min(lineEnd, Math.max(...overlapping.map((note) => note.end)))
  return end > start ? { start, end } : { start: lineStart, end: lineEnd }
}

export interface AllocateTokenTimingsOptions {
  /** STEP5で検出したオンセット時刻(秒、行の範囲外も含めて渡してよい) */
  onsetsSec?: number[]
  /** 有意なピッチ変化点の時刻(秒) */
  pitchChangePoints?: number[]
  /** 境界をスナップ候補へ吸着させる許容誤差(秒)。省略時は行の長さに応じて決める */
  snapToleranceSec?: number
}

/**
 * 行の時間 [lineStart, lineEnd) をトークンへ配分する(§4.6.3)。
 * 1. モーラ重み比での線形配分を初期境界とする
 * 2〜3. 内部境界をオンセット位置・ピッチ変化点の近傍にスナップする
 * 4. スナップ候補が無い/遠い区間は重み比のままとする
 */
export function allocateTokenTimings(
  tokens: Token[],
  lineStart: number,
  lineEnd: number,
  options: AllocateTokenTimingsOptions = {}
): TimedToken[] {
  if (tokens.length === 0) return []

  const duration = Math.max(0, lineEnd - lineStart)
  const weights = tokens.map(tokenWeight)
  const totalWeight = weights.reduce((a, b) => a + b, 0) || tokens.length

  // 1. 重み付き配分
  const boundaries: number[] = [lineStart]
  let acc = 0
  for (const w of weights) {
    acc += w
    boundaries.push(lineStart + duration * (acc / totalWeight))
  }
  boundaries[boundaries.length - 1] = lineEnd // 丸め誤差を吸収し、必ず行末に一致させる

  // 2〜3. 内部境界(先頭・末尾は行の開始/終了に固定するため対象外)をスナップ候補に吸着させる
  const snapCandidates = [...(options.onsetsSec ?? []), ...(options.pitchChangePoints ?? [])]
    .filter((t) => t > lineStart && t < lineEnd)
    .sort((a, b) => a - b)
  const tolerance = options.snapToleranceSec ?? Math.min(0.15, duration * 0.2)

  const usedCandidates = new Set<number>()
  for (let i = 1; i < boundaries.length - 1; i++) {
    let nearest: number | null = null
    let nearestDist = Infinity
    for (const c of snapCandidates) {
      if (usedCandidates.has(c)) continue
      const dist = Math.abs(c - boundaries[i])
      if (dist < nearestDist) {
        nearestDist = dist
        nearest = c
      }
    }
    if (nearest !== null && nearestDist <= tolerance) {
      boundaries[i] = nearest
      usedCandidates.add(nearest)
    }
  }

  // スナップにより境界の前後関係が崩れないようクランプする
  for (let i = 1; i < boundaries.length; i++) {
    if (boundaries[i] < boundaries[i - 1]) boundaries[i] = boundaries[i - 1]
  }

  return tokens.map((t, i) => ({ ...t, start: boundaries[i], end: boundaries[i + 1] }))
}

/**
 * 解析(python/sidecar/vowel_align.py)がモーラごとに出した時刻を、表示トークンへそのまま割り当てる。
 * トークンはモーラ重み(tokenWeight)の数だけモーラを受け持ち、最初のモーラの開始〜最後のモーラの終了を
 * その文字の時間にする。モーラの間の無音(息継ぎ)は文字の間のすき間として残す。
 * 歌詞の読み(Python側のpyopenjtalk)とトークンのモーラ数が合わない時(英単語等)は、重みの比で
 * 対応するモーラを選ぶ。モーラが無ければnull(呼び出し側で均等配分にする)。
 */
export function timingsFromMorae(tokens: Token[], morae: Array<{ start: number; end: number }>): TimedToken[] | null {
  if (tokens.length === 0) return []
  if (morae.length === 0) return null
  const weights = tokens.map(tokenWeight)
  const totalWeight = weights.reduce((a, b) => a + b, 0)
  const exact = totalWeight === morae.length
  const moraIndexAt = (weight: number): number =>
    exact ? weight : totalWeight > 0 ? Math.round((weight / totalWeight) * morae.length) : 0

  const result: TimedToken[] = []
  let acc = 0
  let prevEnd = morae[0].start
  tokens.forEach((t, i) => {
    const first = Math.min(moraIndexAt(acc), morae.length - 1)
    acc += weights[i]
    const last = Math.min(moraIndexAt(acc), morae.length) - 1
    // 受け持つモーラが無い(重み0・比で丸めた)トークンは、直前の文字の終わりに長さ0で置く
    const start = last >= first ? Math.max(prevEnd, morae[first].start) : prevEnd
    const end = last >= first ? Math.max(start, morae[last].end) : start
    result.push({ ...t, start, end })
    prevEnd = end
  })
  return result
}

export interface PitchFrame {
  timeSec: number
  hz: number
  voiced: boolean
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
