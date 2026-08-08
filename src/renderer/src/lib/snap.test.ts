import { describe, expect, it } from 'vitest'
import { snapTime, nearestGridTime, SNAP_PRIORITY } from './snap'

const PPS = 100 // 100px/秒
const TOLERANCE_PX = 8

describe('snapTime', () => {
  it('判定距離内に候補が無ければそのままの値を返す', () => {
    const result = snapTime(5.0, [{ time: 6.0, priority: SNAP_PRIORITY.onset }], PPS, TOLERANCE_PX)
    expect(result).toBe(5.0)
  })

  it('判定距離内の候補に吸着する', () => {
    // 8px/100pps = 0.08秒以内
    const result = snapTime(5.0, [{ time: 5.05, priority: SNAP_PRIORITY.onset }], PPS, TOLERANCE_PX)
    expect(result).toBe(5.05)
  })

  it('複数候補が判定距離内にある場合、優先度が高い(priority値が小さい)方に吸着する', () => {
    const result = snapTime(
      5.0,
      [
        { time: 5.02, priority: SNAP_PRIORITY.grid }, // 遠いが優先度低い
        { time: 5.07, priority: SNAP_PRIORITY.playhead } // 近いが優先度最高
      ],
      PPS,
      TOLERANCE_PX
    )
    expect(result).toBe(5.07)
  })

  it('同じ優先度なら距離が近い方に吸着する', () => {
    const result = snapTime(
      5.0,
      [
        { time: 5.06, priority: SNAP_PRIORITY.onset },
        { time: 5.02, priority: SNAP_PRIORITY.onset }
      ],
      PPS,
      TOLERANCE_PX
    )
    expect(result).toBe(5.02)
  })

  it('ズーム率(pixelsPerSecond)が変わっても判定距離のピクセル数は一定になる', () => {
    // 200px/秒(2倍ズーム)だと許容誤差は0.04秒に縮む
    const farResult = snapTime(5.0, [{ time: 5.05, priority: SNAP_PRIORITY.onset }], 200, TOLERANCE_PX)
    expect(farResult).toBe(5.0) // 0.05秒 > 0.04秒なので吸着しない

    const nearResult = snapTime(5.0, [{ time: 5.03, priority: SNAP_PRIORITY.onset }], 200, TOLERANCE_PX)
    expect(nearResult).toBe(5.03) // 0.03秒 <= 0.04秒なので吸着する
  })

  it('候補が無ければそのままの値を返す', () => {
    expect(snapTime(3.3, [], PPS, TOLERANCE_PX)).toBe(3.3)
  })
})

describe('nearestGridTime', () => {
  it('既定の0.1秒グリッドで最も近い値に丸める', () => {
    expect(nearestGridTime(1.24)).toBeCloseTo(1.2)
    expect(nearestGridTime(1.26)).toBeCloseTo(1.3)
  })

  it('グリッド幅を指定できる', () => {
    expect(nearestGridTime(1.24, 0.5)).toBeCloseTo(1.0)
    expect(nearestGridTime(1.26, 0.5)).toBeCloseTo(1.5)
  })
})
