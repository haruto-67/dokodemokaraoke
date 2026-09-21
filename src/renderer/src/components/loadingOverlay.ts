import type { AppContext } from '../appContext'
import { el } from '../lib/dom'

/**
 * プロジェクト読み込み中(ZIP展開・音声デコード)のローディング表示。
 * ボタンを押してから画面遷移までラグがあり、押せたのか分かりにくいという報告への対応
 * (UiState.loadingProjectがtrueの間だけ表示する薄いオーバーレイ)。
 */
export function mountLoadingOverlay(root: HTMLElement, ctx: AppContext): void {
  const overlay = el('div', { className: 'loading-overlay' }, [el('div', { className: 'loading-spinner' })])
  root.appendChild(overlay)

  ctx.ui.subscribe((s) => overlay.classList.toggle('visible', s.loadingProject))
}
