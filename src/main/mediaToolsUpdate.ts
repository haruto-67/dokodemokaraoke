import { spawn } from 'node:child_process'
import type { YtDlpUpdateResult } from '../shared/types'

/**
 * 同梱yt-dlpの自己更新(§4.3実装メモ「同梱版＋任意更新」)。
 * yt-dlpの配布バイナリ(yt-dlp_macos等)は `-U` で自己更新する公式機能を持つため、
 * それをそのまま起動するだけでよい。electronに依存しないため、
 * `sourceIngestCore.ts`と同様にfakeバイナリで実行結果の分類をテストできる。
 */
export function classifyYtDlpUpdateOutput(output: string, exitCode: number): YtDlpUpdateResult {
  if (exitCode !== 0) {
    return { outcome: 'failed', message: output.trim() || `終了コード ${exitCode}` }
  }
  if (/up.to.date|already.*(latest|up-to-date)/i.test(output)) {
    return { outcome: 'already_latest', message: 'yt-dlpは既に最新版です。' }
  }
  return { outcome: 'updated', message: output.trim() || 'yt-dlpを最新版に更新しました。' }
}

export function runYtDlpUpdate(ytDlpPath: string): Promise<YtDlpUpdateResult> {
  return new Promise((resolve) => {
    let output = ''
    const child = spawn(ytDlpPath, ['-U'], { stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.setEncoding('utf-8')
    child.stdout.on('data', (chunk: string) => (output += chunk))
    child.stderr.setEncoding('utf-8')
    child.stderr.on('data', (chunk: string) => (output += chunk))
    child.on('error', (err) => resolve({ outcome: 'failed', message: err.message }))
    child.on('exit', (code) => resolve(classifyYtDlpUpdateOutput(output, code ?? 1)))
  })
}
