// 本番画面のピッチ表示を「ノート単位」から「歌詞トークン(文字/ルビ単位)単位」にするための集計。
// トークンの時刻自体はallocateTokenTimings(モーラ重み配分、ルビ対応済み)がavg計算済みのものを
// そのまま使うため、ここではルビの有無を特別扱いする必要は無い(token.start/endを使うだけでよい)。
import type { DokokaraNote } from '../types'

export interface TimeRange {
  start: number
  end: number
}

/**
 * 各トークンの時間範囲(token.start〜token.end)に重なるノートのpitchMidiを、
 * 重なり時間で重み付け平均して1つのMIDIノート番号(小数)にする。
 * 重なるノートが1つも無いトークン(無声/ノート検出無し)はnullを返す。
 */
export function computeTokenPitchesMidi(tokens: TimeRange[], notes: DokokaraNote[]): (number | null)[] {
  return tokens.map((token) => {
    if (token.end <= token.start) return null
    let weightedSum = 0
    let totalOverlap = 0
    for (const note of notes) {
      const overlapStart = Math.max(token.start, note.start)
      const overlapEnd = Math.min(token.end, note.end)
      const overlap = overlapEnd - overlapStart
      if (overlap <= 0) continue
      weightedSum += note.pitchMidi * overlap
      totalOverlap += overlap
    }
    return totalOverlap > 0 ? weightedSum / totalOverlap : null
  })
}
