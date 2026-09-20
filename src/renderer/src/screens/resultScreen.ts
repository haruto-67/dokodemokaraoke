import type { AppContext } from '../appContext'
import type { ScreenHandle } from '../lib/screen'
import { el } from '../lib/dom'
import { scoreForLine } from '../lib/scoreLines'

/**
 * リザルト画面(§3 画面 #5, §4.12.4)。
 * 歌い終わりに表示する採点結果。プロジェクトには保存せず、その場限りの表示。
 */
export function mountResultScreen(container: HTMLElement, ctx: AppContext): ScreenHandle {
  const root = el('div', { className: 'result-screen' })
  container.appendChild(root)

  const result = ctx.ui.getState().lastScoreResult
  const project = ctx.editor.store.getState().project
  const totalScore = Math.round(result?.totalScore ?? 0)

  const scoreValue = el('div', { className: 'result-score-value' }, [String(totalScore)])
  const scoreUnit = el('div', { className: 'result-score-unit' }, ['点'])
  const scoreWrap = el('div', { className: 'result-score-wrap' }, [scoreValue, scoreUnit])
  const title = el('h1', { className: 'result-title' }, ['お疲れさまでした'])

  const linesList = el('div', { className: 'result-lines' })
  if (result && project) {
    for (const line of project.lyrics) {
      if (!line.text) continue
      const lineScore = scoreForLine(line, result.notes)
      const row = el('div', { className: 'result-line-row' })
      row.append(
        el('span', { className: 'result-line-text' }, [line.text]),
        el('span', { className: 'mono result-line-score' }, [lineScore === null ? '—' : String(Math.round(lineScore))])
      )
      linesList.appendChild(row)
    }
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

  root.append(title, scoreWrap, linesList, controls)

  return {
    unmount() {
      container.removeChild(root)
    }
  }
}
