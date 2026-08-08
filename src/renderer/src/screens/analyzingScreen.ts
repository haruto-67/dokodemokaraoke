import type { AppContext } from '../appContext'
import type { ScreenHandle } from '../lib/screen'
import { el } from '../lib/dom'

/**
 * 解析中画面(§3 画面 #2)の暫定実装。
 * 実際の解析パイプライン(§4.4)は後続タスクで接続する。今は準備画面からの遷移先として
 * プレースホルダー表示のみ行い、キャンセルで準備画面へ戻れるようにする。
 */
export function mountAnalyzingScreen(container: HTMLElement, ctx: AppContext): ScreenHandle {
  const root = el('div', { className: 'analyzing-screen' })

  root.append(
    el('div', { className: 'analyzing-body' }, [
      el('div', { className: 'analyzing-spinner' }),
      el('p', { className: 'analyzing-label' }, ['解析パイプラインは準備中です']),
      el('button', { className: 'btn btn-ghost' }, ['準備画面へ戻る'])
    ])
  )
  ;(root.querySelector('button') as HTMLButtonElement).addEventListener('click', () => ctx.navigate('setup'))

  container.appendChild(root)

  return {
    unmount() {
      container.removeChild(root)
    }
  }
}
