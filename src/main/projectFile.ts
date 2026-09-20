import JSZip from 'jszip'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { DokokaraProject } from '@shared/types'

export interface LoadedProjectFile {
  json: DokokaraProject
  analysisAudio: { path: string; data: Buffer } | null
  playbackAudio: { path: string; data: Buffer } | null
  originalAudio: { path: string; data: Buffer } | null
  f0Bin: Buffer | null
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

  let f0Bin: Buffer | null = null
  try {
    const f = zip.file('f0.bin')
    if (f) f0Bin = await f.async('nodebuffer')
  } catch {
    brokenParts.push('f0.bin')
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

  // audio.original(分離前の元音源)はv3.1で新設したフィールドのため、それより前に
  // 作成されたプロジェクトには存在しない。無くてもbrokenParts扱いにはしない。
  let originalAudio: { path: string; data: Buffer } | null = null
  if (json.audio?.original?.path) {
    try {
      const f = zip.file(json.audio.original.path)
      if (f) originalAudio = { path: json.audio.original.path, data: await f.async('nodebuffer') }
      else brokenParts.push(json.audio.original.path)
    } catch {
      brokenParts.push(json.audio.original.path)
    }
  }

  return { json, analysisAudio, playbackAudio, originalAudio, f0Bin, brokenParts }
}

export interface SaveDokokaraInput {
  json: DokokaraProject
  f0Bin: Buffer | null
  analysisAudio: { path: string; data: Buffer } | null
  playbackAudio: { path: string; data: Buffer } | null
  originalAudio: { path: string; data: Buffer } | null
}

/**
 * .dokokara (ZIPコンテナ) を書き出す。
 * §7.1: 音源部分は無圧縮(STORE)、それ以外はDEFLATEでよい。
 */
export async function saveDokokaraFile(filePath: string, input: SaveDokokaraInput): Promise<void> {
  const zip = new JSZip()
  zip.file('project.json', JSON.stringify(input.json, null, 2))
  if (input.f0Bin) zip.file('f0.bin', input.f0Bin, { compression: 'DEFLATE' })
  if (input.analysisAudio) {
    zip.file(input.analysisAudio.path, input.analysisAudio.data, { compression: 'STORE' })
  }
  if (input.playbackAudio) {
    zip.file(input.playbackAudio.path, input.playbackAudio.data, { compression: 'STORE' })
  }
  if (input.originalAudio) {
    zip.file(input.originalAudio.path, input.originalAudio.data, { compression: 'STORE' })
  }

  await mkdir(dirname(filePath), { recursive: true })
  const out = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  // 一時ファイルに書いてからアトミックにリネームし、書き込み途中のクラッシュで壊れないようにする
  const tmpPath = `${filePath}.tmp-${Date.now()}`
  await writeFile(tmpPath, out)
  const { rename } = await import('node:fs/promises')
  await rename(tmpPath, filePath)
}
