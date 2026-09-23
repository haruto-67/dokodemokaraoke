import { describe, expect, it, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { existsSync, writeFileSync } from 'node:fs'
import {
  classifyYtDlpError,
  runSourceIngest,
  SourceIngestCancelledError,
  SourceIngestToolError
} from './sourceIngestCore'

/**
 * 実際のyt-dlp/ffmpeg(resources/media-tools/、npm run build:media-toolsで取得)の代わりに、
 * `node:child_process`のspawnをモックして子プロセスのイベント(stdout/stderr/exit)を
 * 直接シミュレートする。OSのシェル実行に依存する「実行可能なfakeスクリプトファイルを
 * 書き出して起動する」方式は、Windowsでは shebang 直接実行がサポートされず(spawn EFTYPE)、
 * .cmdラッパー経由も Node 20.11+/libuvのセキュリティ修正(CVE-2024-27980)により
 * shell:true 無しでは起動できない(spawn EINVAL)ため、macOS/Linux/Windowsいずれでも
 * 同じ挙動になるこの方式に置き換えた。
 */

class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter() as EventEmitter & { setEncoding: (enc: string) => void }
  stderr = new EventEmitter() as EventEmitter & { setEncoding: (enc: string) => void }
  onKill: (() => void) | null = null

  constructor() {
    super()
    this.stdout.setEncoding = () => {}
    this.stderr.setEncoding = () => {}
  }

  kill(): void {
    if (this.onKill) this.onKill()
    else this.emit('exit', null, 'SIGTERM')
  }
}

type SpawnHandler = (command: string, args: string[]) => FakeChildProcess

let spawnQueue: SpawnHandler[] = []

vi.mock('node:child_process', () => ({
  spawn: (command: string, args: string[]) => {
    const handler = spawnQueue.shift()
    if (!handler) throw new Error(`unexpected spawn: ${command} ${args.join(' ')}`)
    return handler(command, args)
  }
}))

beforeEach(() => {
  spawnQueue = []
})

function ytDlpSuccess(delayMs = 0): SpawnHandler {
  return (_command, args) => {
    const child = new FakeChildProcess()
    setImmediate(() => {
      const outIndex = args.indexOf('-o')
      const outTemplate = args[outIndex + 1]
      const outPath = outTemplate.replace('%(ext)s', 'webm')

      child.stdout.emit('data', '[download]   0.0% of 1.00MiB\n')

      const finish = (): void => {
        child.stdout.emit('data', '[download]  50.0% of 1.00MiB at 1.00MiB/s ETA 00:01\n')
        child.stdout.emit('data', '[download] 100.0% of 1.00MiB at 1.00MiB/s ETA 00:00\n')
        writeFileSync(outPath, 'fake-downloaded-audio')
        child.emit('exit', 0)
      }

      if (delayMs > 0) {
        const timer = setTimeout(finish, delayMs)
        child.onKill = () => {
          clearTimeout(timer)
          child.emit('exit', null, 'SIGTERM')
        }
      } else {
        finish()
      }
    })
    return child
  }
}

function ytDlpFailure(message: string): SpawnHandler {
  return () => {
    const child = new FakeChildProcess()
    setImmediate(() => {
      child.stderr.emit('data', message + '\n')
      child.emit('exit', 1)
    })
    return child
  }
}

function ffmpegSuccess(): SpawnHandler {
  return (_command, args) => {
    const child = new FakeChildProcess()
    setImmediate(() => {
      const outPath = args[args.length - 1]
      writeFileSync(outPath, 'fake-normalized-wav')
      child.emit('exit', 0)
    })
    return child
  }
}

function ffmpegFailure(): SpawnHandler {
  return () => {
    const child = new FakeChildProcess()
    setImmediate(() => {
      child.stderr.emit('data', 'ffmpeg: invalid data found when processing input\n')
      child.emit('exit', 1)
    })
    return child
  }
}

describe('runSourceIngest', () => {
  it('yt-dlp→ffmpegの順で実行し、進捗コールバックを経て正規化後のwavパスを返す', async () => {
    spawnQueue = [ytDlpSuccess(), ffmpegSuccess()]

    const progressEvents: { stage: string; progress: number }[] = []
    const job = runSourceIngest('https://www.youtube.com/watch?v=dummy', { ytDlpPath: 'yt-dlp', ffmpegPath: 'ffmpeg' }, (stage, progress) =>
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
    spawnQueue = [ytDlpFailure('ERROR: Private video. Sign in if you have access.'), ffmpegSuccess()]

    const job = runSourceIngest('https://www.youtube.com/watch?v=dummy', { ytDlpPath: 'yt-dlp', ffmpegPath: 'ffmpeg' }, () => {})

    await expect(job.result).rejects.toMatchObject({ kind: 'private_or_deleted' })
    await expect(job.result).rejects.toThrow('ローカルファイルの入力をご利用ください')
  })

  it('地域/年齢制限の場合、region_or_age_restrictedとして分類される', async () => {
    spawnQueue = [ytDlpFailure('ERROR: This video is not available in your country.'), ffmpegSuccess()]

    const job = runSourceIngest('https://www.youtube.com/watch?v=dummy', { ytDlpPath: 'yt-dlp', ffmpegPath: 'ffmpeg' }, () => {})

    await expect(job.result).rejects.toMatchObject({ kind: 'region_or_age_restricted' })
  })

  it('ffmpegでの正規化に失敗した場合、tool_failureとして分類される', async () => {
    spawnQueue = [ytDlpSuccess(), ffmpegFailure()]

    const job = runSourceIngest('https://www.youtube.com/watch?v=dummy', { ytDlpPath: 'yt-dlp', ffmpegPath: 'ffmpeg' }, () => {})

    await expect(job.result).rejects.toMatchObject({ kind: 'tool_failure' })
  })

  it('cancel()を呼ぶとSourceIngestCancelledErrorでrejectされる(ダウンロード完了を待たない)', async () => {
    spawnQueue = [ytDlpSuccess(2000), ffmpegSuccess()]

    const job = runSourceIngest('https://www.youtube.com/watch?v=dummy', { ytDlpPath: 'yt-dlp', ffmpegPath: 'ffmpeg' }, () => {})
    // 最初の progress を出してから2秒待つ間にキャンセルする
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
