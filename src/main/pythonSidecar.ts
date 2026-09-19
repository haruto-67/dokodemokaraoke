import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { AnalysisStepProgress } from '../shared/types'
import type { SidecarMessage, SidecarRequest } from '../shared/pythonSidecarProtocol'

export interface PythonSidecarOptions {
  /** サイドカーからの進捗通知を受け取るコールバック */
  onProgress?: (id: string, progress: AnalysisStepProgress) => void
  /**
   * 子プロセスに追加で渡す環境変数(process.envにマージされる)。
   * モデル同梱パスの通知(DOKOKARA_MODELS_DIR)やオフライン強制
   * (HF_HUB_OFFLINE等)に使う。
   */
  env?: Record<string, string>
}

interface PendingRequest {
  resolve: (result: unknown) => void
  reject: (error: Error) => void
}

/**
 * Pythonサイドカー(子プロセス)とstdio越しにJSON-RPC風メッセージ(1行1メッセージ)を
 * やり取りする薄いクライアント。プロトコルは `src/shared/pythonSidecarProtocol.ts` 参照。
 *
 * electronには依存しない(spawnするパスは呼び出し側が渡す)。これは
 * `resources/python-runtime/` のパス解決(`pythonRuntime.ts`)と、実際にプロセスを
 * 起動して話す責務(このファイル)を分離し、後者を electron 抜きでテストできるようにするため。
 */
export class PythonSidecar {
  private proc: ChildProcessWithoutNullStreams | null = null
  private stdoutBuffer = ''
  private readonly pending = new Map<string, PendingRequest>()
  private readonly onProgress?: PythonSidecarOptions['onProgress']
  private readonly extraEnv: Record<string, string>

  constructor(
    private readonly pythonExecutable: string,
    private readonly scriptArgs: string[],
    options: PythonSidecarOptions = {}
  ) {
    this.onProgress = options.onProgress
    this.extraEnv = options.env ?? {}
  }

  start(): void {
    if (this.proc) return
    const proc = spawn(this.pythonExecutable, this.scriptArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...this.extraEnv }
    })
    this.proc = proc

    proc.stdout.setEncoding('utf-8')
    proc.stdout.on('data', (chunk: string) => this.handleStdoutChunk(chunk))
    proc.stderr.setEncoding('utf-8')
    proc.stderr.on('data', (chunk: string) => console.error(`[python-sidecar] ${chunk}`))

    proc.on('exit', (code) => {
      const error = new Error(`python-sidecarが終了しました(code=${code})`)
      for (const { reject } of this.pending.values()) reject(error)
      this.pending.clear()
      this.proc = null
    })
  }

  stop(): void {
    this.proc?.kill()
    this.proc = null
  }

  /**
   * リクエストを送信し、対応する `done`/`error` が返るまで待つ。
   * `id` は呼び出し側が指定する(cancel()で同じidをtargetIdとして狙えるようにするため。
   * ジョブ管理側が持つidとJSON-RPC上のidを一致させておくと、後からのキャンセルが
   * 素直に組める)。
   */
  request(req: SidecarRequest): Promise<unknown> {
    if (!this.proc) throw new Error('サイドカーが起動していません')
    return new Promise((resolve, reject) => {
      this.pending.set(req.id, { resolve, reject })
      this.proc!.stdin.write(`${JSON.stringify(req)}\n`)
    })
  }

  /** 実行中のリクエストをキャンセルする(応答は待たない fire-and-forget) */
  cancel(targetId: string): void {
    if (!this.proc) return
    const message: SidecarRequest = { id: randomUUID(), method: 'cancel', params: { targetId } }
    this.proc.stdin.write(`${JSON.stringify(message)}\n`)
  }

  private handleStdoutChunk(chunk: string): void {
    this.stdoutBuffer += chunk
    let newlineIndex = this.stdoutBuffer.indexOf('\n')
    while (newlineIndex !== -1) {
      const line = this.stdoutBuffer.slice(0, newlineIndex)
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1)
      if (line.trim().length > 0) this.handleLine(line)
      newlineIndex = this.stdoutBuffer.indexOf('\n')
    }
  }

  private handleLine(line: string): void {
    let message: SidecarMessage
    try {
      message = JSON.parse(line)
    } catch {
      console.error(`[python-sidecar] JSON以外の出力を無視: ${line}`)
      return
    }

    if (message.type === 'progress') {
      this.onProgress?.(message.id, message.progress)
      return
    }

    const pending = this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id)

    if (message.type === 'done') {
      pending.resolve(message.result)
    } else if (message.type === 'error') {
      pending.reject(new Error(message.message))
    }
  }
}
