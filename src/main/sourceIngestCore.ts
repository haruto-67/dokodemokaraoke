import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import type { SourceIngestErrorKind, SourceIngestStage } from '../shared/ipc'

/**
 * YouTube URLからの音源取得(§4.3/§4.4.1 STEP1)の実処理。
 * electronに依存しない(`pythonSidecar.ts`と同じ理由で、実バイナリ無しにテストできるようにするため)。
 * electron側のIPC配線は `sourceIngest.ts` が担う。
 */

const DOWNLOAD_PROGRESS_RE = /\[download]\s+([\d.]+)%/

export type IngestChild = ChildProcessByStdio<null, Readable, Readable>

export interface SourceIngestDeps {
  ytDlpPath: string
  ffmpegPath: string
}

export interface SourceIngestResult {
  path: string
  fileName: string
  ext: string
}

export class SourceIngestCancelledError extends Error {
  constructor() {
    super('キャンセルされました')
    this.name = 'SourceIngestCancelledError'
  }
}

export class SourceIngestToolError extends Error {
  readonly kind: SourceIngestErrorKind
  constructor(message: string, kind: SourceIngestErrorKind) {
    super(message)
    this.name = 'SourceIngestToolError'
    this.kind = kind
  }
}

export function classifyYtDlpError(stderr: string): { kind: SourceIngestErrorKind; message: string } {
  const lower = stderr.toLowerCase()
  if (lower.includes('private video') || lower.includes('video unavailable') || lower.includes('has been removed')) {
    return {
      kind: 'private_or_deleted',
      message: '動画が非公開または削除されているため取得できませんでした。ローカルファイルの入力をご利用ください。'
    }
  }
  if (
    lower.includes('not available in your country') ||
    lower.includes('sign in to confirm your age') ||
    lower.includes('age-restricted') ||
    lower.includes('geo')
  ) {
    return {
      kind: 'region_or_age_restricted',
      message: '地域制限または年齢制限により取得できませんでした。ローカルファイルの入力をご利用ください。'
    }
  }
  return {
    kind: 'tool_failure',
    message:
      'YouTubeからの取得に失敗しました(yt-dlpの仕様変更等の可能性があります)。ローカルファイルの入力をご利用ください。'
  }
}

function runProcess(
  command: string,
  args: string[],
  onStdoutLine?: (line: string) => void
): { child: IngestChild; done: Promise<void> } {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  let stdoutBuffer = ''

  child.stdout.setEncoding('utf-8')
  child.stdout.on('data', (chunk: string) => {
    stdoutBuffer += chunk
    let newlineIndex = stdoutBuffer.indexOf('\n')
    while (newlineIndex !== -1) {
      const line = stdoutBuffer.slice(0, newlineIndex)
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1)
      onStdoutLine?.(line)
      newlineIndex = stdoutBuffer.indexOf('\n')
    }
  })
  child.stderr.setEncoding('utf-8')
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk
  })

  const done = new Promise<void>((resolve, reject) => {
    child.on('error', (err) => reject(err))
    child.on('exit', (code, signal) => {
      if (signal) {
        reject(new SourceIngestCancelledError())
        return
      }
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(stderr || `終了コード ${code}`))
    })
  })

  return { child, done }
}

async function findDownloadedFile(dir: string): Promise<string> {
  const entries = await readdir(dir)
  const match = entries.find((name) => name.startsWith('source.'))
  if (!match) throw new Error('ダウンロードした音声ファイルが見つかりません')
  return join(dir, match)
}

export interface RunningIngest {
  result: Promise<SourceIngestResult>
  cancel: () => void
}

/**
 * yt-dlpでの取得 → 同梱ffmpegでのwav正規化 を行い、結果ファイルのパスを返す。
 *
 * 成功時に生成したwav(とその作業ディレクトリ)は、呼び出し側が
 * プロジェクト保存時にコピーするまで残す必要があるため、ここでは削除しない
 * (§7 プロジェクトファイルの `sourcePath` 参照と同じ扱い)。
 * 失敗・キャンセル時のみ作業ディレクトリを掃除する。
 */
export function runSourceIngest(
  url: string,
  deps: SourceIngestDeps,
  onProgress: (stage: SourceIngestStage, progress: number, detail?: string) => void
): RunningIngest {
  let cancelled = false
  let currentChild: IngestChild | null = null

  const result = (async (): Promise<SourceIngestResult> => {
    const workDir = await mkdtemp(join(tmpdir(), 'dokokara-ingest-'))
    try {
      onProgress('downloading', 0)
      const { child, done } = runProcess(
        deps.ytDlpPath,
        [
          '--no-playlist',
          '--newline',
          '--ffmpeg-location',
          deps.ffmpegPath,
          '-f',
          'bestaudio/best',
          '-o',
          join(workDir, 'source.%(ext)s'),
          url
        ],
        (line) => {
          const match = DOWNLOAD_PROGRESS_RE.exec(line)
          if (match) onProgress('downloading', Math.min(1, Number(match[1]) / 100), line.trim())
        }
      )
      currentChild = child
      try {
        await done
      } catch (err) {
        if (cancelled || err instanceof SourceIngestCancelledError) throw new SourceIngestCancelledError()
        const { kind, message } = classifyYtDlpError((err as Error).message)
        throw new SourceIngestToolError(message, kind)
      }

      const downloadedPath = await findDownloadedFile(workDir)
      onProgress('normalizing', 0)
      const normalizedPath = join(workDir, 'normalized.wav')
      const { child: ffmpegChild, done: ffmpegDone } = runProcess(deps.ffmpegPath, [
        '-y',
        '-i',
        downloadedPath,
        '-ar',
        '44100',
        '-ac',
        '2',
        normalizedPath
      ])
      currentChild = ffmpegChild
      try {
        await ffmpegDone
      } catch (err) {
        if (cancelled || err instanceof SourceIngestCancelledError) throw new SourceIngestCancelledError()
        throw new SourceIngestToolError('音源の変換(ffmpeg)に失敗しました。', 'tool_failure')
      }

      onProgress('normalizing', 1)
      return { path: normalizedPath, fileName: 'youtube-audio.wav', ext: '.wav' }
    } catch (err) {
      await rm(workDir, { recursive: true, force: true }).catch(() => {})
      throw err
    }
  })()

  return {
    result,
    cancel() {
      cancelled = true
      currentChild?.kill()
    }
  }
}
