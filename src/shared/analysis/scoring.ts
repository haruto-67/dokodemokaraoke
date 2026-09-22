/**
 * 採点ロジック(要件定義書v3 §4.12.3)。
 *
 * §4.4.4のノート列を基準に、歌唱ピッチとの一致度から音程正確率を算出する純粋関数。
 * ブラウザAPI(Web Audio/getUserMedia等)には一切依存せず、配列を受け取って結果を返すだけ
 * なのでテストしやすい(実際のマイク入力からのサンプル収集・時刻の遅延補正は呼び出し側の責務)。
 */
import type { DokokaraNote } from '../types'

export interface SungPitchSample {
  timeSec: number
  /** 検出できなかった/無声区間は0 */
  hz: number
}

export interface NoteScoreBreakdown {
  note: DokokaraNote
  /** そのノート区間内の音程正確率(0..1) */
  accuracy: number
}

export interface ScoringResult {
  /** 0..100 */
  totalScore: number
  notes: NoteScoreBreakdown[]
  categories: {
    /** お手本の音程に収まった割合 */
    pitch: number
    /** 各ノート開始付近で発声できたタイミング精度 */
    rhythm: number
    /** お手本ノート区間で声が検出された割合 */
    voice: number
  }
}

export interface ScorePerformanceOptions {
  /** この半音数以内の差(オクターブ折りたたみ後)を「音程が合っている」とみなす */
  toleranceSemitones?: number
  /** キー変更(移調、§4.12)の半音数。歌唱者は移調後の音程で歌うため、ノートのpitchMidiに
   *  この値を加算してから比較する(analysis.notesの生データ自体は変更しない)。既定0。 */
  keySemitones?: number
}

/**
 * 歌唱ピッチをMIDIノート番号(小数)に変換する。
 */
function hzToMidi(hz: number): number {
  return 69 + 12 * Math.log2(hz / 440)
}

/**
 * 2つのMIDIノート番号の差を、オクターブ違いを同一視した-6〜+6の範囲に折りたたむ
 * (要件定義書v3 §4.12.3「オクターブ違いは一致として扱う」)。
 */
function foldOctaveDiff(diff: number): number {
  let diffMod = ((diff % 12) + 12) % 12
  if (diffMod > 6) diffMod -= 12
  return diffMod
}

export function scorePerformance(
  notes: DokokaraNote[],
  sungPitch: SungPitchSample[],
  options: ScorePerformanceOptions = {}
): ScoringResult {
  const toleranceSemitones = options.toleranceSemitones ?? 1.0
  const keySemitones = options.keySemitones ?? 0

  const noteBreakdowns: NoteScoreBreakdown[] = notes.map((note) => {
    // ノート区間外のサンプルは完全に無視する(ノートが存在しない時間の発声は減点対象にしない §4.12.3)
    const voicedSamplesInNote = sungPitch.filter(
      (sample) => sample.timeSec >= note.start && sample.timeSec < note.end && sample.hz > 0
    )

    if (voicedSamplesInNote.length === 0) {
      // そのノートを一度も歌わなかった扱い
      return { note, accuracy: 0 }
    }

    const correctCount = voicedSamplesInNote.filter((sample) => {
      const diffSemitones = foldOctaveDiff(hzToMidi(sample.hz) - (note.pitchMidi + keySemitones))
      return Math.abs(diffSemitones) <= toleranceSemitones
    }).length

    return { note, accuracy: correctCount / voicedSamplesInNote.length }
  })

  const totalDuration = notes.reduce((sum, note) => sum + (note.end - note.start), 0)
  const pitchScore =
    totalDuration > 0
      ? (100 * noteBreakdowns.reduce((sum, b) => sum + b.accuracy * (b.note.end - b.note.start), 0)) / totalDuration
      : 0

  const weightedRhythm = notes.reduce((sum, note) => {
    const duration = Math.max(0, note.end - note.start)
    const nearbyVoiced = sungPitch.filter(
      (sample) => sample.hz > 0 && sample.timeSec >= note.start - 0.25 && sample.timeSec <= Math.min(note.end, note.start + 0.4)
    )
    if (nearbyVoiced.length === 0) return sum
    const onsetErrorSec = Math.min(...nearbyVoiced.map((sample) => Math.abs(sample.timeSec - note.start)))
    const accuracy = Math.max(0, 1 - onsetErrorSec / 0.25)
    return sum + accuracy * duration
  }, 0)
  const rhythmScore = totalDuration > 0 ? (100 * weightedRhythm) / totalDuration : 0

  const weightedVoice = notes.reduce((sum, note) => {
    const duration = Math.max(0, note.end - note.start)
    const samples = sungPitch.filter((sample) => sample.timeSec >= note.start && sample.timeSec < note.end)
    const voicedRatio = samples.length > 0 ? samples.filter((sample) => sample.hz > 0).length / samples.length : 0
    return sum + voicedRatio * duration
  }, 0)
  const voiceScore = totalDuration > 0 ? (100 * weightedVoice) / totalDuration : 0

  // 従来の総合点(音程正確率)は互換性のため維持し、詳細を項目別に提示する。
  const totalScore = pitchScore

  return {
    totalScore,
    notes: noteBreakdowns,
    categories: { pitch: pitchScore, rhythm: rhythmScore, voice: voiceScore }
  }
}
