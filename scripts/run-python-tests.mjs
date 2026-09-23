#!/usr/bin/env node
// npm run test:python のエントリポイント。同梱Pythonの実行ファイルパスがOSごとに違う
// (scripts/build-python-runtime.mjs参照)ため、package.jsonへ直接パスを書けない。
// ここでOSに応じたパスを解決してからunittestを起動する。

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

// `new URL('..', import.meta.url).pathname` は Windows で `/C:/...` のような
// 不正な絶対パス(先頭に余計な`/`が付く)になるため、fileURLToPathを使う。
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const RUNTIME_DIR = join(ROOT, 'resources', 'python-runtime')
const pythonBin = process.platform === 'win32' ? join(RUNTIME_DIR, 'python.exe') : join(RUNTIME_DIR, 'bin', 'python3')

if (!existsSync(pythonBin)) {
  console.error(
    `同梱Pythonが見つかりません: ${pythonBin}\n` + '先に `npm run build:python-runtime` を実行してください。'
  )
  process.exit(1)
}

const result = spawnSync(pythonBin, ['-m', 'unittest', 'discover', '-s', 'python/sidecar', '-p', '*_test.py', '-v'], {
  cwd: ROOT,
  stdio: 'inherit'
})
process.exit(result.status ?? 1)
