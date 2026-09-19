import { describe, expect, it } from 'vitest'
import { chmodSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  classifyYtDlpError,
  runSourceIngest,
  SourceIngestCancelledError,
  SourceIngestToolError
} from './sourceIngestCore'

/**
 * 実際のyt-dlp/ffmpeg(resources/media-tools/、npm run build:media-toolsで取得)の代わりに、
 * 同じCLI呼び出し規約(-o <template>で出力先を受け取る/-iと最終引数で入出力する)で
 * 振る舞うNodeスクリプトをその場で書き出して使う。`pythonSidecar.test.ts`と同じ方針で、
 * 重いバイナリの取得無しに「取得→正規化→進捗/エラー/キャンセルの配線」を検証する。
 */
function writeFakeExecutable(body: string): string {
  const path = join(tmpdir(), `fake-tool-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`)
  writeFileSync(path, `#!/usr/bin/env node\n${body}`)
  chmodSync(path, 0o755)
  return path
}

function writeFakeYtDlp(mode: 'success' | 'private' | 'region' | 'slow-then-success'): string {
  return writeFakeExecutable(`
    import { writeFileSync } from 'node:fs'
    const args = process.argv.slice(2)
    const outIndex = args.indexOf('-o')
    const outTemplate = args[outIndex + 1]
    const outPath = outTemplate.replace('%(ext)s', 'webm')

    function fail(message) {
      process.stderr.write(message + '\\n')
      process.exit(1)
    }

    async function main() {
      if (${JSON.stringify(mode)} === 'private') fail('ERROR: Private video. Sign in if you have access.')
      if (${JSON.stringify(mode)} === 'region') fail('ERROR: This video is not available in your country.')
      if (${JSON.stringify(mode)} === 'slow-then-success') {
        process.stdout.write('[download]   0.0% of 1.00MiB\\n')
        await new Promise((r) => setTimeout(r, 2000))
      }
      process.stdout.write('[download]  50.0% of 1.00MiB at 1.00MiB/s ETA 00:01\\n')
      process.stdout.write('[download] 100.0% of 1.00MiB at 1.00MiB/s ETA 00:00\\n')
      writeFileSync(outPath, 'fake-downloaded-audio')
    }
    void main()
  `)
}

function writeFakeFfmpeg(mode: 'success' | 'fail' = 'success'): string {
  return writeFakeExecutable(`
    import { writeFileSync } from 'node:fs'
    const outPath = process.argv[process.argv.length - 1]
    if (${JSON.stringify(mode)} === 'fail') {
      process.stderr.write('ffmpeg: invalid data found when processing input\\n')
      process.exit(1)
    }
    writeFileSync(outPath, 'fake-normalized-wav')
  `)
}

describe('runSourceIngest', () => {
  it('yt-dlp→ffmpegの順で実行し、進捗コールバックを経て正規化後のwavパスを返す', async () => {
    const ytDlpPath = writeFakeYtDlp('success')
    const ffmpegPath = writeFakeFfmpeg('success')

    const progressEvents: { stage: string; progress: number }[] = []
    const job = runSourceIngest('https://www.youtube.com/watch?v=dummy', { ytDlpPath, ffmpegPath }, (stage, progress) =>
      progressEvents.push({ stage, progress })
    )

    const result = await job.result

    expect(result.fileName).toBe('youtube-audio.wav')
    expect(result.ext).toBe('.wav')
    expect(result.path.endsWith('normalized.wav')).toBe(true)
    expect(existsSync(result.path)).toBe(true)

    expect(progressEvents[0]).toEqual({ stage: 'downloading', progress: 0 })
    expect(progressEvents.some((e) => e.stage === 'downloading' && e.progress === 0.5)).toBe(true)
    expect(progressEvents.some((e) => e.stage === 'downloading' && e.progress === 1)).toBe(true)
    expect(progressEvents.at(-1)).toEqual({ stage: 'normalizing', progress: 1 })
  })

  it('非公開動画の場合、private_or_deletedとして分類されたエラーでrejectされる', async () => {
    const ytDlpPath = writeFakeYtDlp('private')
    const ffmpegPath = writeFakeFfmpeg('success')

    const job = runSourceIngest('https://www.youtube.com/watch?v=dummy', { ytDlpPath, ffmpegPath }, () => {})

    await expect(job.result).rejects.toMatchObject({ kind: 'private_or_deleted' })
    await expect(job.result).rejects.toThrow('ローカルファイルの入力をご利用ください')
  })

  it('地域/年齢制限の場合、region_or_age_restrictedとして分類される', async () => {
    const ytDlpPath = writeFakeYtDlp('region')
    const ffmpegPath = writeFakeFfmpeg('success')

    const job = runSourceIngest('https://www.youtube.com/watch?v=dummy', { ytDlpPath, ffmpegPath }, () => {})

    await expect(job.result).rejects.toMatchObject({ kind: 'region_or_age_restricted' })
  })

  it('ffmpegでの正規化に失敗した場合、tool_failureとして分類される', async () => {
    const ytDlpPath = writeFakeYtDlp('success')
    const ffmpegPath = writeFakeFfmpeg('fail')

    const job = runSourceIngest('https://www.youtube.com/watch?v=dummy', { ytDlpPath, ffmpegPath }, () => {})

    await expect(job.result).rejects.toMatchObject({ kind: 'tool_failure' })
  })

  it('cancel()を呼ぶとSourceIngestCancelledErrorでrejectされる(ダウンロード完了を待たない)', async () => {
    const ytDlpPath = writeFakeYtDlp('slow-then-success')
    const ffmpegPath = writeFakeFfmpeg('success')

    const job = runSourceIngest('https://www.youtube.com/watch?v=dummy', { ytDlpPath, ffmpegPath }, () => {})
    // fakeスクリプトが最初の progress を出してから2秒待つ間にキャンセルする
    await new Promise((r) => setTimeout(r, 200))
    job.cancel()

    await expect(job.result).rejects.toBeInstanceOf(SourceIngestCancelledError)
  })
})

describe('classifyYtDlpError', () => {
  it('Private video / Video unavailable / has been removed をprivate_or_deletedに分類する', () => {
    expect(classifyYtDlpError('ERROR: Private video').kind).toBe('private_or_deleted')
    expect(classifyYtDlpError('ERROR: Video unavailable').kind).toBe('private_or_deleted')
    expect(classifyYtDlpError('This video has been removed by the uploader').kind).toBe('private_or_deleted')
  })

  it('地域制限・年齢制限の文言をregion_or_age_restrictedに分類する', () => {
    expect(classifyYtDlpError('not available in your country').kind).toBe('region_or_age_restricted')
    expect(classifyYtDlpError('Sign in to confirm your age').kind).toBe('region_or_age_restricted')
  })

  it('分類できない失敗はtool_failureとして扱う(yt-dlpの仕様変更等)', () => {
    expect(classifyYtDlpError('ERROR: unable to extract player version').kind).toBe('tool_failure')
  })
})
