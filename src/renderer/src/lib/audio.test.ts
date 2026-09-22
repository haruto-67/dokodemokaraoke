import { describe, expect, it } from 'vitest'
import { playbackFractionForOffset } from './audio'

describe('playbackFractionForOffset', () => {
  it('soundtouchjs向けに再生位置を0..1の割合へ変換する', () => {
    expect(playbackFractionForOffset(30, 120)).toBe(0.25)
  })

  it('範囲外と不正な長さを安全に丸める', () => {
    expect(playbackFractionForOffset(-1, 100)).toBe(0)
    expect(playbackFractionForOffset(150, 100)).toBe(1)
    expect(playbackFractionForOffset(10, 0)).toBe(0)
  })
})
