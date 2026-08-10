// electron-builder の afterSign フック(§8.3)。
//
// 実機(Apple Silicon Mac, 最新macOS)で、electron-builderが直接パッケージングした
// .appを起動すると、entitlements・署名順序・Electron Fuses設定を含めどう調整しても
// 起動直後にV8/Node初期化中のSIGTRAPで確実にクラッシュする現象が再現し続けた。
//
// 実機での大量の起動試行によって切り分けた結果:
// - node_modules/electron の「無傷の」(Electron Fusesでパッチされていない)
//   Electron.appを土台にし、そこへelectron-builderが生成したResources
//   (app.asar等)・Frameworks(Squirrel等の付随フレームワーク・Helper.app群)・
//   Info.plistを移植した.appは問題なく起動する
// - 「Electron Framework.framework」自体を electron-builder側の
//   (Fusesパッチ済みの)ものへ差し替えると再びクラッシュする
// - 無傷ベースに元々含まれる未使用の既定Helper.app群(Electron Helper*.app)を
//   起動前に削除すると、内容としては全く同じはずのelectron-builder製の
//   Helper.app群に差し替えたときと同じくクラッシュが再現する。削除せず残すと
//   安定して起動する(8回連続成功を確認)。理由は特定できていないが、
//   結果は再現性があったため経験則として残す方針にしている。
//
// 根本原因(electron-builder / Electron Fuses内部の問題と推測)の特定までは
// 至らなかったため、実用上の回避策として「確実に起動する組み立て方」を
// このフックで自動化する: 無傷のElectron.appを土台に、electron-builderが
// 生成した成果物一式を移植して作り直してから署名する。
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

function findAll(rootDir, predicate, results = []) {
  const entries = fs.readdirSync(rootDir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name)
    if (entry.isDirectory()) {
      if (predicate(fullPath, entry.name)) {
        results.push(fullPath)
        continue
      }
      findAll(fullPath, predicate, results)
    }
  }
  return results
}

function sign(target, entitlementsPath) {
  execFileSync(
    'codesign',
    ['--force', '--sign', '-', '--timestamp=none', '--entitlements', entitlementsPath, target],
    { stdio: 'inherit' }
  )
}

function rmrf(target) {
  fs.rmSync(target, { recursive: true, force: true })
}

module.exports = async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return

  const entries = fs.readdirSync(context.appOutDir)
  const builtAppName = entries.find((name) => name.endsWith('.app'))
  if (!builtAppName) {
    throw new Error(`[afterSign] .app バンドルが見つかりませんでした: ${context.appOutDir}`)
  }
  const builtAppPath = path.join(context.appOutDir, builtAppName)
  const entitlementsPath = path.join(__dirname, 'entitlements.mac.plist')

  let rawElectronExecutable
  try {
    rawElectronExecutable = require('electron')
  } catch (e) {
    throw new Error(`[afterSign] node_modules/electron が見つかりません: ${e.message}`)
  }
  const rawAppPath = path.resolve(path.dirname(rawElectronExecutable), '..', '..')
  if (!fs.existsSync(rawAppPath)) {
    throw new Error(`[afterSign] 無傷のElectron.appが見つかりません: ${rawAppPath}`)
  }

  console.log(`[afterSign] 無傷のElectron.appを土台に.appを再構築します: ${rawAppPath} -> ${builtAppPath}`)

  const rebuiltAppPath = `${builtAppPath}.rebuilt`
  rmrf(rebuiltAppPath)
  execFileSync('cp', ['-R', rawAppPath, rebuiltAppPath], { stdio: 'inherit' })

  // electron-builderが生成した成果物(Resources一式・Frameworks一式・Info.plist)を移植する
  rmrf(path.join(rebuiltAppPath, 'Contents', 'Resources'))
  execFileSync('cp', ['-R', path.join(builtAppPath, 'Contents', 'Resources'), path.join(rebuiltAppPath, 'Contents', 'Resources')], {
    stdio: 'inherit'
  })

  // 重要: 「Electron Framework.framework」自体は無傷の(fuses未パッチの)ものを残す。
  // ここをelectron-builder側の(fusesパッチ済み)ものへ差し替えると再びクラッシュすることを確認済み。
  // Squirrel/Mantle/ReactiveObjC等の他フレームワークとHelper.app群を追加で移植する
  // (無傷ベースに元々含まれる既定のHelper.app群は削除しない。削除すると
  // クラッシュが再現することを確認済みのため、未使用でもそのまま残す)。
  const builtFrameworksDir = path.join(builtAppPath, 'Contents', 'Frameworks')
  const rebuiltFrameworksDir = path.join(rebuiltAppPath, 'Contents', 'Frameworks')

  for (const name of fs.readdirSync(builtFrameworksDir)) {
    if (name === 'Electron Framework.framework') continue
    rmrf(path.join(rebuiltFrameworksDir, name))
    execFileSync('cp', ['-R', path.join(builtFrameworksDir, name), path.join(rebuiltFrameworksDir, name)], {
      stdio: 'inherit'
    })
  }

  fs.copyFileSync(path.join(builtAppPath, 'Contents', 'Info.plist'), path.join(rebuiltAppPath, 'Contents', 'Info.plist'))

  // 実行ファイル名をelectron-builderの出力(executableName設定)に合わせる
  const rebuiltMacosDir = path.join(rebuiltAppPath, 'Contents', 'MacOS')
  const rawExecutableName = fs.readdirSync(rebuiltMacosDir)[0]
  const targetExecutableName = fs.readdirSync(path.join(builtAppPath, 'Contents', 'MacOS'))[0]
  if (rawExecutableName !== targetExecutableName) {
    fs.renameSync(path.join(rebuiltMacosDir, rawExecutableName), path.join(rebuiltMacosDir, targetExecutableName))
  }

  // electron-builderが出力した(クラッシュする).appを、再構築した.appで置き換える
  rmrf(builtAppPath)
  fs.renameSync(rebuiltAppPath, builtAppPath)

  console.log('[afterSign] 内側のコンポーネントから順にad-hoc署名(entitlements付き)を行います')
  const frameworksDir = path.join(builtAppPath, 'Contents', 'Frameworks')
  if (fs.existsSync(frameworksDir)) {
    const frameworks = findAll(frameworksDir, (_p, name) => name.endsWith('.framework'))
    for (const fw of frameworks) {
      console.log(`[afterSign]   framework: ${fw}`)
      sign(fw, entitlementsPath)
    }
    const helperApps = findAll(frameworksDir, (_p, name) => name.endsWith('.app'))
    for (const helper of helperApps) {
      console.log(`[afterSign]   helper app: ${helper}`)
      sign(helper, entitlementsPath)
    }
  }
  console.log(`[afterSign]   main app: ${builtAppPath}`)
  sign(builtAppPath, entitlementsPath)

  console.log('[afterSign] 署名を検証します')
  execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose', builtAppPath], { stdio: 'inherit' })

  const macosDir = path.join(builtAppPath, 'Contents', 'MacOS')
  const executableName = fs.readdirSync(macosDir)[0]
  const mainExecutable = path.join(macosDir, executableName)
  const entitlementsOutput = execFileSync('codesign', ['-d', '--entitlements', '-', mainExecutable]).toString()
  if (!entitlementsOutput.includes('com.apple.security.cs.allow-jit')) {
    throw new Error('[afterSign] entitlementsの適用に失敗しました(allow-jitが見つかりません)')
  }

  console.log('[afterSign] 再構築・署名(entitlements付き)の検証に成功しました')
}
