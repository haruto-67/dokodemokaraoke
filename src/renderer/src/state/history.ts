/**
 * スナップショットベースの Undo/Redo 履歴（§4.8）。
 * 100 操作以上保持する。ドラッグ中の中間状態は積まず、pointerup / 500ms 無操作でコミットする。
 */
export class HistoryManager<T> {
  private undoStack: T[] = []
  private redoStack: T[] = []
  private readonly maxSize: number
  private savedSnapshot: T | null = null

  constructor(initial: T, maxSize = 200) {
    this.maxSize = maxSize
    this.savedSnapshot = initial
  }

  /** 現在の状態を履歴に積んでからコミットする。呼び出し側は既に新状態を適用済みであること。 */
  commit(prevSnapshot: T): void {
    this.undoStack.push(prevSnapshot)
    if (this.undoStack.length > this.maxSize) this.undoStack.shift()
    this.redoStack = []
  }

  canUndo(): boolean {
    return this.undoStack.length > 0
  }

  canRedo(): boolean {
    return this.redoStack.length > 0
  }

  /** 現在の状態を渡し、直前のスナップショットを返す。redo 用に現在値を積む。 */
  undo(current: T): T | null {
    const prev = this.undoStack.pop()
    if (prev === undefined) return null
    this.redoStack.push(current)
    return prev
  }

  redo(current: T): T | null {
    const next = this.redoStack.pop()
    if (next === undefined) return null
    this.undoStack.push(current)
    return next
  }

  markSaved(current: T): void {
    this.savedSnapshot = current
  }

  isDirty(current: T): boolean {
    return current !== this.savedSnapshot
  }

  reset(initial: T): void {
    this.undoStack = []
    this.redoStack = []
    this.savedSnapshot = initial
  }
}
