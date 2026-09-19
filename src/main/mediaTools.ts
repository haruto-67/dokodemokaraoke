import { app } from 'electron'
import { join } from 'node:path'

/**
 * 同梱yt-dlp/ffmpegの配置ディレクトリ(§4.4.1 STEP1)。
 * - 開発時: リポジトリ直下の resources/media-tools/
 *   (npm run build:media-tools で生成。scripts/build-media-tools.mjs参照)
 * - パッケージ後: <app>.app/Contents/Resources/media-tools/
 *   (electron-builder.yml の mac.extraResources で配置)
 */
export function getMediaToolsDir(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'media-tools')
  }
  return join(__dirname, '../../resources/media-tools')
}

export function getYtDlpPath(): string {
  return join(getMediaToolsDir(), 'yt-dlp')
}

export function getFfmpegPath(): string {
  return join(getMediaToolsDir(), 'ffmpeg')
}
