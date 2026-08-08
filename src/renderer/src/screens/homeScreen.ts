import type { AppContext } from '../appContext'
import type { ScreenHandle } from '../lib/screen'
import { el, clear, formatDateTime, formatTime } from '../lib/dom'
import type { ProjectSummary } from '@shared/types'
import { openProjectByPath, createNewProjectFlow } from '../lib/projectActions'

type SortKey = 'updatedAt' | 'createdAt' | 'name'

const RECENT_KEY = 'dokokara.recentProjectPath'

function getRecentPath(): string | null {
  try {
    return localStorage.getItem(RECENT_KEY)
  } catch {
    return null
  }
}

export function mountHomeScreen(container: HTMLElement, ctx: AppContext): ScreenHandle {
  let sortKey: SortKey = 'updatedAt'
  let query = ''
  let disposed = false

  const root = el('div', { className: 'home-screen' })
  container.appendChild(root)

  const header = el('div', { className: 'home-header' })
  const titleWrap = el('div', { className: 'home-title-wrap' }, [
    el('h1', { className: 'home-title' }, ['どこでもカラオケセット']),
    el('p', { className: 'home-subtitle' }, ['手持ちの楽曲から、自分専用のカラオケを作る'])
  ])
  const newBtn = el('button', { className: 'btn btn-primary' }, ['+ 新規作成'])
  newBtn.addEventListener('click', () => createNewProjectFlow(ctx))
  header.append(titleWrap, newBtn)

  const toolbar = el('div', { className: 'home-toolbar' })
  const searchInput = el('input', {
    type: 'search',
    placeholder: 'プロジェクト名で検索',
    className: 'home-search'
  }) as HTMLInputElement
  searchInput.addEventListener('input', () => {
    query = searchInput.value
    renderList()
  })

  const sortSelect = el('select', { className: 'home-sort' }) as HTMLSelectElement
  const sortOptions: [SortKey, string][] = [
    ['updatedAt', '更新日時'],
    ['createdAt', '作成日時'],
    ['name', '名前']
  ]
  for (const [value, label] of sortOptions) {
    sortSelect.appendChild(el('option', { value }, [label]))
  }
  sortSelect.addEventListener('change', () => {
    sortKey = sortSelect.value as SortKey
    renderList()
  })

  toolbar.append(searchInput, sortSelect)

  const listContainer = el('div', { className: 'home-grid' })
  const emptyState = el('div', { className: 'home-empty' }, [
    el('div', { className: 'home-empty-icon' }, ['🎤']),
    el('p', {}, ['プロジェクトはまだありません']),
    el('button', { className: 'btn btn-primary' }, ['最初のプロジェクトを作成'])
  ])
  ;(emptyState.querySelector('button') as HTMLButtonElement)?.addEventListener('click', () =>
    createNewProjectFlow(ctx)
  )

  root.append(header, toolbar, listContainer)

  function renderList(): void {
    if (disposed) return
    clear(listContainer)
    const all = ctx.ui.getState().homeSummaries
    const recentPath = getRecentPath()

    const filtered = query.trim()
      ? all.filter((s) => s.name.toLowerCase().includes(query.trim().toLowerCase()))
      : all.slice()

    filtered.sort((a, b) => {
      if (sortKey === 'name') return a.name.localeCompare(b.name, 'ja')
      if (sortKey === 'createdAt') return b.createdAt.localeCompare(a.createdAt)
      return b.updatedAt.localeCompare(a.updatedAt)
    })

    if (recentPath) {
      const idx = filtered.findIndex((s) => s.filePath === recentPath)
      if (idx > 0) {
        const [item] = filtered.splice(idx, 1)
        filtered.unshift(item)
      }
    }

    if (all.length === 0) {
      listContainer.appendChild(emptyState)
      return
    }

    for (const summary of filtered) {
      const isRecent = summary.filePath === recentPath
      listContainer.appendChild(renderCard(summary, isRecent))
    }
  }

  function renderCard(summary: ProjectSummary, isRecent: boolean): HTMLElement {
    const card = el('div', { className: `project-card panel${isRecent ? ' recent' : ''}` })

    const thumb = el('div', { className: 'project-thumb' })
    if (summary.waveformThumb && summary.waveformThumb.length > 0) {
      thumb.appendChild(renderWaveformSvg(summary.waveformThumb))
    } else {
      thumb.appendChild(el('div', { className: 'project-thumb-placeholder' }))
    }
    if (isRecent) thumb.appendChild(el('span', { className: 'recent-badge' }, ['最近開いた']))

    const body = el('div', { className: 'project-card-body' }, [
      el('div', { className: 'project-card-name' }, [summary.name]),
      el('div', { className: 'project-card-meta mono' }, [
        `${formatTime(summary.durationSec)} ・ ${summary.lineCount}行 ・ ${formatDateTime(summary.updatedAt)}`
      ])
    ])

    const actions = el('div', { className: 'project-card-actions' })
    const openBtn = el('button', { className: 'btn btn-ghost' }, ['開く'])
    openBtn.addEventListener('click', () => openProjectByPath(ctx, summary.filePath))

    const dupBtn = el('button', { className: 'btn btn-ghost' }, ['複製'])
    dupBtn.addEventListener('click', async (e) => {
      e.stopPropagation()
      await window.dokokara.duplicateProject(summary.filePath)
      await ctx.refreshHome()
    })

    const renameBtn = el('button', { className: 'btn btn-ghost' }, ['リネーム'])
    renameBtn.addEventListener('click', async (e) => {
      e.stopPropagation()
      const name = window.prompt('新しい名前', summary.name)
      if (!name) return
      await window.dokokara.renameProject(summary.filePath, name)
      await ctx.refreshHome()
    })

    const delBtn = el('button', { className: 'btn btn-danger' }, ['削除'])
    delBtn.addEventListener('click', async (e) => {
      e.stopPropagation()
      const ok = window.confirm(`「${summary.name}」をゴミ箱に移動しますか？`)
      if (!ok) return
      await window.dokokara.trashProject(summary.filePath)
      await ctx.refreshHome()
    })

    actions.append(openBtn, dupBtn, renameBtn, delBtn)
    card.append(thumb, body, actions)
    card.addEventListener('dblclick', () => openProjectByPath(ctx, summary.filePath))
    return card
  }

  const unsubUi = ctx.ui.subscribe((s) => {
    if (s.screen === 'home') renderList()
  })

  ctx.refreshHome().then(renderList)

  return {
    unmount() {
      disposed = true
      unsubUi()
      container.removeChild(root)
    }
  }
}

function renderWaveformSvg(samples: number[]): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(ns, 'svg')
  svg.setAttribute('viewBox', '0 0 200 48')
  svg.setAttribute('preserveAspectRatio', 'none')
  svg.classList.add('waveform-svg')
  const step = 200 / samples.length
  let d = ''
  samples.forEach((v, i) => {
    const x = i * step
    const h = Math.max(1, v * 44)
    const y = (48 - h) / 2
    d += `M${x.toFixed(2)},${y.toFixed(2)} v${h.toFixed(2)} `
  })
  const path = document.createElementNS(ns, 'path')
  path.setAttribute('d', d)
  path.setAttribute('stroke', 'var(--color-accent)')
  path.setAttribute('stroke-width', String(Math.max(1, step * 0.6)))
  path.setAttribute('opacity', '0.7')
  svg.appendChild(path)
  return svg
}
