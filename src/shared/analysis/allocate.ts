// STEP 8: 文字タイミングの初期配分(要件定義書 §4.4.8, §4.6.3)
import { tokenWeight, type Token } from '../tokenize'

export interface TimedToken extends Token {
  start: number
  end: number
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

  for (let i = 1; i < boundaries.length - 1; i++) {
    let nearest: number | null = null
    let nearestDist = Infinity
    for (const c of snapCandidates) {
      const dist = Math.abs(c - boundaries[i])
      if (dist < nearestDist) {
        nearestDist = dist
        nearest = c
      }
    }
    if (nearest !== null && nearestDist <= tolerance) boundaries[i] = nearest
  }

  // スナップにより境界の前後関係が崩れないようクランプする
  for (let i = 1; i < boundaries.length; i++) {
    if (boundaries[i] < boundaries[i - 1]) boundaries[i] = boundaries[i - 1]
  }

  return tokens.map((t, i) => ({ ...t, start: boundaries[i], end: boundaries[i + 1] }))
}
