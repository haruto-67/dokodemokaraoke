import { app } from 'electron'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { DEFAULT_APP_SETTINGS, type AppSettings } from '@shared/types'

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

export function defaultProjectsDir(): string {
  return join(app.getPath('documents'), 'どこでもカラオケセット')
}

let cached: AppSettings | null = null

export async function loadSettings(): Promise<AppSettings> {
  if (cached) return cached
  const p = settingsPath()
  let loaded: Partial<AppSettings> = {}
  if (existsSync(p)) {
    try {
      loaded = JSON.parse(await readFile(p, 'utf-8'))
    } catch {
      loaded = {}
    }
  }
  const merged: AppSettings = { ...DEFAULT_APP_SETTINGS, ...loaded }
  if (!merged.projectsDir) merged.projectsDir = defaultProjectsDir()
  await mkdir(merged.projectsDir, { recursive: true })
  cached = merged
  return merged
}

export async function saveSettings(partial: Partial<AppSettings>): Promise<AppSettings> {
  const current = await loadSettings()
  const merged: AppSettings = { ...current, ...partial }
  cached = merged
  await mkdir(app.getPath('userData'), { recursive: true })
  await writeFile(settingsPath(), JSON.stringify(merged, null, 2))
  return merged
}
