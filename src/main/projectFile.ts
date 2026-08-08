import JSZip from 'jszip'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { DokokaraProject } from '@shared/types'

export interface LoadedProjectFile {
  json: DokokaraProject
  analysisAudio: { path: string; data: Buffer } | null
  playbackAudio: { path: string; data: Buffer } | null
  pitchBin: Buffer | null
  onsetsBin: Buffer | null
  brokenParts: string[]
}

/**
 * .dokokara (ZIPコンテナ) を読み込む。
 * §4.12: プロジェクトファイルが破損している場合、可能な範囲で読み込みを試み、失敗した項目を明示する。
 */
export async function loadDokokaraFile(filePath: string): Promise<LoadedProjectFile> {
  const buf = await readFile(filePath)
  const zip = await JSZip.loadAsync(buf)
  const brokenParts: string[] = []

  let json: DokokaraProject | null = null
  try {
    const jsonText = await zip.file('project.json')?.async('string')
    if (!jsonText) throw new Error('project.json が見つかりません')
    json = JSON.parse(jsonText) as DokokaraProject
  } catch (e) {
    brokenParts.push('project.json')
  }
  if (!json) {
    throw new Error('project.json を読み込めませんでした。プロジェクトファイルが破損している可能性があります。')
  }

  let pitchBin: Buffer | null = null
  try {
    const f = zip.file('pitch.bin')
    if (f) pitchBin = await f.async('nodebuffer')
  } catch {
    brokenParts.push('pitch.bin')
  }

  let onsetsBin: Buffer | null = null
  try {
    const f = zip.file('onsets.bin')
    if (f) onsetsBin = await f.async('nodebuffer')
  } catch {
    brokenParts.push('onsets.bin')
  }

  let analysisAudio: { path: string; data: Buffer } | null = null
  if (json.audio?.analysis?.path) {
    try {
      const f = zip.file(json.audio.analysis.path)
      if (f) analysisAudio = { path: json.audio.analysis.path, data: await f.async('nodebuffer') }
      else brokenParts.push(json.audio.analysis.path)
    } catch {
      brokenParts.push(json.audio.analysis.path)
    }
  }

  let playbackAudio: { path: string; data: Buffer } | null = null
  if (json.audio?.playback?.path) {
    try {
      const f = zip.file(json.audio.playback.path)
      if (f) playbackAudio = { path: json.audio.playback.path, data: await f.async('nodebuffer') }
      else brokenParts.push(json.audio.playback.path)
    } catch {
      brokenParts.push(json.audio.playback.path)
    }
  }

  return { json, analysisAudio, playbackAudio, pitchBin, onsetsBin, brokenParts }
}

export interface SaveDokokaraInput {
  json: DokokaraProject
  pitchBin: Buffer | null
  onsetsBin: Buffer | null
  analysisAudio: { path: string; data: Buffer } | null
  playbackAudio: { path: string; data: Buffer } | null
}

/**
 * .dokokara (ZIPコンテナ) を書き出す。
 * §7.1: 音源部分は無圧縮(STORE)、それ以外はDEFLATEでよい。
 */
export async function saveDokokaraFile(filePath: string, input: SaveDokokaraInput): Promise<void> {
  const zip = new JSZip()
  zip.file('project.json', JSON.stringify(input.json, null, 2))
  if (input.pitchBin) zip.file('pitch.bin', input.pitchBin, { compression: 'DEFLATE' })
  if (input.onsetsBin) zip.file('onsets.bin', input.onsetsBin, { compression: 'DEFLATE' })
  if (input.analysisAudio) {
    zip.file(input.analysisAudio.path, input.analysisAudio.data, { compression: 'STORE' })
  }
  if (input.playbackAudio) {
    zip.file(input.playbackAudio.path, input.playbackAudio.data, { compression: 'STORE' })
  }

  await mkdir(dirname(filePath), { recursive: true })
  const out = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  // 一時ファイルに書いてからアトミックにリネームし、書き込み途中のクラッシュで壊れないようにする
  const tmpPath = `${filePath}.tmp-${Date.now()}`
  await writeFile(tmpPath, out)
  const { rename } = await import('node:fs/promises')
  await rename(tmpPath, filePath)
}
