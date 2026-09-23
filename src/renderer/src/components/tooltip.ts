import { el } from '../lib/dom'

const SHOW_DELAY_MS = 350
const MARGIN_PX = 8

/**
 * data-tip属性を持つ要素にカーソルを置くと説明を出すツールチップ。アプリ全体で1つだけマウントする。
 * ネイティブのtitle属性は表示までが遅く見た目も調整できないため自前で出す。
 */
export function mountTooltip(root: HTMLElement): void {
  const tip = el('div', { className: 'app-tooltip' })
  root.appendChild(tip)
  let current: HTMLElement | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  function hide(): void {
    if (timer) clearTimeout(timer)
    timer = null
    current = null
    tip.classList.remove('visible')
  }

  function show(target: HTMLElement): void {
    const text = target.dataset.tip
    if (!text || !target.isConnected) return
    tip.textContent = text
    tip.classList.add('visible')
    const rect = target.getBoundingClientRect()
    const tipRect = tip.getBoundingClientRect()
    let left = rect.left + rect.width / 2 - tipRect.width / 2
    left = Math.max(MARGIN_PX, Math.min(left, window.innerWidth - tipRect.width - MARGIN_PX))
    // 基本は要素の下に出し、画面下端にはみ出す場合だけ上に出す
    let top = rect.bottom + MARGIN_PX
    if (top + tipRect.height > window.innerHeight - MARGIN_PX) top = rect.top - tipRect.height - MARGIN_PX
    tip.style.left = `${left}px`
    tip.style.top = `${Math.max(MARGIN_PX, top)}px`
  }

  document.addEventListener('mouseover', (e) => {
    const target = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-tip]') ?? null
    if (target === current) return
    hide()
    if (!target) return
    current = target
    timer = setTimeout(() => show(target), SHOW_DELAY_MS)
  })
  // クリック・ドラッグ・キー操作の邪魔にならないよう、操作が始まったら消す
  document.addEventListener('pointerdown', hide, true)
  document.addEventListener('keydown', hide, true)
  window.addEventListener('blur', hide)
}
