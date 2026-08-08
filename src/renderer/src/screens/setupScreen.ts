import type { AppContext } from '../appContext'
import type { ScreenHandle } from '../lib/screen'
import { el } from '../lib/dom'
import { formatTime } from '../lib/dom'
import { decodeAudio } from '../lib/audio'
import { parseRubyLine } from '@shared/ruby'
import { notifyError } from '../lib/projectActions'
import type { SetupAudioFile } from '../appContext'

const LENGTH_DIFF_WARN_SEC = 3

export function mountSetupScreen(container: HTMLElement, ctx: AppContext): ScreenHandle {
  const root = el('div', { className: 'setup-screen' })
  container.appendChild(root)

  const header = el('div', { className: 'setup-header' }, [
    el('button', { className: 'btn btn-ghost' }, ['← ホームに戻る']),
    el('h1', { className: 'setup-title' }, ['新規プロジェクト'])
  ])
  const backBtn = header.querySelector('button') as HTMLButtonElement
  backBtn.addEventListener('click', () => ctx.navigate('home'))

  const nameRow = el('div', { className: 'setup-row' }, [
    el('label', { className: 'setup-label' }, ['プロジェクト名']),
    (() => {
      const input = el('input', { type: 'text', placeholder: '曲名など' }) as HTMLInputElement
      input.value = ctx.ui.getState().setupDraft.projectName
      input.addEventListener('input', () => updateDraft({ projectName: input.value }))
      return input
    })()
  ])

  // --- 音源ドロップゾーン (§4.3) ---
  const dropZones = el('div', { className: 'setup-dropzones' })
  const analysisZone = createDropZone('解析用（オンボーカル・必須）', 'ボーカルを含む通常の音源。ピッチ検出に使用します。', 'analysis')
  const playbackZone = createDropZone('再生用（オフボーカル・任意）', '伴奏のみの音源。未指定の場合は解析用を再生にも流用します。', 'playback')
  dropZones.append(analysisZone.el, playbackZone.el)

  const lengthWarning = el('div', { className: 'setup-warning', style: { display: 'none' } as unknown as CSSStyleDeclaration })

  // --- 歌詞入力 (§4.5) ---
  const lyricsSection = el('div', { className: 'setup-lyrics' })
  const lyricsHeader = el('div', { className: 'setup-lyrics-header' }, [
    el('label', { className: 'setup-label' }, ['歌詞（1行 = 1フレーズ）']),
    el('div', { className: 'setup-lyrics-actions' })
  ])
  const lineCountLabel = el('span', { className: 'mono setup-line-count' }, ['0 行'])
  const loadTxtBtn = el('button', { className: 'btn btn-ghost' }, ['.txt から読み込む'])
  const removeSpacesLabel = el('label', { className: 'setup-checkbox' })
  const removeSpacesInput = el('input', { type: 'checkbox' }) as HTMLInputElement
  removeSpacesInput.checked = ctx.ui.getState().setupDraft.removeSpaces
  removeSpacesLabel.append(removeSpacesInput, document.createTextNode('全角/半角スペースを除去する'))
  ;(lyricsHeader.querySelector('.setup-lyrics-actions') as HTMLElement).append(
    removeSpacesLabel,
    loadTxtBtn,
    lineCountLabel
  )

  const lyricsTextarea = el('textarea', {
    rows: 14,
    placeholder: '今日(きょう)は晴れ\n｜明日《あした》も晴れるといいな\n...'
  }) as HTMLTextAreaElement
  lyricsTextarea.value = ctx.ui.getState().setupDraft.lyricsText
  lyricsTextarea.addEventListener('input', () => {
    updateDraft({ lyricsText: lyricsTextarea.value })
    renderPreview()
  })

  loadTxtBtn.addEventListener('click', async () => {
    const text = await window.dokokara.pickTextFile()
    if (text == null) return
    lyricsTextarea.value = text
    updateDraft({ lyricsText: text })
    renderPreview()
  })

  removeSpacesInput.addEventListener('change', () => {
    updateDraft({ removeSpaces: removeSpacesInput.checked })
    renderPreview()
  })

  const previewPanel = el('div', { className: 'setup-preview panel-2' })

  lyricsSection.append(lyricsHeader, lyricsTextarea, el('div', { className: 'setup-preview-label' }, ['ルビプレビュー']), previewPanel)

  function renderPreview(): void {
    const draft = ctx.ui.getState().setupDraft
    const rawLines = draft.lyricsText.split('\n')
    const lines = rawLines.map((l) => (draft.removeSpaces ? l.replace(/[ 　]/g, '') : l)).filter((l) => l.trim().length > 0)
    lineCountLabel.textContent = `${lines.length} 行`

    previewPanel.innerHTML = ''
    if (lines.length === 0) {
      previewPanel.appendChild(el('p', { className: 'setup-preview-empty' }, ['歌詞を入力するとここにプレビューが表示されます']))
      return
    }
    for (const line of lines.slice(0, 200)) {
      const segments = parseRubyLine(line)
      const p = el('p', { className: 'setup-preview-line' })
      for (const seg of segments) {
        if (seg.ruby) {
          const ruby = el('ruby', {}, [seg.text, el('rt', {}, [seg.ruby])])
          p.appendChild(ruby)
        } else {
          p.appendChild(document.createTextNode(seg.text))
        }
      }
      previewPanel.appendChild(p)
    }
  }

  function updateDraft(patch: Partial<ReturnType<typeof getDraft>>): void {
    ctx.ui.setState((s) => ({ setupDraft: { ...s.setupDraft, ...patch } }))
  }
  function getDraft() {
    return ctx.ui.getState().setupDraft
  }

  function createDropZone(
    title: string,
    desc: string,
    kind: 'analysis' | 'playback'
  ): { el: HTMLElement; refresh: () => void } {
    const zone = el('div', { className: 'dropzone panel-2' })
    const titleEl = el('div', { className: 'dropzone-title' }, [title])
    const descEl = el('div', { className: 'dropzone-desc' }, [desc])
    const infoEl = el('div', { className: 'dropzone-info mono' })
    const pickBtn = el('button', { className: 'btn btn-ghost' }, ['ファイルを選択'])
    const progressEl = el('div', { className: 'dropzone-progress', style: { display: 'none' } as unknown as CSSStyleDeclaration }, ['読み込み中…'])

    zone.append(titleEl, descEl, infoEl, pickBtn, progressEl)

    function refresh(): void {
      const draft = getDraft()
      const file = kind === 'analysis' ? draft.analysisAudio : draft.playbackAudio
      if (file) {
        infoEl.textContent = `${file.fileName} ・ ${formatTime(file.buffer.duration)}`
        zone.classList.add('has-file')
      } else {
        infoEl.textContent = ''
        zone.classList.remove('has-file')
      }
      checkLengthWarning()
    }

    async function handleFile(path: string, fileName: string, ext: string, data: ArrayBuffer): Promise<void> {
      progressEl.style.display = 'block'
      try {
        const buffer = await decodeAudio(ctx.playback.audioContext, data)
        const info: SetupAudioFile = { path, ext, fileName, buffer }
        if (kind === 'analysis') updateDraft({ analysisAudio: info })
        else updateDraft({ playbackAudio: info })
        refresh()
      } catch (e) {
        notifyError((e as Error).message)
      } finally {
        progressEl.style.display = 'none'
      }
    }

    pickBtn.addEventListener('click', async () => {
      const picked = await window.dokokara.pickAudioFile()
      if (!picked) return
      await handleFile(picked.path, picked.name, picked.ext, picked.data)
    })

    zone.addEventListener('dragover', (e) => {
      e.preventDefault()
      zone.classList.add('dragover')
    })
    zone.addEventListener('dragleave', () => zone.classList.remove('dragover'))
    zone.addEventListener('drop', async (e) => {
      e.preventDefault()
      zone.classList.remove('dragover')
      const file = e.dataTransfer?.files?.[0]
      if (!file) return
      const ext = '.' + (file.name.split('.').pop() ?? '')
      const data = await file.arrayBuffer()
      // Electron の File には path プロパティが渡る
      const path = (file as unknown as { path?: string }).path ?? file.name
      await handleFile(path, file.name, ext, data)
    })

    refresh()
    return { el: zone, refresh }
  }

  function checkLengthWarning(): void {
    const draft = getDraft()
    if (draft.analysisAudio && draft.playbackAudio) {
      const diff = Math.abs(draft.analysisAudio.buffer.duration - draft.playbackAudio.buffer.duration)
      if (diff >= LENGTH_DIFF_WARN_SEC) {
        lengthWarning.textContent = `⚠ 解析用と再生用の長さが ${diff.toFixed(1)} 秒異なります。別マスターの可能性があります。`
        lengthWarning.style.display = 'block'
        return
      }
    }
    lengthWarning.style.display = 'none'
  }

  const footer = el('div', { className: 'setup-footer' })
  const startBtn = el('button', { className: 'btn btn-primary setup-start-btn' }, ['解析を開始する →'])
  startBtn.addEventListener('click', () => {
    const draft = getDraft()
    if (!draft.analysisAudio) {
      notifyError('解析用（オンボーカル）の音源を指定してください。')
      return
    }
    const rawLines = draft.lyricsText.split('\n')
    const lines = rawLines.map((l) => (draft.removeSpaces ? l.replace(/[ 　]/g, '') : l)).filter((l) => l.trim().length > 0)
    if (lines.length === 0) {
      notifyError('歌詞を1行以上入力してください。')
      return
    }
    if (!draft.projectName.trim()) {
      updateDraft({ projectName: lines[0].slice(0, 20) })
    }
    ctx.navigate('analyzing')
  })
  footer.appendChild(startBtn)

  root.append(header, nameRow, dropZones, lengthWarning, lyricsSection, footer)
  renderPreview()

  return {
    unmount() {
      container.removeChild(root)
    }
  }
}
