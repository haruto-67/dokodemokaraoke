import { describe, expect, it, vi } from 'vitest'
import { Store } from './store'

describe('Store', () => {
  it('初期状態をgetStateで取得できる', () => {
    const store = new Store({ count: 0 })
    expect(store.getState()).toEqual({ count: 0 })
  })

  it('setStateは既存の状態にパッチをマージする', () => {
    const store = new Store({ a: 1, b: 2 })
    store.setState({ b: 3 })
    expect(store.getState()).toEqual({ a: 1, b: 3 })
  })

  it('setStateに関数を渡すと直前の状態を受け取れる', () => {
    const store = new Store({ count: 1 })
    store.setState((prev) => ({ count: prev.count + 1 }))
    expect(store.getState().count).toBe(2)
  })

  it('subscribeしたリスナーはsetStateのたびに呼ばれる', () => {
    const store = new Store({ count: 0 })
    const listener = vi.fn()
    store.subscribe(listener)
    store.setState({ count: 1 })
    expect(listener).toHaveBeenCalledWith({ count: 1 })
  })

  it('unsubscribe後はリスナーが呼ばれない', () => {
    const store = new Store({ count: 0 })
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)
    unsubscribe()
    store.setState({ count: 1 })
    expect(listener).not.toHaveBeenCalled()
  })
})
