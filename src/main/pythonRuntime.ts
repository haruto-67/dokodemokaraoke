import { app } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 同梱Pythonサイドカーのルートディレクトリ。
 * - 開発時: リポジトリ直下の resources/python-runtime/
 *   (npm run build:python-runtime で生成。scripts/build-python-runtime.mjs参照)
 * - パッケージ後: <app>.app/Contents/Resources/python-runtime/
 *   (electron-builder.yml の mac.extraResources で配置)
 */
export function getPythonRuntimeDir(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'python-runtime')
  }
  // out/main/index.js から見てリポジトリ直下は2階層上。
  return join(__dirname, '../../resources/python-runtime')
}

export function getPythonExecutablePath(): string {
  return join(getPythonRuntimeDir(), 'bin', 'python3')
}

export function isPythonRuntimeBundled(): boolean {
  return existsSync(getPythonExecutablePath())
}

/**
 * サイドカーのエントリポイント(python/sidecar/main.py)。
 * - 開発時: リポジトリ直下の python/sidecar/main.py
 * - パッケージ後: <app>.app/Contents/Resources/python-sidecar/main.py
 *   (electron-builder.yml の mac.extraResources で配置。ランタイム本体とは
 *   別ディレクトリにする。頻繁に変わるアプリ側コードと、めったに変わらない
 *   同梱インタプリタ+ライブラリ一式を混ぜないため)
 */
export function getPythonSidecarScriptPath(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'python-sidecar', 'main.py')
  }
  return join(__dirname, '../../python/sidecar/main.py')
}
