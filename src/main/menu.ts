import { Menu, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'

/** 「app:onMenuAction」経由でレンダラへメニューアクションを伝える */
function send(win: BrowserWindow, action: string): void {
  win.webContents.send('app:menuAction', action)
}

export function buildAppMenu(getWindow: () => BrowserWindow | null): Menu {
  const isMac = process.platform === 'darwin'

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: 'どこでもカラオケセット',
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              {
                label: '設定…',
                accelerator: 'Cmd+,',
                click: () => {
                  const w = getWindow()
                  if (w) send(w, 'openSettings')
                }
              },
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const }
            ]
          }
        ]
      : []),
    {
      label: 'ファイル',
      submenu: [
        {
          label: '新規プロジェクト',
          accelerator: 'CmdOrCtrl+N',
          click: () => {
            const w = getWindow()
            if (w) send(w, 'newProject')
          }
        },
        {
          label: 'プロジェクトを開く…',
          accelerator: 'CmdOrCtrl+O',
          click: () => {
            const w = getWindow()
            if (w) send(w, 'openProject')
          }
        },
        { type: 'separator' },
        {
          label: '上書き保存',
          accelerator: 'CmdOrCtrl+S',
          click: () => {
            const w = getWindow()
            if (w) send(w, 'save')
          }
        },
        {
          label: '名前を付けて保存…',
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => {
            const w = getWindow()
            if (w) send(w, 'saveAs')
          }
        },
        { type: 'separator' },
        { role: isMac ? 'close' : 'quit' }
      ]
    },
    {
      label: '編集',
      submenu: [
        {
          label: '取り消す',
          accelerator: 'CmdOrCtrl+Z',
          click: () => {
            const w = getWindow()
            if (w) send(w, 'undo')
          }
        },
        {
          label: 'やり直す',
          accelerator: 'CmdOrCtrl+Shift+Z',
          click: () => {
            const w = getWindow()
            if (w) send(w, 'redo')
          }
        },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: '表示',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'ウインドウ',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, ...(isMac ? [{ role: 'front' as const }] : [])]
    }
  ]

  const menu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(menu)
  return menu
}
