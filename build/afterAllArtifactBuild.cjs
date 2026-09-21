// electron-builder の afterAllArtifactBuild フック(§8.3)。DMG(とその他アーティファクト)の
// 生成が完全に終わった"後"に走る。
//
// 背景(Nestio「アプリ名」タスク): .appバンドルの「フォルダ名」自体は、electron-builder内部の
// appInfo.productFilename(app-builder-lib/out/appInfo.js)がexecutableName設定時にそちらを
// 優先して使う実装になっており、productName(日本語)とは切り離せない。実行ファイル名は
// Apple SiliconでのSIGTRAPクラッシュ回避のためASCII固定が必須(electron-builder.ymlの
// executableNameコメント参照)なので、.appの「フォルダ名」も一緒にASCII化されてしまい、
// /Applicationsにコピーした後のFinder上の表示がローマ字(DokokaraKaraoke.app)になる。
//
// 以前、afterSign(dmg-builderがDMGを組み立てる"前")の時点で.appフォルダ名を日本語へ
// リネームする方法を試したが、その後に続くelectron-builder自身のdmg-builderが内部的に
// 元のexecutableName由来のパスをまだ参照しており、`FileNotFoundError`でビルド全体が
// 失敗することが実機で確認された(build/afterSign.cjsの末尾コメント参照)。
//
// そこで、dmg-builderが完全に仕事を終えた"後"に走るこのフックで、
// 1) 出来上がったDMGをマウントし、2) 中の.appフォルダだけ日本語名にリネームしてコピーし、
// 3) 同じボリューム名でDMGを作り直す(hdiutilで再パッケージ)。署名は既にafterSignで
// .appの中身(Contents以下)に対して済んでおり、フォルダ名のリネームは署名対象に含まれない
// (codesignはバンドル内のInfo.plist等を見るのであって、外側のフォルダ名は見ない)ため、
// 再パッケージしても署名は壊れない。
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

function run(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf-8' })
}

function attachDmg(dmgPath) {
  const plist = run('hdiutil', ['attach', dmgPath, '-nobrowse', '-readonly', '-plist'])
  const match = /<key>mount-point<\/key>\s*<string>([^<]*)<\/string>/.exec(plist)
  if (!match) {
    throw new Error(`[afterAllArtifactBuild] hdiutil attachの出力からmount-pointを取得できませんでした: ${dmgPath}`)
  }
  return match[1]
}

function detachDmg(mountPoint) {
  try {
    run('hdiutil', ['detach', mountPoint, '-quiet'])
  } catch (e) {
    // ファイルコピー直後だとまだハンドルが残っていて失敗することがあるため、少し待って強制解除する
    execFileSync('sleep', ['1'])
    run('hdiutil', ['detach', mountPoint, '-force', '-quiet'])
  }
}

module.exports = async function afterAllArtifactBuild(buildResult) {
  if (!buildResult.platformToTargets || buildResult.platformToTargets.size === 0) return buildResult.artifactPaths
  // darwin以外(win等)のビルドでは何もしない
  const isMac = [...buildResult.platformToTargets.keys()].some((p) => String(p.name).toLowerCase() === 'mac')
  if (!isMac) return buildResult.artifactPaths

  const dmgPath = buildResult.artifactPaths.find((p) => p.endsWith('.dmg'))
  if (!dmgPath) return buildResult.artifactPaths

  const productName = buildResult.configuration.productName
  if (!productName) return buildResult.artifactPaths

  console.log(`[afterAllArtifactBuild] DMG内の.appを${productName}.appへリネームして再パッケージします: ${dmgPath}`)

  const mountPoint = attachDmg(dmgPath)
  let volumeName
  let stagingDir
  try {
    volumeName = path.basename(mountPoint)

    const entries = fs.readdirSync(mountPoint)
    const appName = entries.find((name) => name.endsWith('.app'))
    if (!appName) {
      throw new Error(`[afterAllArtifactBuild] DMG内に.appバンドルが見つかりませんでした: ${mountPoint}`)
    }

    stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dokokara-dmg-repack-'))
    for (const name of entries) {
      const destName = name === appName ? `${productName}.app` : name
      run('cp', ['-R', path.join(mountPoint, name), path.join(stagingDir, destName)])
    }
  } finally {
    detachDmg(mountPoint)
  }

  fs.rmSync(dmgPath, { force: true })
  const blockmapPath = `${dmgPath}.blockmap`
  fs.rmSync(blockmapPath, { force: true })

  run('hdiutil', ['create', '-volname', volumeName, '-srcfolder', stagingDir, '-fs', 'HFS+', '-format', 'UDZO', '-ov', dmgPath])
  fs.rmSync(stagingDir, { recursive: true, force: true })

  console.log(`[afterAllArtifactBuild] 再パッケージ完了(ボリューム名: ${volumeName}, .app: ${productName}.app)`)

  return buildResult.artifactPaths.filter((p) => p !== blockmapPath)
}
