import type { AppContext } from '../appContext'
import type { ScreenHandle } from '../lib/screen'
import { el } from '../lib/dom'

/**
 * リザルト画面(§3 画面 #5, §4.12.4)。
 * 歌い終わりに表示する採点結果。プロジェクトには保存せず、その場限りの表示。
 */
export function mountResultScreen(container: HTMLElement, ctx: AppContext): ScreenHandle {
  const root = el('div', { className: 'result-screen' })
  container.appendChild(root)

  const result = ctx.ui.getState().lastScoreResult
  const totalScore = Math.round(result?.totalScore ?? 0)

  const scoreValue = el('div', { className: 'result-score-value' }, [String(totalScore)])
  const scoreUnit = el('div', { className: 'result-score-unit' }, ['点'])
  const scoreWrap = el('div', { className: 'result-score-wrap' }, [scoreValue, scoreUnit])
  const title = el('h1', { className: 'result-title' }, ['お疲れさまでした'])

  const categoryList = el('div', { className: 'result-categories' })
  const categories = [
    { label: '音程', value: result?.categories.pitch ?? 0, detail: 'お手本の音程との一致度' },
    { label: 'リズム', value: result?.categories.rhythm ?? 0, detail: '歌い出しのタイミング' },
    { label: '発声率', value: result?.categories.voice ?? 0, detail: '歌唱区間で声を検出した割合' }
  ]
  for (const category of categories) {
    const card = el('div', { className: 'result-category-card' })
    const meter = el('div', { className: 'result-category-meter' })
    const meterFill = el('div', { className: 'result-category-meter-fill' })
    meterFill.style.width = `${Math.max(0, Math.min(100, category.value))}%`
    meter.appendChild(meterFill)
    card.append(
      el('span', { className: 'result-category-label' }, [category.label]),
      el('span', { className: 'result-category-detail' }, [category.detail]),
      meter,
      el('span', { className: 'mono result-category-score' }, [String(Math.round(category.value))])
    )
    categoryList.appendChild(card)
  }

  const backToEditorBtn = el('button', { className: 'btn btn-ghost' }, ['編集画面へ戻る'])
  backToEditorBtn.addEventListener('click', () => ctx.navigate('editor'))
  const retryBtn = el('button', { className: 'btn btn-primary' }, ['もう一度歌う'])
  retryBtn.addEventListener('click', () => {
    ctx.playback.seek(0)
    ctx.navigate('perform')
  })
  const homeBtn = el('button', { className: 'btn btn-ghost' }, ['ホームへ'])
  homeBtn.addEventListener('click', () => ctx.navigate('home'))
  const controls = el('div', { className: 'result-controls' }, [homeBtn, backToEditorBtn, retryBtn])

  root.append(title, scoreWrap, categoryList, controls)

  return {
    unmount() {
      container.removeChild(root)
    }
  }
}
