#!/usr/bin/env node
// どこカラv3: モデル重み(resources/models/)を取得し、sha256で検証する。
//
// 配布元はこのリポジトリ自身のGitHub Releases(model-weights-v1)。理由は
// python/models.json 内および該当Releaseのノート参照(Hugging Face個人アカウント
// 等の配布元ホストは将来消滅し得るため、自前でミラーしてハッシュ固定する方針)。
//
// 既存ファイルがある場合はsha256が一致すればダウンロードをスキップする
// (再実行の高速化と、壊れた/古い重みを検知するための二重の意味を持たせる)。

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const MODELS_DIR = join(ROOT, 'resources', 'models')
const MANIFEST_PATH = join(ROOT, 'python', 'models.json')

function sha256File(path) {
  const hash = createHash('sha256')
  hash.update(readFileSync(path))
  return hash.digest('hex')
}

function isValid(path, model) {
  if (!existsSync(path)) return false
  if (statSync(path).size !== model.size) return false
  return sha256File(path) === model.sha256
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
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'))
  mkdirSync(MODELS_DIR, { recursive: true })

  for (const model of manifest.models) {
    const destPath = join(MODELS_DIR, model.filename)

    if (isValid(destPath, model)) {
      console.log(`[skip] ${model.filename} は既に検証済み`)
      continue
    }

    console.log(`[get]  ${model.filename} (${model.description}) を取得中...`)
    try {
      await download(model.url, destPath)
    } catch (err) {
      rmSync(destPath, { force: true })
      throw err
    }

    const actualSize = statSync(destPath).size
    if (actualSize !== model.size) {
      rmSync(destPath, { force: true })
      throw new Error(`[${model.filename}] サイズ不一致: expected=${model.size} actual=${actualSize}`)
    }

    const actualSha256 = sha256File(destPath)
    if (actualSha256 !== model.sha256) {
      rmSync(destPath, { force: true })
      throw new Error(`[${model.filename}] sha256不一致: expected=${model.sha256} actual=${actualSha256}`)
    }

    console.log(`[ok]   ${model.filename} sha256検証OK`)
  }

  console.log('resources/models/ のモデル重みはすべて検証済みです。')
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
