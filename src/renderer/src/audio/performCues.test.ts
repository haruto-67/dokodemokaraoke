import { describe, expect, it } from 'vitest'
import {
  computeStartCueSchedule,
  countInBeatForRemaining,
  COUNT_IN_TOTAL_LEAD_SEC,
  KEY_TONE_COUNT_GAP_SEC,
  KEY_TONE_DURATION_SEC
} from './performCues'

describe('computeStartCueSchedule', () => {
  it('キー提示音を聞き取れる長さまで伸ばす', () => {
    expect(KEY_TONE_DURATION_SEC).toBeGreaterThanOrEqual(2.5)
  })

  it('キー提示音、4カウント、歌い出しを重ねずに順番どおり配置する', () => {
    const schedule = computeStartCueSchedule(10, 1, true, true)
    expect(schedule.keyToneStartAt).toBe(10)
    expect(schedule.countInStartAt).toBe(10 + KEY_TONE_DURATION_SEC + KEY_TONE_COUNT_GAP_SEC)
    expect(schedule.firstLineStartAt).toBe(10 + KEY_TONE_DURATION_SEC + KEY_TONE_COUNT_GAP_SEC + COUNT_IN_TOTAL_LEAD_SEC)
    expect(schedule.songStartAt).toBe((schedule.firstLineStartAt ?? 0) - 1)
  })

  it('十分なイントロがあれば曲の開始を遅らせない', () => {
    const schedule = computeStartCueSchedule(10, 8, true, true)
    expect(schedule.songStartAt).toBe(10)
    expect(schedule.firstLineStartAt).toBe(18)
    expect(schedule.countInStartAt).toBe(16)
    expect(schedule.keyToneStartAt).toBe(16 - KEY_TONE_COUNT_GAP_SEC - KEY_TONE_DURATION_SEC)
  })

  it('4カウントなしではキー提示音が終わってから曲を始める', () => {
    const schedule = computeStartCueSchedule(10, 3, false, true)
    expect(schedule.keyToneStartAt).toBe(10)
    expect(schedule.countInStartAt).toBeNull()
    expect(schedule.songStartAt).toBe(10 + KEY_TONE_DURATION_SEC)
  })
})

describe('countInBeatForRemaining', () => {
  it('キー提示中は非表示にし、クリックに合わせて4・3・2・1を返す', () => {
    expect(countInBeatForRemaining(2.1)).toBeNull()
    expect(countInBeatForRemaining(2)).toBe(4)
    expect(countInBeatForRemaining(1.5)).toBe(3)
    expect(countInBeatForRemaining(1)).toBe(2)
    expect(countInBeatForRemaining(0.5)).toBe(1)
    expect(countInBeatForRemaining(0)).toBeNull()
  })
})
