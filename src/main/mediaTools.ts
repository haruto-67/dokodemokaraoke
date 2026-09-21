import { app } from 'electron'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

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

/**
 * 解析実行前の音源正規化(要件定義書v3 §4.4.1 STEP1)。
 * ローカルファイル入力(setupScreen.tsの「ファイルを選択」/ドラッグ&ドロップ)はYouTube取り込み
 * (sourceIngestCore.ts)と違い、選択されたファイルのパスをそのままPythonサイドカーへ渡していた。
 * m4a(AAC/MP4コンテナ)はPython側のsoundfile(libsndfile)が読めるコンテナではなく、
 * `Error opening '...': Format not recognised.`で解析全体が失敗する不具合が実機で発生した
 * (soundfileはWAV/FLAC/OGG等は読めるがMP4系コンテナは非対応のため)。
 * 同梱ffmpegでWAV(44.1kHz/ステレオ)へ変換してからサイドカーへ渡すことで、
 * 入力フォーマットに依らず解析パイプラインが確実に読めるようにする。
 */
export function normalizeAudioToWav(inputPath: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(getFfmpegPath(), ['-y', '-i', inputPath, '-ar', '44100', '-ac', '2', outputPath], {
      stdio: ['ignore', 'ignore', 'pipe']
    })
    let stderr = ''
    child.stderr.setEncoding('utf-8')
    child.stderr.on('data', (chunk: string) => (stderr += chunk))
    child.on('error', (err) => reject(err))
    child.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(stderr.trim() || `ffmpegが終了コード${code}で失敗しました`))
    })
  })
}
