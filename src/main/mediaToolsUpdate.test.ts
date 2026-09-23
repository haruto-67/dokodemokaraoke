import { describe, expect, it, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { classifyYtDlpUpdateOutput, runYtDlpUpdate } from './mediaToolsUpdate'

/**
 * 実際のyt-dlpバイナリを起動する代わりに、`node:child_process`のspawnをモックして
 * 子プロセスのイベント(stdout/stderr/exit)を直接シミュレートする。
 * OSのシェル実行に依存する「実行可能なfakeスクリプトファイルを書き出して起動する」方式は、
 * Windowsでは shebang 直接実行がサポートされず(spawn EFTYPE)、.cmdラッパー経由も
 * Node 20.11+/libuvのセキュリティ修正(CVE-2024-27980)により shell:true 無しでは
 * 起動できない(spawn EINVAL)ため、macOS/Linux/Windowsいずれでも同じ挙動になる
 * この方式に置き換えた。
 */

class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter() as EventEmitter & { setEncoding: (enc: string) => void }
  stderr = new EventEmitter() as EventEmitter & { setEncoding: (enc: string) => void }

  constructor() {
    super()
    this.stdout.setEncoding = () => {}
    this.stderr.setEncoding = () => {}
  }
}

let spawnImpl: () => FakeChildProcess

vi.mock('node:child_process', () => ({
  spawn: (..._args: unknown[]) => spawnImpl()
}))

function mockSpawnEmitting(stdout: string, stderr: string, exitCode: number): void {
  spawnImpl = () => {
    const child = new FakeChildProcess()
    setImmediate(() => {
      if (stdout) child.stdout.emit('data', stdout)
      if (stderr) child.stderr.emit('data', stderr)
      child.emit('exit', exitCode)
    })
    return child
  }
}

function mockSpawnError(err: NodeJS.ErrnoException): void {
  spawnImpl = () => {
    const child = new FakeChildProcess()
    setImmediate(() => child.emit('error', err))
    return child
  }
}

beforeEach(() => {
  spawnImpl = () => new FakeChildProcess()
})

describe('runYtDlpUpdate', () => {
  it('既に最新の場合はalready_latestを返す', async () => {
    mockSpawnEmitting('yt-dlp is up to date (2026.08.19)\n', '', 0)
    const result = await runYtDlpUpdate('/fake/yt-dlp')
    expect(result.outcome).toBe('already_latest')
  })

  it('更新が行われた場合はupdatedを返す', async () => {
    mockSpawnEmitting('Updated yt-dlp to version 2026.09.01\n', '', 0)
    const result = await runYtDlpUpdate('/fake/yt-dlp')
    expect(result.outcome).toBe('updated')
    expect(result.message).toContain('2026.09.01')
  })

  it('yt-dlpが非ゼロ終了した場合はfailedを返す', async () => {
    mockSpawnEmitting('', 'ERROR: unable to download latest version\n', 1)
    const result = await runYtDlpUpdate('/fake/yt-dlp')
    expect(result.outcome).toBe('failed')
    expect(result.message).toContain('unable to download')
  })

  it('実行ファイルが存在しない場合もfailedを返す(例外を投げない)', async () => {
    mockSpawnError(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }))
    const result = await runYtDlpUpdate('/fake/does-not-exist-binary')
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
