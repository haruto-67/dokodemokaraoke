import { app } from 'electron'
import { appendFile, readFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { existsSync } from 'node:fs'

function logPath(): string {
  return join(app.getPath('userData'), 'pipeline.log')
}

/** §5 ログ要件: 解析パイプラインの各ステップの所要時間と判定結果を記録する */
export async function appendPipelineLog(step: string, durationMs: number, result: string): Promise<void> {
  await mkdir(app.getPath('userData'), { recursive: true })
  const line = `${new Date().toISOString()}\t${step}\t${durationMs}ms\t${result}\n`
  await appendFile(logPath(), line)
}

export async function readPipelineLogs(limit = 500): Promise<string[]> {
  const p = logPath()
  if (!existsSync(p)) return []
  const text = await readFile(p, 'utf-8')
  const lines = text.split('\n').filter(Boolean)
  return lines.slice(-limit)
}
