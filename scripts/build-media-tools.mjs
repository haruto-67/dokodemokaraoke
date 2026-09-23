#!/usr/bin/env node
// どこカラv3: 音源取得STEP1(§4.4.1)で使う yt-dlp / ffmpeg を取得し、
// resources/media-tools/ に sha256検証込みで配置する。実行しているOS(macOS/Windows)に
// 合わせたバイナリを選ぶ(src/main/mediaTools.tsのgetYtDlpPath/getFfmpegPathも
// win32では.exe拡張子を付けて同じファイル名を参照する)。
//
// - yt-dlp: 公式リリースが配布するスタンドアロンバイナリ(macOSはyt-dlp_macos、
//   Windowsはyt-dlp.exe。どちらもPython同梱で追加の依存なしに動く)をそのまま使う。
// - ffmpeg: ffmpeg.org自身はビルドごとに安定したURLの静的バイナリを配布していないため、
//   静的リンク済みビルドをGitHub Releasesで配布している eugeneware/ffmpeg-static の
//   darwin-arm64/win32-x64版を使う。
//
// どちらも「バージョン+サイズ+sha256を固定し、既存ファイルが一致すればダウンロードを
// スキップする」という fetch-models.mjs / build-python-runtime.mjs と同じパターンを踏襲する。

import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const TOOLS_DIR = join(ROOT, 'resources', 'media-tools')

const TOOLS_BY_PLATFORM = {
  darwin: [
    {
      filename: 'yt-dlp',
      version: '2026.08.19',
      url: 'https://github.com/yt-dlp/yt-dlp/releases/download/2026.08.19/yt-dlp_macos',
      size: 37146048,
      sha256: '0f192b7ec147ab6288885d6351d9ab67367640029b4377576ef46dd79cf7b202'
    },
    {
      filename: 'ffmpeg',
      version: 'b6.1.1',
      url: 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffmpeg-darwin-arm64',
      size: 45568216,
      sha256: 'a90e3db6a3fd35f6074b013f948b1aa45b31c6375489d39e572bea3f18336584'
    }
  ],
  win32: [
    {
      filename: 'yt-dlp.exe',
      version: '2026.08.19',
      url: 'https://github.com/yt-dlp/yt-dlp/releases/download/2026.08.19/yt-dlp.exe',
      size: 17840399,
      sha256: '66674953fe251b89f4d08c5f0e35e0728679bd67ab3d7d05c0562af101dd3e7a'
    },
    {
      filename: 'ffmpeg.exe',
      version: 'b6.1.1',
      url: 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffmpeg-win32-x64',
      size: 82797568,
      sha256: '04e1307997530f9cf2fe35cba2ca7e8875ca91da02f89d6c7243df819c94ad00'
    }
  ]
}

function currentPlatformTools() {
  const tools = TOOLS_BY_PLATFORM[process.platform]
  if (!tools) {
    throw new Error(`未対応のOSです: ${process.platform}(対応: macOS[darwin] / Windows[win32])`)
  }
  return tools
}

const TOOLS = currentPlatformTools()

function sha256File(path) {
  const hash = createHash('sha256')
  hash.update(readFileSync(path))
  return hash.digest('hex')
}

function isValid(path, tool) {
  if (!existsSync(path)) return false
  if (statSync(path).size !== tool.size) return false
  return sha256File(path) === tool.sha256
}

async function download(url, destPath) {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) {
    throw new Error(`ダウンロード失敗: HTTP ${res.status} (${url})`)
  }
  const buf = Buffer.from(await res.arrayBuffer())
  writeFileSync(destPath, buf)
}

async function main() {
  mkdirSync(TOOLS_DIR, { recursive: true })

  for (const tool of TOOLS) {
    const destPath = join(TOOLS_DIR, tool.filename)

    if (isValid(destPath, tool)) {
      console.log(`[skip] ${tool.filename} (${tool.version}) は既に検証済み`)
      continue
    }

    console.log(`[get]  ${tool.filename} ${tool.version} を取得中...`)
    try {
      await download(tool.url, destPath)
    } catch (err) {
      rmSync(destPath, { force: true })
      throw err
    }

    const actualSize = statSync(destPath).size
    if (actualSize !== tool.size) {
      rmSync(destPath, { force: true })
      throw new Error(`[${tool.filename}] サイズ不一致: expected=${tool.size} actual=${actualSize}`)
    }

    const actualSha256 = sha256File(destPath)
    if (actualSha256 !== tool.sha256) {
      rmSync(destPath, { force: true })
      throw new Error(`[${tool.filename}] sha256不一致: expected=${tool.sha256} actual=${actualSha256}`)
    }

    chmodSync(destPath, 0o755)
    console.log(`[ok]   ${tool.filename} sha256検証OK`)
  }

  console.log('resources/media-tools/ のyt-dlp/ffmpegはすべて検証済みです。')
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
