import type { AppContext } from './appContext'
import type { ScreenName } from './appContext'
import type { ScreenHandle, ScreenMount } from './lib/screen'
import { mountHomeScreen } from './screens/homeScreen'
import { mountSetupScreen } from './screens/setupScreen'
import { mountAnalyzingScreen } from './screens/analyzingScreen'
import { mountEditorScreen } from './screens/editorScreen'
import { mountPerformScreen } from './screens/performScreen'

const SCREEN_MOUNTS: Record<ScreenName, ScreenMount> = {
  home: mountHomeScreen,
  setup: mountSetupScreen,
  analyzing: mountAnalyzingScreen,
  editor: mountEditorScreen,
  perform: mountPerformScreen
}

/**
 * §3 の画面遷移を ctx.ui.screen の変化に応じて実現するルーター。
 * 画面ごとに DOM をマウント/アンマウントする。
 */
export function createRouter(root: HTMLElement, ctx: AppContext): () => void {
  let current: ScreenHandle | null = null
  let currentScreen: ScreenName | null = null

  function render(screen: ScreenName): void {
    if (screen === currentScreen) return
    current?.unmount()
    root.classList.remove(...Array.from(root.classList).filter((c) => c.startsWith('screen-')))
    root.classList.add(`screen-${screen}`)
    current = SCREEN_MOUNTS[screen](root, ctx)
    currentScreen = screen
  }

  render(ctx.ui.getState().screen)
  const unsubscribe = ctx.ui.subscribe((s) => render(s.screen))
  return unsubscribe
}
