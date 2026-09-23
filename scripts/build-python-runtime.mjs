#!/usr/bin/env node
// どこカラv3: Pythonサイドカーの実行環境(resources/python-runtime/)を組み立てる。
//
// - python-build-standalone (install_only_stripped) を、実行しているOS(macOS/Windows)に
//   合わせて取得・sha256検証・展開する。対応OSはmacOS(arm64)とWindows(x64)の2つ
//   (electron-builder.ymlのmac/winターゲットに対応)。
// - uv を使い、python/requirements.txt の内容をその同梱Pythonへ直接インストールする
//   (venvは作らない。同梱Python自体がアプリ専用の隔離環境になるため)。
// - electron-builder.yml の extraResources がこのディレクトリをそのまま同梱する。
//
// 入力(ダウンロードするpython-build-standaloneのバージョン・sha256)が変わらない限り、
// 2回目以降の実行は既存のstampファイルを見て早期終了する。
//
// 注意(Windows): python/requirements.txt の pyopenjtalk・ctc-segmentation は
// PyPIに事前ビルド済みwheelが無くソース配布のみのため、このスクリプト実行時に
// その場でネイティブ拡張がコンパイルされる。事前に「Desktop development with C++」
// ワークロードを含むVisual Studio Build Tools(https://visualstudio.microsoft.com/visual-cpp-build-tools/)
// をインストールしておくこと(macOSのXcode Command Line Toolsに相当)。

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const RUNTIME_DIR = join(ROOT, 'resources', 'python-runtime')
const STAMP_FILE = join(RUNTIME_DIR, '.build-stamp.json')
const REQUIREMENTS_FILE = join(ROOT, 'python', 'requirements.txt')

const PBS_TAG = '20260901'

// python-build-standaloneのビルドはOSごとに配布アーカイブ・レイアウトが違う
// (macOSは`bin/python3`、Windowsは直下に`python.exe`)。サポートするのは
// electron-builder.ymlのmac(arm64)/win(x64)ターゲットに対応する2つのみ。
const PLATFORM_CONFIG = {
  darwin: {
    asset: 'cpython-3.11.16+20260901-aarch64-apple-darwin-install_only_stripped.tar.gz',
    sha256: '768f05cf200273bbdda9a5955a5a6892a4b22f2a0b1e4b0a9160f5c7fce86816',
    pythonBinRelative: ['bin', 'python3']
  },
  win32: {
    asset: 'cpython-3.11.16+20260901-x86_64-pc-windows-msvc-install_only_stripped.tar.gz',
    sha256: '06cbe479e039f5b9cb5640c286d790074d63f549f92a32d599a3748293bd4510',
    pythonBinRelative: ['python.exe']
  }
}

function currentPlatformConfig() {
  const config = PLATFORM_CONFIG[process.platform]
  if (!config) {
    throw new Error(
      `未対応のOSです: ${process.platform}(対応: macOS[darwin] / Windows[win32])。` +
        'electron-builder.ymlのmac/winターゲット以外は想定していません。'
    )
  }
  return config
}

function pbsUrl(config) {
  return `https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_TAG}/${config.asset}`
}

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

function currentStamp(config) {
  const requirementsHash = sha256File(REQUIREMENTS_FILE)
  return { platform: process.platform, pbsTag: PBS_TAG, pbsAsset: config.asset, requirementsHash }
}

function stampMatches(config) {
  if (!existsSync(STAMP_FILE)) return false
  try {
    const saved = JSON.parse(readFileSync(STAMP_FILE, 'utf-8'))
    const wanted = currentStamp(config)
    return (
      saved.platform === wanted.platform &&
      saved.pbsTag === wanted.pbsTag &&
      saved.pbsAsset === wanted.pbsAsset &&
      saved.requirementsHash === wanted.requirementsHash
    )
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
      '  curl -LsSf https://astral.sh/uv/install.sh | sh   (macOS)',
      '  powershell -c "irm https://astral.sh/uv/install.ps1 | iex"   (Windows)',
      'または:',
      '  brew install uv   (macOS)'
    ].join('\n')
  )
  process.exit(1)
}

async function downloadPythonBuildStandalone(config, destTarGz) {
  const url = pbsUrl(config)
  console.log(`python-build-standalone を取得中: ${url}`)
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) {
    throw new Error(`ダウンロード失敗: HTTP ${res.status}`)
  }
  const buf = Buffer.from(await res.arrayBuffer())
  writeFileSync(destTarGz, buf)

  const actualSha256 = sha256File(destTarGz)
  if (actualSha256 !== config.sha256) {
    rmSync(destTarGz, { force: true })
    throw new Error(`sha256不一致: expected=${config.sha256} actual=${actualSha256}`)
  }
  console.log('sha256検証OK')
}

async function main() {
  const config = currentPlatformConfig()

  if (stampMatches(config)) {
    console.log(`resources/python-runtime/ は最新です(stamp一致)。再構築をスキップします。`)
    return
  }

  const uv = findUv()

  if (existsSync(RUNTIME_DIR)) {
    rmSync(RUNTIME_DIR, { recursive: true, force: true })
  }

  const tmpDir = join(ROOT, '.python-runtime-tmp')
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true })
  mkdirSync(tmpDir, { recursive: true })
  const tarGzPath = join(tmpDir, config.asset)

  try {
    await downloadPythonBuildStandalone(config, tarGzPath)

    console.log('展開中...')
    // tarはmacOS標準搭載、Windowsも10 (1803+)/11でbsdtarが標準搭載されているため
    // 追加の依存無しに両OSで動く。
    run('tar', ['-xzf', tarGzPath, '-C', tmpDir])

    // install_only系アーカイブは展開すると `python/` 直下に入る(両OS共通)。
    const extractedPythonDir = join(tmpDir, 'python')
    if (!existsSync(extractedPythonDir)) {
      throw new Error(`展開後に想定ディレクトリが見つかりません: ${extractedPythonDir}`)
    }

    // cp -R(unix限定コマンド)を避けてOSを問わず動くようにしたいが、Node組み込みのcpSyncは
    // dereference:trueを指定してもシンボリックリンクをそのままコピーしてしまう(検証済み、
    // このNode版の既知の挙動)。python-build-standaloneのbin/python3等はtmpDir内を指す
    // シンボリックリンクのため、cpSyncで別ディレクトリへコピーするとリンク切れ(またはtmpDir
    // 削除後に中身が空同然になる)不具合が実機で発生した。renameSyncなら同一ディレクトリ構造を
    // そのまま移動するだけなので、相対シンボリックリンクのターゲットが変わらず問題が起きない。
    // `resources/`自体はgit管理外(python-runtime/models/media-toolsのみ.gitignore対象、
    // 親ディレクトリはどのスクリプトも作らない)のため、フレッシュなcloneではまだ存在しない。
    // 無いとrenameSyncが「移動先の親ディレクトリが無い」でENOENTになる(Windowsで実機確認)。
    mkdirSync(dirname(RUNTIME_DIR), { recursive: true })
    renameSync(extractedPythonDir, RUNTIME_DIR)

    const pythonBin = join(RUNTIME_DIR, ...config.pythonBinRelative)
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

    writeFileSync(STAMP_FILE, JSON.stringify(currentStamp(config), null, 2))

    if (process.platform !== 'win32') {
      const sizeResult = spawnSync('du', ['-sh', RUNTIME_DIR], { encoding: 'utf-8' })
      console.log(`同梱サイズ: ${sizeResult.stdout.trim()}`)
    }
    console.log('resources/python-runtime/ の構築が完了しました。')
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
