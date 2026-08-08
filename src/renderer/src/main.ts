import './styles/tokens.css'
import './styles/home.css'
import './styles/setup.css'
import './styles/screens.css'
import './styles/editor.css'
import './styles/perform.css'
import './styles/settings.css'
import { createAppContext } from './appContext'
import { createRouter } from './app'
import { mountSettingsModal } from './components/settingsModal'
import {
  saveProject,
  backupProject,
  confirmDiscardIfDirty,
  createNewProjectFlow,
  openProjectByPath,
  openProjectDialogFlow,
  restoreFromBackup,
  notifyError
} from './lib/projectActions'

async function bootstrap(): Promise<void> {
  const root = document.getElementById('app')
  if (!root) throw new Error('#app 要素が見つかりません')

  const settings = await window.dokokara.getSettings()
  const ctx = createAppContext(settings)

  createRouter(root, ctx)
  mountSettingsModal(root, ctx)

  // ネイティブメニュー(menu.ts)からのアクション(§4.9.2 ファイル操作・Undo/Redo と対応)
  window.dokokara.onMenuAction((action) => {
    void handleMenuAction(action)
  })

  async function handleMenuAction(action: string): Promise<void> {
    switch (action) {
      case 'newProject':
        if (await confirmDiscardIfDirty(ctx)) createNewProjectFlow(ctx)
        break
      case 'openProject':
        if (await confirmDiscardIfDirty(ctx)) await openProjectDialogFlow(ctx)
        break
      case 'save':
        await saveProject(ctx, false)
        break
      case 'saveAs':
        await saveProject(ctx, true)
        break
      case 'undo':
        ctx.editor.undo()
        break
      case 'redo':
        ctx.editor.redo()
        break
      case 'openSettings':
        ctx.openSettings()
        break
      default:
        break
    }
  }

  // Finder から .dokokara をダブルクリック/ドラッグして開いた場合(§4.1.1)
  window.dokokara.onOpenFileFromOs((filePath) => {
    void (async () => {
      if (!(await confirmDiscardIfDirty(ctx))) return
      await openProjectByPath(ctx, filePath)
    })()
  })

  // ウィンドウを閉じる前の未保存確認(§4.1)
  window.dokokara.onRequestClose(() => {
    void (async () => {
      const ok = await confirmDiscardIfDirty(ctx)
      if (ok) window.dokokara.closeConfirmed()
    })()
  })

  // 自動バックアップ(§4.1, 既定3分)。setIntervalではなく自己再スケジュールのsetTimeoutにすることで、
  // 設定画面で間隔を変更した場合に次回発火から即座に新しい値が反映される。
  function scheduleAutoBackup(): void {
    window.setTimeout(() => {
      void backupProject(ctx).finally(scheduleAutoBackup)
    }, ctx.settings.getState().autoBackupIntervalMs)
  }
  scheduleAutoBackup()

  // クラッシュ後の復帰提案(§4.1)
  try {
    const crash = await window.dokokara.checkForCrashBackup()
    if (crash) {
      const restore = window.confirm(
        '前回のセッションが正常に終了しませんでした。自動バックアップから復元しますか？'
      )
      if (restore) await restoreFromBackup(ctx, crash.filePath, crash.backupPath)
    }
  } catch {
    /* クラッシュ復帰チェックの失敗は起動を妨げない */
  }
}

bootstrap().catch((e) => {
  console.error(e)
  notifyError(`アプリの起動に失敗しました: ${(e as Error).message}`)
})
