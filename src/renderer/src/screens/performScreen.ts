import type { AppContext } from '../appContext'
import type { ScreenHandle } from '../lib/screen'
import { el } from '../lib/dom'

/**
 * 本番(カラオケ再生)画面(§3 画面 #4, §4.10)の暫定実装。
 * 文字送り・ルビ・ピッチガイド等は後続タスクで実装する。
 */
export function mountPerformScreen(container: HTMLElement, ctx: AppContext): ScreenHandle {
  const root = el('div', { className: 'perform-screen' })

  const backBtn = el('button', { className: 'btn btn-ghost perform-back' }, ['← 編集へ戻る'])
  backBtn.addEventListener('click', () => ctx.navigate('editor'))

  root.append(
    backBtn,
    el('div', { className: 'perform-placeholder' }, ['本番画面は準備中です。'])
  )

  container.appendChild(root)

  return {
    unmount() {
      container.removeChild(root)
    }
  }
}
