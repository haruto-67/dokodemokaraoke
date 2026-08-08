import { app, BrowserWindow, ipcMain } from 'electron'
import { createMainWindow } from './window'
import { buildAppMenu } from './menu'
import { registerIpcHandlers } from './ipcHandlers'
import { IPC } from '@shared/ipc'

let mainWindow: BrowserWindow | null = null
const pendingOpenFiles: string[] = []
let closeConfirmedByRenderer = false

function getWindow(): BrowserWindow | null {
  return mainWindow
}

// macOS: Finder から .dokokara をダブルクリック/ドラッグしたときに発火する。
// app が ready になる前に届く可能性があるためキューに貯める。
app.on('open-file', (event, filePath) => {
  event.preventDefault()
  if (mainWindow) {
    mainWindow.webContents.send('app:openFile', filePath)
  } else {
    pendingOpenFiles.push(filePath)
  }
})

app.whenReady().then(() => {
  app.setName('どこでもカラオケセット')

  registerIpcHandlers(getWindow)
  buildAppMenu(getWindow)

  mainWindow = createMainWindow()

  mainWindow.webContents.once('did-finish-load', () => {
    for (const filePath of pendingOpenFiles.splice(0)) {
      mainWindow?.webContents.send('app:openFile', filePath)
    }
  })

  mainWindow.on('close', (event) => {
    if (closeConfirmedByRenderer) return
    event.preventDefault()
    mainWindow?.webContents.send(IPC.requestClose)
  })

  ipcMain.on(IPC.closeConfirmed, () => {
    closeConfirmedByRenderer = true
    mainWindow?.close()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
