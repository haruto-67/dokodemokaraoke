import { describe, expect, it } from 'vitest'
import { chmodSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { classifyYtDlpUpdateOutput, runYtDlpUpdate } from './mediaToolsUpdate'

function writeFakeYtDlp(mode: 'updated' | 'already_latest' | 'failed'): string {
  const path = join(tmpdir(), `fake-ytdlp-update-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`)
  const body =
    mode === 'already_latest'
      ? `process.stdout.write('yt-dlp is up to date (2026.08.19)\\n')`
      : mode === 'updated'
        ? `process.stdout.write('Updated yt-dlp to version 2026.09.01\\n')`
        : `process.stderr.write('ERROR: unable to download latest version\\n'); process.exit(1)`
  writeFileSync(path, `#!/usr/bin/env node\n${body}\n`)
  chmodSync(path, 0o755)
  return path
}

describe('runYtDlpUpdate', () => {
  it('既に最新の場合はalready_latestを返す', async () => {
    const result = await runYtDlpUpdate(writeFakeYtDlp('already_latest'))
    expect(result.outcome).toBe('already_latest')
  })

  it('更新が行われた場合はupdatedを返す', async () => {
    const result = await runYtDlpUpdate(writeFakeYtDlp('updated'))
    expect(result.outcome).toBe('updated')
    expect(result.message).toContain('2026.09.01')
  })

  it('yt-dlpが非ゼロ終了した場合はfailedを返す', async () => {
    const result = await runYtDlpUpdate(writeFakeYtDlp('failed'))
    expect(result.outcome).toBe('failed')
    expect(result.message).toContain('unable to download')
  })

  it('実行ファイルが存在しない場合もfailedを返す(例外を投げない)', async () => {
    const result = await runYtDlpUpdate(join(tmpdir(), 'does-not-exist-binary'))
    expect(result.outcome).toBe('failed')
  })
})

describe('classifyYtDlpUpdateOutput', () => {
  it('exitCodeが0以外ならfailed', () => {
    expect(classifyYtDlpUpdateOutput('何かの出力', 1).outcome).toBe('failed')
  })

  it('up to date系の文言はalready_latest', () => {
    expect(classifyYtDlpUpdateOutput('yt-dlp is up to date (2026.08.19)', 0).outcome).toBe('already_latest')
  })

  it('それ以外の正常終了はupdated扱い', () => {
    expect(classifyYtDlpUpdateOutput('Updated yt-dlp to version 2026.09.01', 0).outcome).toBe('updated')
  })
})
