import { describe, expect, it } from 'vitest'
import { HistoryManager } from './history'

describe('HistoryManager', () => {
  it('commit後にundoすると直前のスナップショットへ戻る', () => {
    const history = new HistoryManager<number>(0)
    history.commit(0)
    const prev = history.undo(1)
    expect(prev).toBe(0)
  })

  it('undo後にredoすると現在値へ戻る', () => {
    const history = new HistoryManager<number>(0)
    history.commit(0)
    history.undo(1)
    const next = history.redo(0)
    expect(next).toBe(1)
  })

  it('新規commitはredoスタックをクリアする(§4.8)', () => {
    const history = new HistoryManager<number>(0)
    history.commit(0)
    history.undo(1)
    expect(history.canRedo()).toBe(true)
    history.commit(0)
    expect(history.canRedo()).toBe(false)
  })

  it('履歴が無い状態でのundo/redoはnullを返す', () => {
    const history = new HistoryManager<number>(0)
    expect(history.undo(0)).toBeNull()
    expect(history.redo(0)).toBeNull()
  })

  it('maxSizeを超えた履歴は古いものから破棄する', () => {
    const history = new HistoryManager<number>(0, 3)
    for (let i = 1; i <= 5; i++) history.commit(i)
    // 3件までしか保持しないため、5回undoできない(3回で尽きる)
    expect(history.undo(6)).not.toBeNull()
    expect(history.undo(5)).not.toBeNull()
    expect(history.undo(4)).not.toBeNull()
    expect(history.undo(3)).toBeNull()
  })

  it('markSavedした値と一致する間はisDirtyがfalse', () => {
    const history = new HistoryManager<number>(0)
    expect(history.isDirty(0)).toBe(false)
    history.markSaved(5)
    expect(history.isDirty(5)).toBe(false)
    expect(history.isDirty(6)).toBe(true)
  })
})
