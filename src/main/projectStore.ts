import { readdir, stat, rename, copyFile, mkdir } from 'node:fs/promises'
import { join, basename, extname } from 'node:path'
import { shell } from 'electron'
import JSZip from 'jszip'
import type { ProjectSummary, DokokaraProject } from '@shared/types'
import { loadSettings } from './settings'

async function readSummary(filePath: string): Promise<ProjectSummary | null> {
  try {
    const st = await stat(filePath)
    const buf = await (await import('node:fs/promises')).readFile(filePath)
    const zip = await JSZip.loadAsync(buf)
    const jsonText = await zip.file('project.json')?.async('string')
    if (!jsonText) return null
    const json = JSON.parse(jsonText) as DokokaraProject
    const durationSec = Math.max(
      json.audio?.playback?.duration ?? 0,
      json.audio?.analysis?.duration ?? 0
    )
    return {
      filePath,
      name: json.name || basename(filePath, extname(filePath)),
      durationSec,
      lineCount: json.lyrics?.length ?? 0,
      updatedAt: json.updatedAt || st.mtime.toISOString(),
      createdAt: json.createdAt || st.birthtime.toISOString(),
      waveformThumb: json.waveformThumb ?? null
    }
  } catch {
    return null
  }
}

export async function listProjectSummaries(): Promise<ProjectSummary[]> {
  const settings = await loadSettings()
  await mkdir(settings.projectsDir, { recursive: true })
  const entries = await readdir(settings.projectsDir, { withFileTypes: true })
  const dokokaraFiles = entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.dokokara'))
    .map((e) => join(settings.projectsDir, e.name))

  const summaries = await Promise.all(dokokaraFiles.map(readSummary))
  return summaries.filter((s): s is ProjectSummary => s !== null)
}

function sanitizeFileName(name: string): string {
  return name.replace(/[/\\:*?"<>|]/g, '_').trim() || '無題のプロジェクト'
}

export async function resolveNewProjectPath(name: string): Promise<string> {
  const settings = await loadSettings()
  await mkdir(settings.projectsDir, { recursive: true })
  const base = sanitizeFileName(name)
  let candidate = join(settings.projectsDir, `${base}.dokokara`)
  let i = 2
  while (await pathExists(candidate)) {
    candidate = join(settings.projectsDir, `${base} ${i}.dokokara`)
    i++
  }
  return candidate
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

export async function duplicateProjectFile(filePath: string): Promise<string> {
  const settings = await loadSettings()
  const base = basename(filePath, '.dokokara')
  let candidate = join(settings.projectsDir, `${base} のコピー.dokokara`)
  let i = 2
  while (await pathExists(candidate)) {
    candidate = join(settings.projectsDir, `${base} のコピー ${i}.dokokara`)
    i++
  }
  await copyFile(filePath, candidate)
  return candidate
}

export async function renameProjectFile(filePath: string, newName: string): Promise<string> {
  const settings = await loadSettings()
  const base = sanitizeFileName(newName)
  let candidate = join(settings.projectsDir, `${base}.dokokara`)
  if (candidate !== filePath && (await pathExists(candidate))) {
    let i = 2
    while (await pathExists(candidate)) {
      candidate = join(settings.projectsDir, `${base} ${i}.dokokara`)
      i++
    }
  }
  if (candidate !== filePath) {
    await rename(filePath, candidate)
  }
  return candidate
}

/** §4.1.1: 削除時はファイル自体をゴミ箱へ移動する（完全削除はしない） */
export async function trashProjectFile(filePath: string): Promise<void> {
  await shell.trashItem(filePath)
}

/** §4.1: クラッシュ後の復帰時に復元を提案するため、元ファイルより新しいバックアップを探す */
export async function findNewerBackup(filePath: string): Promise<string | null> {
  const settings = await loadSettings()
  const backupDir = join(settings.projectsDir, '.backups')
  if (!(await pathExists(backupDir))) return null
  const name = basename(filePath, '.dokokara')
  const entries = await readdir(backupDir, { withFileTypes: true })
  const candidates = entries
    .filter((e) => e.isFile() && e.name.startsWith(`${name}.`) && e.name.endsWith('.bak.dokokara'))
    .map((e) => join(backupDir, e.name))
  if (candidates.length === 0) return null

  const originalStat = await stat(filePath).catch(() => null)
  let newest: { path: string; mtime: number } | null = null
  for (const c of candidates) {
    const st = await stat(c)
    if (!newest || st.mtimeMs > newest.mtime) newest = { path: c, mtime: st.mtimeMs }
  }
  if (!newest) return null
  if (originalStat && newest.mtime <= originalStat.mtimeMs) return null
  return newest.path
}

export async function resolveBackupPath(projectName: string): Promise<string> {
  const settings = await loadSettings()
  const backupDir = join(settings.projectsDir, '.backups')
  await mkdir(backupDir, { recursive: true })
  return join(backupDir, `${sanitizeFileName(projectName)}.${Date.now()}.bak.dokokara`)
}
