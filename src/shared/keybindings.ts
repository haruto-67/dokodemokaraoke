// 編集画面のキーボードショートカット定義と、キー入力→組み合わせ文字列の正規化

export type ShortcutActionId =
  | 'playPause'
  | 'seekBack'
  | 'seekForward'
  | 'seekBackLarge'
  | 'seekForwardLarge'
  | 'seekToStart'
  | 'prevLine'
  | 'nextLine'
  | 'deselect'
  | 'editLineText'
  | 'deleteLine'
  | 'addLine'
  | 'splitLine'
  | 'mergeLine'
  | 'reallocateLine'
  | 'setLineStart'
  | 'setLineEnd'
  | 'toggleTapMode'
  | 'tapConfirm'
  | 'tapBack'
  | 'toggleSnap'
  | 'cycleBeatSnap'
  | 'toggleGuides'
  | 'zoomIn'
  | 'zoomOut'
  | 'zoomFit'
  | 'speedDown'
  | 'speedUp'
  | 'speedReset'
  | 'offsetDecrease'
  | 'offsetIncrease'
  | 'offsetDecreaseLarge'
  | 'offsetIncreaseLarge'
  | 'goToPerform'
  | 'openSettings'

export interface ShortcutActionDef {
  id: ShortcutActionId
  /** 設定画面に出す説明 */
  label: string
  group: string
  /** 既定のキー組み合わせ(空=未割り当て) */
  defaults: string[]
}

/** 既定から変更したアクションの割り当てだけを保持する(空配列=割り当て解除) */
export type ShortcutOverrides = Partial<Record<ShortcutActionId, string[]>>

export const SHORTCUT_ACTIONS: ShortcutActionDef[] = [
  { id: 'playPause', label: '再生・一時停止', group: '再生', defaults: ['Space'] },
  { id: 'seekBack', label: '少し戻る', group: '再生', defaults: ['ArrowLeft'] },
  { id: 'seekForward', label: '少し進む', group: '再生', defaults: ['ArrowRight'] },
  { id: 'seekBackLarge', label: '大きく戻る', group: '再生', defaults: ['Shift+ArrowLeft'] },
  { id: 'seekForwardLarge', label: '大きく進む', group: '再生', defaults: ['Shift+ArrowRight'] },
  { id: 'seekToStart', label: '曲の先頭へ', group: '再生', defaults: ['Home'] },
  { id: 'prevLine', label: '前の行を選択', group: '行の編集', defaults: ['ArrowUp'] },
  { id: 'nextLine', label: '次の行を選択', group: '行の編集', defaults: ['ArrowDown'] },
  { id: 'deselect', label: '選択を解除', group: '行の編集', defaults: ['Escape'] },
  { id: 'editLineText', label: '選択行の歌詞を編集', group: '行の編集', defaults: ['Enter'] },
  { id: 'deleteLine', label: '選択行を削除', group: '行の編集', defaults: ['Backspace', 'Delete'] },
  { id: 'addLine', label: '再生位置に行を追加', group: '行の編集', defaults: ['N'] },
  { id: 'splitLine', label: '再生位置で行を分割', group: '行の編集', defaults: ['Mod+K'] },
  { id: 'mergeLine', label: '次の行と結合', group: '行の編集', defaults: ['Mod+J'] },
  { id: 'reallocateLine', label: '選択行の文字タイミングを自動で再配分', group: '行の編集', defaults: ['R'] },
  { id: 'setLineStart', label: '行の開始を再生位置にする', group: 'タイミング入力', defaults: ['I'] },
  { id: 'setLineEnd', label: '行の終了を再生位置にする', group: 'タイミング入力', defaults: ['O'] },
  { id: 'toggleTapMode', label: 'タップ入力モードの切り替え', group: 'タイミング入力', defaults: ['Shift+T'] },
  { id: 'tapConfirm', label: 'タップ入力: 次の文字の開始を確定', group: 'タイミング入力', defaults: ['T'] },
  { id: 'tapBack', label: 'タップ入力: 1文字戻る', group: 'タイミング入力', defaults: ['Shift+Backspace'] },
  { id: 'toggleSnap', label: 'スナップのオン/オフ', group: '表示・スナップ', defaults: ['S'] },
  { id: 'cycleBeatSnap', label: 'リズムスナップの音符を切り替え', group: '表示・スナップ', defaults: ['B'] },
  { id: 'toggleGuides', label: 'ガイド線の表示切り替え', group: '表示・スナップ', defaults: ['G'] },
  { id: 'zoomIn', label: '拡大', group: '表示・スナップ', defaults: ['+', '='] },
  { id: 'zoomOut', label: '縮小', group: '表示・スナップ', defaults: ['-'] },
  { id: 'zoomFit', label: '全体表示', group: '表示・スナップ', defaults: ['0'] },
  { id: 'speedDown', label: '再生速度を下げる', group: '再生速度・オフセット', defaults: ['['] },
  { id: 'speedUp', label: '再生速度を上げる', group: '再生速度・オフセット', defaults: [']'] },
  { id: 'speedReset', label: '再生速度を等速に戻す', group: '再生速度・オフセット', defaults: ['\\'] },
  { id: 'offsetDecrease', label: '表示オフセット −5ms', group: '再生速度・オフセット', defaults: [';'] },
  { id: 'offsetIncrease', label: '表示オフセット +5ms', group: '再生速度・オフセット', defaults: ["'"] },
  { id: 'offsetDecreaseLarge', label: '表示オフセット −50ms', group: '再生速度・オフセット', defaults: [] },
  { id: 'offsetIncreaseLarge', label: '表示オフセット +50ms', group: '再生速度・オフセット', defaults: [] },
  { id: 'goToPerform', label: '本番画面へ', group: '画面', defaults: ['Mod+Enter'] },
  { id: 'openSettings', label: '設定を開く', group: '画面', defaults: ['Mod+,'] }
]

