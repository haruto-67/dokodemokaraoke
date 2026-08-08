import type { AppContext } from '../appContext'
import type { ScreenHandle } from '../lib/screen'
import { el } from '../lib/dom'
import { saveProject, confirmDiscardIfDirty } from '../lib/projectActions'

/**
 * 編集画面(§3 画面 #3)の暫定実装。
 * タイムライン・文字境界編集(§4.6〜§4.7)は後続タスクで実装する。
 * 今はプロジェクト名表示・保存・本番/ホームへの遷移のみ提供する。
 */
export function mountEditorScreen(container: HTMLElement, ctx: AppContext): ScreenHandle {
  const root = el('div', { className: 'editor-screen' })

  const header = el('div', { className: 'editor-header' })
  const title = el('h1', { className: 'editor-title' }, [ctx.editor.store.getState().project?.name ?? ''])
  const backBtn = el('button', { className: 'btn btn-ghost' }, ['← ホームへ'])
  const saveBtn = el('button', { className: 'btn btn-ghost' }, ['保存'])
  const performBtn = el('button', { className: 'btn btn-primary' }, ['本番へ →'])
  header.append(backBtn, title, saveBtn, performBtn)

  backBtn.addEventListener('click', async () => {
    if (!(await confirmDiscardIfDirty(ctx))) return
    ctx.navigate('home')
    await ctx.refreshHome()
  })
  saveBtn.addEventListener('click', () => void saveProject(ctx, false))
  performBtn.addEventListener('click', () => ctx.navigate('perform'))

  const body = el('div', { className: 'editor-body' }, [
    el('p', { className: 'editor-placeholder' }, ['タイムライン編集UIは準備中です。'])
  ])

  root.append(header, body)
  container.appendChild(root)

  const unsubUi = ctx.ui.subscribe((s) => {
    if (s.screen === 'editor') title.textContent = ctx.editor.store.getState().project?.name ?? ''
  })

  return {
    unmount() {
      unsubUi()
      container.removeChild(root)
    }
  }
}
