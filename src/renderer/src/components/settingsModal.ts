import type { AppContext } from '../appContext'
import type { PlaySource } from '@shared/types'
import { el } from '../lib/dom'
import { notifyError } from '../lib/projectActions'
import { listMicInputDevices, MicPermissionError, startMicPitchDetection, type MicPitchSession } from '../audio/micPitchInput'
import { runLatencyCalibration } from '../audio/latencyCalibration'
import {
  SHORTCUT_ACTIONS,
  comboFromEvent,
  findConflict,
  formatCombo,
  resolveBindings,
  type ShortcutActionId,
  type ShortcutOverrides
} from '@shared/keybindings'

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
  sourceSelect.append(
    el('option', { value: 'playback' }, ['オフボーカル']),
    el('option', { value: 'original' }, ['オンボーカル']),
    el('option', { value: 'analysis' }, ['ボーカルのみ'])
  )
  sourceSelect.addEventListener('change', () => void patchSettings({ defaultPerformSource: sourceSelect.value as PlaySource }))
  sourceRow.control.appendChild(sourceSelect)

  // --- カウントイン ---
  const countInRow = settingsRow('カウントイン')
  const countInInput = el('input', { type: 'checkbox' }) as HTMLInputElement
  countInInput.addEventListener('change', () => void patchSettings({ countInEnabled: countInInput.checked }))
  countInRow.control.appendChild(countInInput)

  // --- キー提示音(§4.12) ---
  const jingleRow = settingsRow('キー提示音(再生前にピアノの単音を鳴らす)')
  const jingleInput = el('input', { type: 'checkbox' }) as HTMLInputElement
  jingleInput.addEventListener('change', () => void patchSettings({ keyJingleEnabled: jingleInput.checked }))
  jingleRow.control.appendChild(jingleInput)

  // --- ガイドボーカル音量(§4.12) ---
  const guideVocalRow = settingsRow('ガイドボーカルの音量')
  const guideVocalInput = el('input', { type: 'range', min: '0', max: '1', step: '0.05' }) as HTMLInputElement
  const guideVocalValueLabel = el('span', { className: 'mono settings-path' }, ['0%'])
  guideVocalInput.addEventListener('input', () => {
    guideVocalValueLabel.textContent = `${Math.round(Number(guideVocalInput.value) * 100)}%`
  })
  guideVocalInput.addEventListener('change', () => void patchSettings({ guideVocalVolume: Number(guideVocalInput.value) }))
  guideVocalRow.control.append(guideVocalInput, guideVocalValueLabel)

  // --- 採点用マイク入力デバイス・入力レベルメーター(§4.12.1) ---
  const micRow = settingsRow('採点用マイク入力')
  const micSelect = el('select', { className: 'editor-select' }) as HTMLSelectElement
  const micMeterWrap = el('div', { className: 'settings-mic-meter' })
  const micMeterFill = el('div', { className: 'settings-mic-meter-fill' })
  micMeterWrap.appendChild(micMeterFill)
  const micStatus = el('span', { className: 'mono settings-path' }, [''])
  micRow.control.append(micSelect, micMeterWrap, micStatus)

  let micSession: MicPitchSession | null = null

  function stopMicPreview(): void {
    micSession?.stop()
    micSession = null
    micMeterFill.style.width = '0%'
  }

  async function startMicPreview(): Promise<void> {
    stopMicPreview()
    const deviceId = ctx.settings.getState().micDeviceId
    try {
      micSession = await startMicPitchDetection(
        (sample) => {
          // RMS(だいたい0〜0.3程度が実用域)を0〜100%のバーに単純にスケールする。
          const pct = Math.min(100, sample.rms * 300)
          micMeterFill.style.width = `${pct}%`
        },
        { deviceId }
      )
      micStatus.textContent = ''
      // ラベル取得のため権限確定後に再列挙する
      await refreshMicDeviceList()
    } catch (e) {
      if (e instanceof MicPermissionError) {
        micStatus.textContent = e.kind === 'permission_denied' ? 'マイクの使用が許可されていません' : e.message
      } else {
        micStatus.textContent = 'マイクの初期化に失敗しました'
      }
    }
  }

  async function refreshMicDeviceList(): Promise<void> {
    const devices = await listMicInputDevices()
    const current = ctx.settings.getState().micDeviceId
    micSelect.replaceChildren(el('option', { value: '' }, ['既定のマイク']))
    devices.forEach((d, i) => {
      micSelect.appendChild(el('option', { value: d.deviceId }, [d.label || `マイク${i + 1}`]))
    })
    micSelect.value = current ?? ''
  }
  micSelect.addEventListener('change', () => {
    void (async () => {
      await patchSettings({ micDeviceId: micSelect.value || null })
      await startMicPreview()
    })()
  })

  // --- 入出力遅延のキャリブレーション(§4.12.2) ---
  const latencyRow = settingsRow('入出力遅延補正')
  const latencyValueLabel = el('span', { className: 'mono settings-status-wrap' }, [''])
  const latencyMeasureBtn = el('button', { className: 'btn btn-ghost' }, ['測定…'])
  const latencyResetBtn = el('button', { className: 'btn btn-ghost' }, ['リセット'])
  latencyRow.control.append(latencyValueLabel, latencyMeasureBtn, latencyResetBtn)

  latencyMeasureBtn.addEventListener('click', () => {
    void (async () => {
      // 測定中はマイクプレビューと競合しない(同時に2系統マイクを掴むのを避ける)よう一旦止める
      stopMicPreview()
      latencyMeasureBtn.disabled = true
      latencyValueLabel.textContent = '測定中…(静かな環境でお待ちください)'
      try {
        const deviceId = ctx.settings.getState().micDeviceId
        const result = await runLatencyCalibration({ deviceId })
        await patchSettings({ micLatencyCompensationMs: result.latencyMs })
        latencyValueLabel.textContent = `${result.latencyMs}ms`
      } catch (e) {
        if (e instanceof MicPermissionError) {
          latencyValueLabel.textContent = e.kind === 'permission_denied' ? 'マイクの使用が許可されていません' : e.message
        } else {
          latencyValueLabel.textContent = (e as Error).message || '測定に失敗しました'
        }
      } finally {
        latencyMeasureBtn.disabled = false
        await startMicPreview()
      }
    })()
  })
  latencyResetBtn.addEventListener('click', () => {
    void (async () => {
      await patchSettings({ micLatencyCompensationMs: 0 })
      latencyValueLabel.textContent = '0ms'
    })()
  })

  // --- yt-dlpの更新(§4.3実装メモ: 同梱版＋任意更新。YouTube側の仕様変更で壊れやすいため) ---
  const ytDlpRow = settingsRow('yt-dlp(YouTube取り込み)')
  const ytDlpStatus = el('span', { className: 'mono settings-path' }, [''])
  const ytDlpUpdateBtn = el('button', { className: 'btn btn-ghost' }, ['更新を確認'])
  ytDlpUpdateBtn.addEventListener('click', async () => {
    ytDlpUpdateBtn.disabled = true
    ytDlpStatus.textContent = '確認中…'
    try {
      const result = await window.dokokara.updateYtDlp()
      ytDlpStatus.textContent = result.message
    } catch (e) {
      ytDlpStatus.textContent = ''
      notifyError(`yt-dlpの更新に失敗しました: ${(e as Error).message}`)
    } finally {
      ytDlpUpdateBtn.disabled = false
    }
  })
  ytDlpRow.control.append(ytDlpStatus, ytDlpUpdateBtn)
  // yt-dlpは普段は意識しなくてよい項目なので、YouTube取り込みが失敗した時だけ開く詳細欄に格納する
  const troubleshooting = el('details', { className: 'settings-details' }, [
    el('summary', {}, ['トラブル時の設定']),
    el('p', { className: 'settings-note' }, [
      'YouTubeからの取り込みが急に失敗するようになった時は、YouTube側の仕様変更の可能性があります。取り込みツール(yt-dlp)を更新してください。'
    ]),
    ytDlpRow.row
  ])

  // --- ショートカットキー(編集画面) ---
  const shortcutSection = el('div', { className: 'settings-shortcuts' })
  const shortcutMessage = el('p', { className: 'settings-note settings-shortcut-message' }, [''])
  const resetAllShortcutsBtn = el('button', { className: 'btn btn-ghost' }, ['すべて既定に戻す'])
  resetAllShortcutsBtn.addEventListener('click', () => {
    shortcutMessage.textContent = ''
    void patchSettings({ shortcuts: {} })
  })
  const isMac = navigator.platform.toLowerCase().includes('mac')
  // 割り当て変更のキー入力待ち状態(どのアクションの何番目の枠か)
  let capturing: { id: ShortcutActionId; slot: number } | null = null

  function currentBindings(): Record<ShortcutActionId, string[]> {
    return resolveBindings(ctx.settings.getState().shortcuts)
  }

  /** 既定値と同じになったアクションは上書きから外し、設定ファイルには変更分だけを残す */
  function toOverrides(bindings: Record<ShortcutActionId, string[]>): ShortcutOverrides {
    const overrides: ShortcutOverrides = {}
    for (const def of SHORTCUT_ACTIONS) {
      const combos = bindings[def.id]
      const same = combos.length === def.defaults.length && combos.every((c, i) => c === def.defaults[i])
      if (!same) overrides[def.id] = combos
    }
    return overrides
  }

  function assignShortcut(id: ShortcutActionId, slot: number, combo: string): void {
    const bindings = currentBindings()
    const conflict = findConflict(bindings, combo, id)
    if (conflict) {
      bindings[conflict] = bindings[conflict].filter((c) => c !== combo)
      const label = SHORTCUT_ACTIONS.find((a) => a.id === conflict)?.label ?? conflict
      shortcutMessage.textContent = `${formatCombo(combo, isMac)} は「${label}」に割り当てられていたので、そちらからは外しました。`
    } else {
      shortcutMessage.textContent = ''
    }
    const combos = bindings[id].filter((c) => c !== combo)
    combos.splice(Math.min(slot, combos.length), slot < bindings[id].length ? 1 : 0, combo)
    bindings[id] = combos.slice(0, 2)
    void patchSettings({ shortcuts: toOverrides(bindings) })
  }

  function removeShortcut(id: ShortcutActionId, combo: string): void {
    const bindings = currentBindings()
    bindings[id] = bindings[id].filter((c) => c !== combo)
    shortcutMessage.textContent = ''
    void patchSettings({ shortcuts: toOverrides(bindings) })
  }

  function renderShortcuts(): void {
    const bindings = currentBindings()
    shortcutSection.replaceChildren()
    let lastGroup = ''
    for (const def of SHORTCUT_ACTIONS) {
      if (def.group !== lastGroup) {
        shortcutSection.appendChild(el('div', { className: 'settings-shortcut-group' }, [def.group]))
        lastGroup = def.group
      }
      const keys = el('div', { className: 'settings-shortcut-keys' })
      const combos = bindings[def.id]
      for (let slot = 0; slot < Math.min(2, combos.length + 1); slot++) {
        const combo = combos[slot] as string | undefined
        const isCapturing = capturing?.id === def.id && capturing.slot === slot
        const chip = el(
          'button',
          { className: `settings-key-chip${combo ? '' : ' empty'}${isCapturing ? ' capturing' : ''}` },
          [isCapturing ? 'キーを押してください…' : combo ? formatCombo(combo, isMac) : '+ 追加']
        )
        chip.dataset.tip = isCapturing ? 'Escでキャンセル' : 'クリックして割り当てるキーを押します'
        chip.addEventListener('click', () => {
          capturing = isCapturing ? null : { id: def.id, slot }
          renderShortcuts()
        })
        keys.appendChild(chip)
        if (combo && !isCapturing) {
          const removeBtn = el('button', { className: 'settings-key-remove' }, ['×'])
          removeBtn.dataset.tip = 'この割り当てを外す'
          removeBtn.addEventListener('click', () => removeShortcut(def.id, combo))
          keys.appendChild(removeBtn)
        }
      }
      shortcutSection.appendChild(
        el('div', { className: 'settings-shortcut-row' }, [el('span', { className: 'settings-shortcut-label' }, [def.label]), keys])
      )
    }
  }

  // 割り当て待ちの間は、押されたキーを他の処理(Escで設定を閉じる等)より先に横取りする
  window.addEventListener(
    'keydown',
    (e) => {
      if (!capturing || !ctx.ui.getState().settingsOpen) return
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') {
        capturing = null
        renderShortcuts()
        return
      }
      const combo = comboFromEvent(e)
      if (!combo) return
      const target = capturing
      capturing = null
      assignShortcut(target.id, target.slot, combo)
      renderShortcuts()
    },
    true
  )

  body.append(
    dirRow.row,
    backupRow.row,
    snapEnabledRow.row,
    snapDistanceRow.row,
    seekRow.row,
    bigSeekRow.row,
    sourceRow.row,
    countInRow.row,
    jingleRow.row,
    guideVocalRow.row,
    micRow.row,
    latencyRow.row,
    el('h3', { className: 'settings-section-title' }, ['ショートカットキー(編集画面)']),
    el('p', { className: 'settings-note' }, [
      'キーの枠をクリックしてから、割り当てたいキーを押してください。1つの操作に2つまで割り当てられます。取り消し(⌘Z / Ctrl+Z)・やり直しは固定です。'
    ]),
    shortcutMessage,
    shortcutSection,
    el('div', { className: 'settings-shortcut-footer' }, [resetAllShortcutsBtn]),
    troubleshooting
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
    jingleInput.checked = s.keyJingleEnabled
    guideVocalInput.value = String(s.guideVocalVolume)
    guideVocalValueLabel.textContent = `${Math.round(s.guideVocalVolume * 100)}%`
    latencyValueLabel.textContent = `${s.micLatencyCompensationMs}ms`
    renderShortcuts()
  }

  function syncVisibility(): void {
    const open = ctx.ui.getState().settingsOpen
    overlay.classList.toggle('visible', open)
    if (open) {
      syncFromSettings()
      void refreshMicDeviceList()
      void startMicPreview()
    } else {
      stopMicPreview()
      capturing = null
      shortcutMessage.textContent = ''
    }
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