export interface KeyLike {
  key: string
  code: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
}

const MODIFIER_ONLY_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Dead', 'Process', 'Unidentified'])

/**
 * キー入力を 'Mod+Shift+K' 形式の組み合わせ文字列にする。修飾キー単体の押下ならnull。
 * 英字・数字はe.codeから取る(macのAlt+英字でe.keyが'å'等に化けるため)。記号はShift込みの結果が
 * 既にe.keyに出ているのでShiftを付けない(キーボード配列ごとに記号の位置が違っても一貫させるため)。
 * Modはmacの⌘とWindowsのCtrlをまとめたもの。
 */
export function comboFromEvent(e: KeyLike): string | null {
  if (MODIFIER_ONLY_KEYS.has(e.key)) return null
  let main: string
  const letter = /^Key([A-Z])$/.exec(e.code)
  const digit = /^Digit([0-9])$/.exec(e.code)
  if (letter) main = letter[1]
  else if (digit && !e.shiftKey) main = digit[1]
  else if (e.key === ' ') main = 'Space'
  else if (e.key.length === 1) main = e.key.toUpperCase()
  else main = e.key

  const parts: string[] = []
  if (e.metaKey || e.ctrlKey) parts.push('Mod')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey && (main.length > 1 || /^[A-Z]$/.test(main))) parts.push('Shift')
  parts.push(main)
  return parts.join('+')
}

/** 既定値と上書きをマージした、アクションごとの有効な割り当て */
export function resolveBindings(overrides: ShortcutOverrides | undefined): Record<ShortcutActionId, string[]> {
  const result = {} as Record<ShortcutActionId, string[]>
  for (const def of SHORTCUT_ACTIONS) {
    const override = overrides?.[def.id]
    result[def.id] = Array.isArray(override) ? [...override] : [...def.defaults]
  }
  return result
}

/** 組み合わせ→アクションの逆引き表。同じ組み合わせが重複した場合は表の先のアクションを優先する */
export function buildComboLookup(bindings: Record<ShortcutActionId, string[]>): Map<string, ShortcutActionId> {
  const lookup = new Map<string, ShortcutActionId>()
  for (const def of SHORTCUT_ACTIONS) {
    for (const combo of bindings[def.id] ?? []) {
      if (!lookup.has(combo)) lookup.set(combo, def.id)
    }
  }
  return lookup
}

/** exceptId以外でcomboを使っているアクション(重複警告用)。無ければnull */
export function findConflict(
  bindings: Record<ShortcutActionId, string[]>,
  combo: string,
  exceptId: ShortcutActionId
): ShortcutActionId | null {
  for (const def of SHORTCUT_ACTIONS) {
    if (def.id !== exceptId && (bindings[def.id] ?? []).includes(combo)) return def.id
  }
  return null
}

const KEY_DISPLAY_NAMES: Record<string, string> = {
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
  Backspace: 'Backspace',
  Escape: 'Esc'
}

/** 表示用の文字列にする('Mod+K' → macなら'⌘ + K'、Windowsなら'Ctrl + K') */
export function formatCombo(combo: string, isMac: boolean): string {
  const m = /^((?:(?:Mod|Alt|Shift)\+)*)(.+)$/.exec(combo)
  if (!m) return combo
  const modifiers = m[1] ? m[1].slice(0, -1).split('+') : []
  const names: string[] = modifiers.map((mod) => {
    if (mod === 'Mod') return isMac ? '⌘' : 'Ctrl'
    if (mod === 'Alt') return isMac ? '⌥' : 'Alt'
    return 'Shift'
  })
  names.push(KEY_DISPLAY_NAMES[m[2]] ?? m[2])
  return names.join(' + ')
}
