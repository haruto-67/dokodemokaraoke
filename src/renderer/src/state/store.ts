export type Listener<T> = (state: T) => void

/** 最小限の pub/sub ストア */
export class Store<T> {
  private state: T
  private listeners = new Set<Listener<T>>()

  constructor(initial: T) {
    this.state = initial
  }

  getState(): T {
    return this.state
  }

  setState(patch: Partial<T> | ((prev: T) => Partial<T>)): void {
    const p = typeof patch === 'function' ? (patch as (prev: T) => Partial<T>)(this.state) : patch
    this.state = { ...this.state, ...p }
    for (const l of this.listeners) l(this.state)
  }

  subscribe(listener: Listener<T>): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}
