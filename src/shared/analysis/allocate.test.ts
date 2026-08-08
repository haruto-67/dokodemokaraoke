import { describe, expect, it } from 'vitest'
import { allocateTokenTimings } from './allocate'
import type { Token } from '../tokenize'

function tok(text: string, ruby: string | null = null): Token {
  return { text, ruby }
}

describe('allocateTokenTimings', () => {
  it('スナップ候補が無ければモーラ重み比で線形配分する', () => {
    // 全て重み1の3トークン、行の長さ9秒 → 各3秒ずつ
    const tokens = [tok('あ'), tok('い'), tok('う')]
    const result = allocateTokenTimings(tokens, 0, 9)
    expect(result[0]).toMatchObject({ start: 0, end: 3 })
    expect(result[1]).toMatchObject({ start: 3, end: 6 })
    expect(result[2]).toMatchObject({ start: 6, end: 9 })
  })

  it('促音を含み重みが大きいトークンは配分時間も長くなる', () => {
    // 'あっ'(重み2) と 'い'(重み1) → 3:1の比で12秒を配分
    const tokens = [tok('あっ'), tok('い')]
    const result = allocateTokenTimings(tokens, 0, 12)
    expect(result[0].end - result[0].start).toBeCloseTo(8)
    expect(result[1].end - result[1].start).toBeCloseTo(4)
  })

  it('先頭トークンのstartは常に行の開始時刻、末尾トークンのendは常に行の終了時刻に一致する', () => {
    const tokens = [tok('あ'), tok('い'), tok('う')]
    const result = allocateTokenTimings(tokens, 1.5, 7.3)
    expect(result[0].start).toBe(1.5)
    expect(result[result.length - 1].end).toBe(7.3)
  })

  it('許容誤差内のオンセットに境界をスナップする', () => {
    const tokens = [tok('あ'), tok('い'), tok('う')]
    // 重み比のみだと境界は 3.0, 6.0。オンセット3.2秒(誤差0.2秒以内)にスナップされる
    const result = allocateTokenTimings(tokens, 0, 9, { onsetsSec: [3.2], snapToleranceSec: 0.3 })
    expect(result[0].end).toBeCloseTo(3.2)
    expect(result[1].start).toBeCloseTo(3.2)
  })

  it('許容誤差を超えて離れたオンセットにはスナップしない', () => {
    const tokens = [tok('あ'), tok('い'), tok('う')]
    const result = allocateTokenTimings(tokens, 0, 9, { onsetsSec: [4.5], snapToleranceSec: 0.3 })
    expect(result[0].end).toBeCloseTo(3)
  })

  it('ピッチ変化点にもスナップする', () => {
    const tokens = [tok('あ'), tok('い')]
    const result = allocateTokenTimings(tokens, 0, 6, { pitchChangePoints: [3.1], snapToleranceSec: 0.2 })
    expect(result[0].end).toBeCloseTo(3.1)
  })

  it('複数の内部境界が同じスナップ候補に吸着しても順序が崩れない(クランプされる)', () => {
    const tokens = [tok('あ'), tok('い'), tok('う'), tok('え')]
    // 境界は2.5,5,7.5。オンセット候補を境界1と境界2の両方に近い1点だけにする
    const result = allocateTokenTimings(tokens, 0, 10, { onsetsSec: [5.1], snapToleranceSec: 3 })
    for (let i = 1; i < result.length; i++) {
      expect(result[i].start).toBeGreaterThanOrEqual(result[i - 1].start)
      expect(result[i].start).toBe(result[i - 1].end)
    }
  })

  it('トークンが無い場合は空配列を返す', () => {
    expect(allocateTokenTimings([], 0, 10)).toEqual([])
  })

  it('単一トークンは行全体を占める', () => {
    const result = allocateTokenTimings([tok('あ')], 2, 5)
    expect(result).toEqual([{ text: 'あ', ruby: null, start: 2, end: 5 }])
  })
})
