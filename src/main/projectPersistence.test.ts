import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import JSZip from 'jszip'
import type { SaveProjectPayload } from '@shared/ipc'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  dialog: {},
  shell: { trashItem: vi.fn() }
}))

import { persistProjectPayload } from './ipcHandlers'
import { renameProjectFile, resolveExistingProjectPath, rewriteProjectName } from './projectStore'

const tempDirs: string[] = []

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dokokara-persistence-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function writeFixture(path: string): Promise<void> {
  const zip = new JSZip()
  zip.file(
    'project.json',
    JSON.stringify({
      name: '変更前',
      audio: {
        analysis: { path: 'audio/vocal.wav' },
        playback: { path: 'audio/off.wav' },
        original: { path: 'audio/original.m4a' }
      }
    })
  )
  zip.file('f0.bin', Buffer.from([1, 2, 3]))
  zip.file('audio/vocal.wav', Buffer.from('vocal'))
  zip.file('audio/off.wav', Buffer.from('off'))
  zip.file('audio/original.m4a', Buffer.from('original'))
  zip.file('extra.txt', 'keep me')
  await writeFile(path, await zip.generateAsync({ type: 'nodebuffer' }))
}

describe('プロジェクト保存の埋め込みデータ保持', () => {
  it('開いたプロジェクトを保存しても既存の音源とf0を引き継ぐ', async () => {
    const dir = await makeTempDir()
    const source = join(dir, 'source.dokokara')
    const destination = join(dir, 'saved.dokokara')
    await writeFixture(source)
    const payload: SaveProjectPayload = {
      filePath: null,
      existingFilePath: source,
      json: {
        name: '保存後',
        audio: {
          analysis: { path: 'audio/vocal.wav' },
          playback: { path: 'audio/off.wav' },
          original: { path: 'audio/original.m4a' }
        }
      },
      f0Bin: null,
      audio: { analysis: null, playback: null, original: null }
    }

    await persistProjectPayload(payload, destination)

    const zip = await JSZip.loadAsync(await readFile(destination))
    expect(await zip.file('audio/vocal.wav')?.async('string')).toBe('vocal')
    expect(await zip.file('audio/off.wav')?.async('string')).toBe('off')
    expect(await zip.file('audio/original.m4a')?.async('string')).toBe('original')
    expect(Array.from((await zip.file('f0.bin')?.async('uint8array')) ?? [])).toEqual([1, 2, 3])
  })

  it('名前変更時に内部名を更新し、音源と未知のエントリも保持する', async () => {
    const dir = await makeTempDir()
    const source = join(dir, 'source.dokokara')
    const destination = join(dir, 'renamed.dokokara')
    await writeFixture(source)

    await rewriteProjectName(source, destination, '変更後')

    await expect(stat(source)).rejects.toThrow()
    const zip = await JSZip.loadAsync(await readFile(destination))
    const project = JSON.parse((await zip.file('project.json')?.async('string')) ?? '{}') as { name?: string }
    expect(project.name).toBe('変更後')
    expect(await zip.file('audio/vocal.wav')?.async('string')).toBe('vocal')
    expect(await zip.file('extra.txt')?.async('string')).toBe('keep me')
  })

  it('Unicode正規化が異なるパスでも変更元ファイルを見つける', async () => {
    const dir = await makeTempDir()
    const decomposedName = 'どこでもカラオケ'.normalize('NFD')
    const source = join(dir, `${decomposedName}.dokokara`)
    await writeFixture(source)

    const resolved = await resolveExistingProjectPath(join(dir, 'どこでもカラオケ'.normalize('NFC') + '.dokokara'))
    expect(resolved.normalize('NFC')).toBe(source.normalize('NFC'))
  })

  it('実際のリネーム処理でファイル名と内部名を同時に変更する', async () => {
    const dir = await makeTempDir()
    const source = join(dir, '変更前.dokokara')
    await writeFixture(source)

    const destination = await renameProjectFile(source, '変更後')

    expect(destination).toBe(join(dir, '変更後.dokokara'))
    await expect(stat(source)).rejects.toThrow()
    const zip = await JSZip.loadAsync(await readFile(destination))
    const project = JSON.parse((await zip.file('project.json')?.async('string')) ?? '{}') as { name?: string }
    expect(project.name).toBe('変更後')
  })

  it('壊れたファイルの名前変更に失敗しても元ファイルを残す', async () => {
    const dir = await makeTempDir()
    const source = join(dir, 'broken.dokokara')
    await writeFile(source, 'not a zip')

    await expect(renameProjectFile(source, '変更後')).rejects.toThrow()
    await expect(stat(source)).resolves.toBeTruthy()
  })
})
