// リザルト画面(§4.12.4「区間別の内訳」)向けに、ノート単位の採点結果を歌詞行単位に集計する。
import type { DokokaraLine } from '@shared/types'
import type { NoteScoreBreakdown } from '@shared/analysis/scoring'

/**
 * 各歌詞行に、その行の時間範囲と重なるノートの正確率をノート長で重み付け平均して割り当てる。
 * 重なるノートが1つも無い行(間奏中の空行など)はnull(内訳表示ではスキップする想定)。
 */
export function scoreForLine(line: DokokaraLine, noteBreakdowns: NoteScoreBreakdown[]): number | null {
  const overlapping = noteBreakdowns.filter((b) => b.note.start < line.end && b.note.end > line.start)
  const totalDuration = overlapping.reduce((sum, b) => sum + (b.note.end - b.note.start), 0)
  if (totalDuration <= 0) return null
  const weightedSum = overlapping.reduce((sum, b) => sum + b.accuracy * (b.note.end - b.note.start), 0)
  return (100 * weightedSum) / totalDuration
}
