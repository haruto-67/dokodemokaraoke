import { describe, expect, it } from 'vitest'
import {
  SHORTCUT_ACTIONS,
  buildComboLookup,
  comboFromEvent,
  findConflict,
  formatCombo,
  resolveBindings,
  type KeyLike
} from './keybindings'

function key(k: string, code: string, mods: Partial<KeyLike> = {}): KeyLike {
  return { key: k, code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods }
}

describe('comboFromEvent', () => {
  it('スペースキーはSpaceになる', () => {
    expect(comboFromEvent(key(' ', 'Space'))).toBe('Space')
  })

  it('⌘とCtrlはどちらもModになる', () => {
    expect(comboFromEvent(key('k', 'KeyK', { metaKey: true }))).toBe('Mod+K')
    expect(comboFromEvent(key('k', 'KeyK', { ctrlKey: true }))).toBe('Mod+K')
  })

  it('矢印・英字にはShiftを付ける', () => {
    expect(comboFromEvent(key('ArrowLeft', 'ArrowLeft', { shiftKey: true }))).toBe('Shift+ArrowLeft')
    expect(comboFromEvent(key('T', 'KeyT', { shiftKey: true }))).toBe('Shift+T')
  })

  it('記号はShiftの結果がkeyに出ているのでShiftを付けない', () => {
    expect(comboFromEvent(key(':', 'Semicolon', { shiftKey: true }))).toBe(':')
  })

  it('macのAlt+英字で化けた文字ではなく物理キーの英字を使う', () => {
    expect(comboFromEvent(key('å', 'KeyA', { altKey: true }))).toBe('Alt+A')
  })

  it('修飾キー単体はnull', () => {
    expect(comboFromEvent(key('Shift', 'ShiftLeft', { shiftKey: true }))).toBeNull()
  })

  it('Mod+カンマ', () => {
    expect(comboFromEvent(key(',', 'Comma', { metaKey: true }))).toBe('Mod+,')
  })
})

describe('resolveBindings', () => {
  it('上書きが無ければ既定値、あれば上書き(空配列=未割り当て)', () => {
    expect(resolveBindings(undefined).playPause).toEqual(['Space'])
    expect(resolveBindings({ playPause: ['P'] }).playPause).toEqual(['P'])
    expect(resolveBindings({ addLine: [] }).addLine).toEqual([])
  })
})

describe('buildComboLookup', () => {
  it('組み合わせからアクションを引ける', () => {
    const lookup = buildComboLookup(resolveBindings(undefined))
    expect(lookup.get('Mod+K')).toBe('splitLine')
    expect(lookup.get('Backspace')).toBe('deleteLine')
    expect(lookup.get('Delete')).toBe('deleteLine')
  })
})

describe('findConflict', () => {
  it('他のアクションが使っている組み合わせを返す', () => {
    const bindings = resolveBindings(undefined)
    expect(findConflict(bindings, 'S', 'playPause')).toBe('toggleSnap')
    expect(findConflict(bindings, 'S', 'toggleSnap')).toBeNull()
  })
})

describe('formatCombo', () => {
  it('macとWindowsで修飾キーの表記を変える', () => {
    expect(formatCombo('Mod+Shift+Z', true)).toBe('⌘ + Shift + Z')
    expect(formatCombo('Mod+K', false)).toBe('Ctrl + K')
    expect(formatCombo('ArrowLeft', true)).toBe('←')
    expect(formatCombo('Mod++', false)).toBe('Ctrl + +')
  })
})

describe('SHORTCUT_ACTIONS', () => {
  it('idと既定の組み合わせに重複が無い', () => {
    const ids = SHORTCUT_ACTIONS.map((a) => a.id)
    expect(new Set(ids).size).toBe(ids.length)
    const combos = SHORTCUT_ACTIONS.flatMap((a) => a.defaults)
    expect(new Set(combos).size).toBe(combos.length)
  })
})
