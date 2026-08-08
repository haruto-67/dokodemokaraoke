// electron-builder の afterPack フック(§8.3)。
// Apple Silicon は署名の無いバイナリを実行できないため、Developer ID を持たない場合でも
// ad-hoc 署名(codesign --force --deep --sign -)を明示的に行い、直後に署名の有無を検証する。
// これによりビルド設定の変更等で署名がスキップされた場合、DMGが生成される前にビルド自体を失敗させる。
//
// 単純な ad-hoc 署名だけでは entitlements が付与されず、Apple Silicon 上では
// V8 が JIT 用の実行可能メモリを確保できずに起動直後に SIGTRAP でクラッシュする
// (実機ビルドで確認済み)。com.apple.security.cs.allow-jit 等を含む
// entitlements.mac.plist を --deep 署名時に適用することでこれを回避する。
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return

  const entries = fs.readdirSync(context.appOutDir)
  const appBundle = entries.find((name) => name.endsWith('.app'))
  if (!appBundle) {
    throw new Error(`[afterPack] .app バンドルが見つかりませんでした: ${context.appOutDir}`)
  }
  const appPath = path.join(context.appOutDir, appBundle)
  const entitlementsPath = path.join(__dirname, 'entitlements.mac.plist')

  console.log(`[afterPack] ad-hoc署名(entitlements付き)を実行します: ${appPath}`)
  execFileSync(
    'codesign',
    ['--force', '--deep', '--sign', '-', '--entitlements', entitlementsPath, appPath],
    { stdio: 'inherit' }
  )

  console.log('[afterPack] 署名を検証します')
  execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose', appPath], { stdio: 'inherit' })

  const mainExecutable = path.join(appPath, 'Contents', 'MacOS', path.basename(appPath, '.app'))
  const entitlementsOutput = execFileSync('codesign', ['-d', '--entitlements', ':-', mainExecutable]).toString()
  if (!entitlementsOutput.includes('com.apple.security.cs.allow-jit')) {
    throw new Error('[afterPack] entitlementsの適用に失敗しました(allow-jitが見つかりません)')
  }

  console.log('[afterPack] ad-hoc署名(entitlements付き)の検証に成功しました')
}
