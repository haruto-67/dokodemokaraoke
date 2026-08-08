// タイムライン上のドラッグ操作向けスナップ機構(要件定義書 §4.7.3)

export interface SnapTarget {
  time: number
  /** 数値が小さいほど優先度が高い(1: プレイヘッド 〜 5: グリッド) */
  priority: number
}

export const SNAP_PRIORITY = {
  playhead: 1,
  adjacentBlockEdge: 2,
  phraseBoundary: 3,
  onset: 4,
  grid: 5
} as const

/** 0.1秒グリッド上でcandidateTimeに最も近い時刻を返す */
export function nearestGridTime(candidateTime: number, gridSec = 0.1): number {
  return Math.round(candidateTime / gridSec) * gridSec
}

/**
 * candidateTime を snapTargets の中から判定距離(ピクセル)内にある最優先候補へ吸着させる。
 * 判定距離をピクセルで扱うのは、ズーム率が変わっても操作感を変えないため(§4.7.3)。
 * 複数候補が判定距離内にある場合、priority値が小さい(優先度が高い)ものを採用する。
 */
export function snapTime(
  candidateTime: number,
  snapTargets: SnapTarget[],
  pixelsPerSecond: number,
  tolerancePx: number
): number {
  if (pixelsPerSecond <= 0) return candidateTime
  const tolerance = tolerancePx / pixelsPerSecond

  let best: SnapTarget | null = null
  let bestDist = Infinity
  for (const target of snapTargets) {
    const dist = Math.abs(target.time - candidateTime)
    if (dist > tolerance) continue
    if (best === null || target.priority < best.priority || (target.priority === best.priority && dist < bestDist)) {
      best = target
      bestDist = dist
    }
  }
  return best ? best.time : candidateTime
}
