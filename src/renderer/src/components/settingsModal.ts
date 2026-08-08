import type { AppContext } from '../appContext'
import { el } from '../lib/dom'
import { notifyError } from '../lib/projectActions'

/**
 * 設定モーダル(§4.2, §3)。いずれの画面からも ⌘, で開ける。
 * appルート直下に一度だけマウントし、ctx.ui.settingsOpen の変化で表示/非表示を切り替える。
 */
export function mountSettingsModal(root: HTMLElement, ctx: AppContext): void {
  const overlay = el('div', { className: 'settings-overlay' })
  const modal = el('div', { className: 'settings-modal panel' })
  overlay.appendChild(modal)
  root.appendChild(overlay)

  const headerRow = el('div', { className: 'settings-header' }, [el('h2', {}, ['設定']), el('button', { className: 'btn btn-ghost' }, ['閉じる'])])
  const closeBtn = headerRow.querySelector('button') as HTMLButtonElement
  closeBtn.addEventListener('click', () => ctx.closeSettings())
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) ctx.closeSettings()
  })

  const body = el('div', { className: 'settings-body' })
  modal.append(headerRow, body)

  // --- プロジェクトの保存先フォルダ ---
  const dirRow = settingsRow('プロジェクトの保存先フォルダ')
  const dirPathLabel = el('span', { className: 'mono settings-path' }, [''])
  const dirChangeBtn = el('button', { className: 'btn btn-ghost' }, ['変更…'])
  dirChangeBtn.addEventListener('click', async () => {
    const picked = await window.dokokara.pickDirectory()
    if (!picked) return
    await patchSettings({ projectsDir: picked })
  })
  dirRow.control.append(dirPathLabel, dirChangeBtn)

  // --- 自動バックアップ間隔(分) ---
  const backupRow = settingsRow('自動バックアップ間隔(分)')
  const backupInput = el('input', { type: 'number', min: '1', step: '1' }) as HTMLInputElement
  backupInput.addEventListener('change', () => {
    const minutes = Math.max(1, Number(backupInput.value) || 1)
    void patchSettings({ autoBackupIntervalMs: minutes * 60 * 1000 })
  })
  backupRow.control.appendChild(backupInput)

  // --- スナップ ---
  const snapEnabledRow = settingsRow('スナップ')
  const snapEnabledInput = el('input', { type: 'checkbox' }) as HTMLInputElement
  snapEnabledInput.addEventListener('change', () => void patchSettings({ snapEnabled: snapEnabledInput.checked }))
  snapEnabledRow.control.appendChild(snapEnabledInput)

  const snapDistanceRow = settingsRow('スナップ判定距離(px)')
  const snapDistanceInput = el('input', { type: 'number', min: '1', step: '1' }) as HTMLInputElement
  snapDistanceInput.addEventListener('change', () => {
    const px = Math.max(1, Number(snapDistanceInput.value) || 1)
    void patchSettings({ snapDistancePx: px })
  })
  snapDistanceRow.control.appendChild(snapDistanceInput)

  // --- シーク量 ---
  const seekRow = settingsRow('シーク量(←/→、秒)')
  const seekInput = el('input', { type: 'number', min: '0.1', step: '0.1' }) as HTMLInputElement
  seekInput.addEventListener('change', () => void patchSettings({ seekStepSec: Math.max(0.1, Number(seekInput.value) || 0.5) }))
  seekRow.control.appendChild(seekInput)

  const bigSeekRow = settingsRow('大シーク量(Shift+←/→、秒)')
  const bigSeekInput = el('input', { type: 'number', min: '0.5', step: '0.5' }) as HTMLInputElement
  bigSeekInput.addEventListener('change', () => void patchSettings({ bigSeekStepSec: Math.max(0.5, Number(bigSeekInput.value) || 5) }))
  bigSeekRow.control.appendChild(bigSeekInput)

  // --- 本番画面の既定再生ソース ---
  const sourceRow = settingsRow('本番画面の既定再生ソース')
  const sourceSelect = el('select', { className: 'editor-select' }) as HTMLSelectElement
  sourceSelect.append(el('option', { value: 'playback' }, ['オフボーカル']), el('option', { value: 'analysis' }, ['オンボーカル']))
  sourceSelect.addEventListener('change', () =>
    void patchSettings({ defaultPerformSource: sourceSelect.value as 'playback' | 'analysis' })
  )
  sourceRow.control.appendChild(sourceSelect)

  // --- カウントイン ---
  const countInRow = settingsRow('カウントイン')
  const countInInput = el('input', { type: 'checkbox' }) as HTMLInputElement
  countInInput.addEventListener('change', () => void patchSettings({ countInEnabled: countInInput.checked }))
  countInRow.control.appendChild(countInInput)

  body.append(
    dirRow.row,
    backupRow.row,
    snapEnabledRow.row,
    snapDistanceRow.row,
    seekRow.row,
    bigSeekRow.row,
    sourceRow.row,
    countInRow.row
  )

  async function patchSettings(partial: Partial<ReturnType<typeof ctx.settings.getState>>): Promise<void> {
    try {
      const updated = await window.dokokara.setSettings(partial)
      ctx.settings.setState(updated)
    } catch (e) {
      notifyError(`設定の保存に失敗しました: ${(e as Error).message}`)
    }
  }

  function syncFromSettings(): void {
    const s = ctx.settings.getState()
    dirPathLabel.textContent = s.projectsDir
    backupInput.value = String(Math.round(s.autoBackupIntervalMs / 60000))
    snapEnabledInput.checked = s.snapEnabled
    snapDistanceInput.value = String(s.snapDistancePx)
    seekInput.value = String(s.seekStepSec)
    bigSeekInput.value = String(s.bigSeekStepSec)
    sourceSelect.value = s.defaultPerformSource
    countInInput.checked = s.countInEnabled
  }

  function syncVisibility(): void {
    const open = ctx.ui.getState().settingsOpen
    overlay.classList.toggle('visible', open)
    if (open) syncFromSettings()
  }

  ctx.ui.subscribe(syncVisibility)
  ctx.settings.subscribe(() => {
    if (ctx.ui.getState().settingsOpen) syncFromSettings()
  })
  syncVisibility()

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && ctx.ui.getState().settingsOpen) ctx.closeSettings()
  })
}

function settingsRow(label: string): { row: HTMLElement; control: HTMLElement } {
  const control = el('div', { className: 'settings-row-control' })
  const row = el('div', { className: 'settings-row' }, [el('label', { className: 'settings-row-label' }, [label]), control])
  return { row, control }
}
