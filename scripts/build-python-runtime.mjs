#!/usr/bin/env node
// どこカラv3: Pythonサイドカーの実行環境(resources/python-runtime/)を組み立てる。
//
// - python-build-standalone (arm64 macOS, install_only_stripped) を取得・sha256検証・展開する。
// - uv を使い、python/requirements.txt の内容をその同梱Pythonへ直接インストールする
//   (venvは作らない。同梱Python自体がアプリ専用の隔離環境になるため)。
// - electron-builder.yml の extraResources がこのディレクトリをそのまま .app に同梱する。
//
// 入力(ダウンロードするpython-build-standaloneのバージョン・sha256)が変わらない限り、
// 2回目以降の実行は既存のstampファイルを見て早期終了する。

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const RUNTIME_DIR = join(ROOT, 'resources', 'python-runtime')
const STAMP_FILE = join(RUNTIME_DIR, '.build-stamp.json')
const REQUIREMENTS_FILE = join(ROOT, 'python', 'requirements.txt')

// アプリはarm64 macOS専用(electron-builder.yml参照)。ホストのuname -mが何であれ
// (Rosetta越しのシェルではx86_64と出ることがある)、常にaarch64版を取得する。
const PBS_TAG = '20260901'
const PBS_ASSET = 'cpython-3.11.16+20260901-aarch64-apple-darwin-install_only_stripped.tar.gz'
const PBS_URL = `https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_TAG}/${PBS_ASSET}`
const PBS_SHA256 = '768f05cf200273bbdda9a5955a5a6892a4b22f2a0b1e4b0a9160f5c7fce86816'

function run(cmd, args, opts = {}) {
  console.log(`$ ${cmd} ${args.join(' ')}`)
  const result = spawnSync(cmd, args, { stdio: 'inherit', ...opts })
  if (result.status !== 0) {
    throw new Error(`コマンド失敗: ${cmd} ${args.join(' ')} (exit ${result.status})`)
  }
}

function sha256File(path) {
  const hash = createHash('sha256')
  hash.update(readFileSync(path))
  return hash.digest('hex')
}

function currentStamp() {
  const requirementsHash = sha256File(REQUIREMENTS_FILE)
  return { pbsTag: PBS_TAG, pbsAsset: PBS_ASSET, requirementsHash }
}

function stampMatches() {
  if (!existsSync(STAMP_FILE)) return false
  try {
    const saved = JSON.parse(readFileSync(STAMP_FILE, 'utf-8'))
    const wanted = currentStamp()
    return saved.pbsTag === wanted.pbsTag && saved.pbsAsset === wanted.pbsAsset && saved.requirementsHash === wanted.requirementsHash
  } catch {
    return false
  }
}

function findUv() {
  const result = spawnSync('uv', ['--version'], { stdio: 'pipe' })
  if (result.status === 0) return 'uv'
  console.error(
    [
      'uv が見つかりません。Pythonの依存解決・インストールに uv を使う方針のため、',
      '先にインストールしてください:',
      '  curl -LsSf https://astral.sh/uv/install.sh | sh',
      'または:',
      '  brew install uv'
    ].join('\n')
  )
  process.exit(1)
}

async function downloadPythonBuildStandalone(destTarGz) {
  console.log(`python-build-standalone を取得中: ${PBS_URL}`)
  const res = await fetch(PBS_URL, { redirect: 'follow' })
  if (!res.ok) {
    throw new Error(`ダウンロード失敗: HTTP ${res.status}`)
  }
  const buf = Buffer.from(await res.arrayBuffer())
  writeFileSync(destTarGz, buf)

  const actualSha256 = sha256File(destTarGz)
  if (actualSha256 !== PBS_SHA256) {
    rmSync(destTarGz, { force: true })
    throw new Error(`sha256不一致: expected=${PBS_SHA256} actual=${actualSha256}`)
  }
  console.log('sha256検証OK')
}

async function main() {
  if (stampMatches()) {
    console.log(`resources/python-runtime/ は最新です(stamp一致)。再構築をスキップします。`)
    return
  }

  const uv = findUv()

  if (existsSync(RUNTIME_DIR)) {
    rmSync(RUNTIME_DIR, { recursive: true, force: true })
  }
  mkdirSync(RUNTIME_DIR, { recursive: true })

  const tmpDir = join(ROOT, '.python-runtime-tmp')
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true })
  mkdirSync(tmpDir, { recursive: true })
  const tarGzPath = join(tmpDir, PBS_ASSET)

  try {
    await downloadPythonBuildStandalone(tarGzPath)

    console.log('展開中...')
    run('tar', ['-xzf', tarGzPath, '-C', tmpDir])

    // install_only系アーカイブは展開すると `python/` 直下に入る。
    const extractedPythonDir = join(tmpDir, 'python')
    if (!existsSync(extractedPythonDir)) {
      throw new Error(`展開後に想定ディレクトリが見つかりません: ${extractedPythonDir}`)
    }

    run('cp', ['-R', `${extractedPythonDir}/.`, RUNTIME_DIR])

    const pythonBin = join(RUNTIME_DIR, 'bin', 'python3')
    if (!existsSync(pythonBin)) {
      throw new Error(`python実行ファイルが見つかりません: ${pythonBin}`)
    }

    console.log('依存パッケージをインストール中 (uv pip install)...')
    run(uv, ['pip', 'install', '--python', pythonBin, '-r', REQUIREMENTS_FILE])

    console.log('動作確認中...')
    run(pythonBin, [
      '-c',
      'import torch, torchaudio, transformers, basic_pitch, mel_band_roformer, ctc_segmentation, numpy; ' +
        'print(f"torch={torch.__version__} torchaudio={torchaudio.__version__} transformers={transformers.__version__} ' +
        'basic_pitch=OK mel_band_roformer={mel_band_roformer.__version__} ctc_segmentation=OK numpy={numpy.__version__}")'
    ])

    console.log('pyopenjtalkの辞書を取得中(初回importの副作用。以降はsite-packages内に永続化される)...')
    run(pythonBin, ['-c', 'import pyopenjtalk; print(pyopenjtalk.g2p("辞書取得確認", kana=True))'])

    writeFileSync(STAMP_FILE, JSON.stringify(currentStamp(), null, 2))

    const sizeResult = spawnSync('du', ['-sh', RUNTIME_DIR], { encoding: 'utf-8' })
    console.log(`同梱サイズ: ${sizeResult.stdout.trim()}`)
    console.log('resources/python-runtime/ の構築が完了しました。')
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
