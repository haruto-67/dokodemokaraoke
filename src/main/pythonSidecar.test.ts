import { describe, expect, it } from 'vitest'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PythonSidecar } from './pythonSidecar'

/**
 * 実際のPythonサイドカーの代わりに、同じstdioプロトコルを喋るNodeスクリプトを
 * その場で書き出して使う。resources/python-runtime/ のビルド(重い)に依存せず、
 * 通信の枠組み(JSON-RPC風メッセージのフレーミング・progress/done/error/cancel)
 * だけを検証する。
 */
function writeFakeSidecarScript(behavior: string): string {
  const path = join(tmpdir(), `fake-sidecar-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`)
  writeFileSync(path, behavior)
  return path
}

const readline = `
import { createInterface } from 'node:readline'
const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const req = JSON.parse(line)
  handle(req)
})
function send(msg) { process.stdout.write(JSON.stringify(msg) + '\\n') }
`

describe('PythonSidecar', () => {
  it('analyzeリクエストに対しprogressを経てdoneが解決される', async () => {
    const script = writeFakeSidecarScript(`
      ${readline}
      function handle(req) {
        if (req.method === 'analyze') {
          send({ type: 'progress', id: req.id, progress: { id: 'pitch', label: 'ピッチ検出', progress: 0.5, status: 'running' } })
          send({ type: 'done', id: req.id, result: { ok: true, params: req.params } })
        }
      }
    `)

    const progressEvents: unknown[] = []
    const sidecar = new PythonSidecar(process.execPath, [script], {
      onProgress: (id, progress) => progressEvents.push({ id, progress })
    })
    sidecar.start()

    const result = await sidecar.request({
      id: 'job-1',
      method: 'analyze',
      params: { sourceAudioPath: '/tmp/source.wav', lyricsLines: ['今日は晴れ'], totalDurationSec: 120 }
    })

    expect(result).toEqual({
      ok: true,
      params: { sourceAudioPath: '/tmp/source.wav', lyricsLines: ['今日は晴れ'], totalDurationSec: 120 }
    })
    expect(progressEvents).toHaveLength(1)
    expect((progressEvents[0] as { progress: { id: string } }).progress.id).toBe('pitch')

    sidecar.stop()
  })

  it('サイドカーがerrorを返すとrequestがrejectされる', async () => {
    const script = writeFakeSidecarScript(`
      ${readline}
      function handle(req) {
        send({ type: 'error', id: req.id, message: '解析に失敗しました' })
      }
    `)

    const sidecar = new PythonSidecar(process.execPath, [script])
    sidecar.start()

    await expect(
      sidecar.request({
        id: 'job-2',
        method: 'analyze',
        params: { sourceAudioPath: '/tmp/source.wav', lyricsLines: [], totalDurationSec: 1 }
      })
    ).rejects.toThrow('解析に失敗しました')

    sidecar.stop()
  })

  it('cancelはmethod:cancelとtargetIdを含むJSON-RPCメッセージをstdin経由で送る', async () => {
    // 受信した行をそのまま progress.detail に載せて送り返すエコーサイドカー。
    // cancel()自体はfire-and-forgetで戻り値を持たないため、実際に流れたバイト列を
    // 折り返してもらうことで送信内容を検証する。
    const script = writeFakeSidecarScript(`
      ${readline}
      function handle(req) {
        send({ type: 'progress', id: 'echo', progress: { id: 'echo', label: 'echo', progress: 0, status: 'running', detail: JSON.stringify(req) } })
      }
    `)

    const echoed: { method: string; params: { targetId: string } }[] = []
    const sidecar = new PythonSidecar(process.execPath, [script], {
      onProgress: (_id, progress) => {
        echoed.push(JSON.parse(progress.detail as string))
      }
    })
    sidecar.start()

    sidecar.cancel('target-request-id-123')

    const deadline = Date.now() + 3000
    while (echoed.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    expect(echoed).toHaveLength(1)
    expect(echoed[0].method).toBe('cancel')
    expect(echoed[0].params.targetId).toBe('target-request-id-123')

    sidecar.stop()
  })

  it('optionsのenvが子プロセスに渡る(モデル同梱パスの通知に使う)', async () => {
    const script = writeFakeSidecarScript(`
      ${readline}
      function handle(req) {
        send({ type: 'done', id: req.id, result: { modelsDir: process.env.DOKOKARA_MODELS_DIR ?? null } })
      }
    `)

    const sidecar = new PythonSidecar(process.execPath, [script], {
      env: { DOKOKARA_MODELS_DIR: '/tmp/dokokara-models-test' }
    })
    sidecar.start()

    const result = await sidecar.request({ id: 'job-env', method: 'analyze', params: { sourceAudioPath: '', lyricsLines: [], totalDurationSec: 0 } })

    expect(result).toEqual({ modelsDir: '/tmp/dokokara-models-test' })
    sidecar.stop()
  })
})
