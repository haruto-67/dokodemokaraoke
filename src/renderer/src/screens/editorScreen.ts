import type { AppContext } from '../appContext'
import type { ScreenHandle } from '../lib/screen'
import { el, clear, formatTime } from '../lib/dom'
import { saveProject, confirmDiscardIfDirty } from '../lib/projectActions'
import { snapTime, nearestGridTime, SNAP_PRIORITY, type SnapTarget } from '../lib/snap'
import { rescaleTokensExcludingLocked, reallocateRespectingLocks } from '../lib/retiming'
import { buildWaveformPeaks } from '../lib/waveform'
import { tokenizeLine } from '@shared/tokenize'
import { allocateTokenTimings } from '@shared/analysis/allocate'
import { findPitchChangePoints } from '@shared/analysis/pitch'
import type { DokokaraLine, DokokaraToken } from '@shared/types'

const BASE_PPS = 80 // 1倍ズームでの1秒あたりピクセル数
const MIN_ZOOM = 0.25
const MAX_ZOOM = 8
const RIBBON_HEIGHT = 110
const BLOCK_HEIGHT = 40
const BOUNDARY_HEIGHT = 36
const EDGE_GRAB_PX = 6
const MIN_LINE_DURATION = 0.05

export function mountEditorScreen(container: HTMLElement, ctx: AppContext): ScreenHandle {
  const root = el('div', { className: 'editor-screen' })
  container.appendChild(root)

  let disposed = false
  let dragCleanup: (() => void) | null = null
  // ドラッグ中はストア購読側の全体再描画をスキップする(ドラッグハンドラが自前で必要な再描画を行うため)。
  // これが無いとポインタ移動のたびに全ブロック/トークンDOMが再構築され、ドラッグ中のパフォーマンスが悪化する。
  let isDragging = false

  // ---------- ヘッダー ----------
  const header = el('div', { className: 'editor-header' })
  const backBtn = el('button', { className: 'btn btn-ghost' }, ['← ホームへ'])
  const title = el('h1', { className: 'editor-title' }, [ctx.editor.store.getState().project?.name ?? ''])
  const saveBtn = el('button', { className: 'btn btn-ghost' }, ['保存'])
  const performBtn = el('button', { className: 'btn btn-primary' }, ['本番へ →'])
  header.append(backBtn, title, saveBtn, performBtn)

  backBtn.addEventListener('click', async () => {
    if (!(await confirmDiscardIfDirty(ctx))) return
    ctx.navigate('home')
    await ctx.refreshHome()
  })
  saveBtn.addEventListener('click', () => void saveProject(ctx, false))
  performBtn.addEventListener('click', () => ctx.navigate('perform'))

  // ---------- ツールバー ----------
  const toolbar = el('div', { className: 'editor-toolbar' })
  const playBtn = el('button', { className: 'btn btn-ghost' }, ['▶'])
  const timeLabel = el('span', { className: 'mono editor-time' }, ['0:00.00'])
  const sourceSelect = el('select', { className: 'editor-select' }) as HTMLSelectElement
  sourceSelect.append(el('option', { value: 'playback' }, ['オフボーカル']), el('option', { value: 'analysis' }, ['オンボーカル']))
  const guidesBtn = el('button', { className: 'btn btn-ghost' }, ['ガイド'])
  const snapBtn = el('button', { className: 'btn btn-ghost' }, ['スナップ'])
  const zoomOutBtn = el('button', { className: 'btn btn-ghost' }, ['−'])
  const zoomFitBtn = el('button', { className: 'btn btn-ghost' }, ['全体表示'])
  const zoomInBtn = el('button', { className: 'btn btn-ghost' }, ['＋'])
  const addLineBtn = el('button', { className: 'btn btn-ghost' }, ['+ 行を追加'])
  const tapModeBtn = el('button', { className: 'btn btn-ghost' }, ['タップ入力'])
  const offsetLabel = el('span', { className: 'mono editor-offset' }, ['0ms'])
  const reallocateBtn = el('button', { className: 'btn btn-ghost' }, ['この行を再配分'])

  toolbar.append(
    playBtn,
    timeLabel,
    sourceSelect,
    guidesBtn,
    snapBtn,
    zoomOutBtn,
    zoomFitBtn,
    zoomInBtn,
    addLineBtn,
    tapModeBtn,
    reallocateBtn,
    el('span', { className: 'editor-toolbar-spacer' }, []),
    el('span', { className: 'mono' }, ['オフセット']),
    offsetLabel
  )

  // ---------- タイムライン(ピッチリボン・波形・ガイド・ブロック・境界バー) ----------
  const scrollArea = el('div', { className: 'editor-track-scroll' })
  const track = el('div', { className: 'editor-track' })
  const ribbonSvgWrap = el('div', { className: 'editor-ribbon' })
  const blocksLayer = el('div', { className: 'editor-blocks-layer' })
  const boundaryLayer = el('div', { className: 'editor-boundary-layer' })
  const playhead = el('div', { className: 'editor-playhead' })
  track.append(ribbonSvgWrap, blocksLayer, boundaryLayer, playhead)
  scrollArea.appendChild(track)

  // ---------- サイドパネル(選択行のテキスト編集) ----------
  const sidePanel = el('div', { className: 'editor-side-panel panel' })
  const sidePanelEmpty = el('p', { className: 'editor-side-empty' }, ['行を選択するとここで編集できます'])
  const textArea = el('textarea', { className: 'editor-text-input', rows: 3 }) as HTMLTextAreaElement
  const lineTimeRow = el('div', { className: 'editor-line-time-row mono' })
  sidePanel.append(sidePanelEmpty, textArea, lineTimeRow)
  textArea.style.display = 'none'

  root.append(header, toolbar, el('div', { className: 'editor-main' }, [scrollArea, sidePanel]))

  // ---------- 状態 ----------
  function state() {
    return ctx.editor.store.getState()
  }
  function settings() {
    return ctx.settings.getState()
  }

  function pps(): number {
    return BASE_PPS * state().zoom
  }
  function xForTime(t: number): number {
    return t * pps()
  }
  function timeForX(x: number): number {
    return Math.max(0, x / pps())
  }
  function totalDurationSec(): number {
    const a = state().audio
    return a.playbackBuffer?.duration ?? a.analysisBuffer?.duration ?? 0
  }
  function displayOffsetSec(): number {
    return (state().project?.playback.offsetMs ?? 0) / 1000
  }

  let textCommitTimer: ReturnType<typeof setTimeout> | null = null

  // ---------- ピッチリボン・波形・ガイド描画(zoomや音源が変わった時のみ再構築) ----------
  function renderRibbon(): void {
    clear(ribbonSvgWrap)
    const s = state()
    const width = Math.max(1, totalDurationSec() * pps())
    ribbonSvgWrap.style.width = `${width}px`
    ribbonSvgWrap.style.height = `${RIBBON_HEIGHT}px`

    const ns = 'http://www.w3.org/2000/svg'
    const svg = document.createElementNS(ns, 'svg')
    svg.setAttribute('width', String(width))
    svg.setAttribute('height', String(RIBBON_HEIGHT))
    svg.classList.add('editor-ribbon-svg')

    // 波形(背景、薄く)
    const buffer = s.audio.playbackBuffer ?? s.audio.analysisBuffer
    if (buffer) {
      const bucketCount = Math.max(1, Math.min(4000, Math.round(width / 2)))
      const peaks = buildWaveformPeaks(buffer, bucketCount)
      const bucketW = width / peaks.length
      let waveD = ''
      peaks.forEach((v, i) => {
        const h = Math.max(1, v * RIBBON_HEIGHT * 0.9)
        const x = i * bucketW
        const y = (RIBBON_HEIGHT - h) / 2
        waveD += `M${x.toFixed(1)},${y.toFixed(1)} v${h.toFixed(1)} `
      })
      const wavePath = document.createElementNS(ns, 'path')
      wavePath.setAttribute('d', waveD)
      wavePath.setAttribute('stroke', 'var(--color-text-weakest)')
      wavePath.setAttribute('stroke-width', String(Math.max(1, bucketW * 0.7)))
      wavePath.setAttribute('opacity', '0.35')
      svg.appendChild(wavePath)
    }

    // フレーズ・オンセットガイド
    if (s.showGuides) {
      const phrases = s.project?.analysis.phrases ?? []
      for (const p of phrases) {
        for (const t of [p.start, p.end]) {
          const line = document.createElementNS(ns, 'line')
          const x = xForTime(t)
          line.setAttribute('x1', String(x))
          line.setAttribute('x2', String(x))
          line.setAttribute('y1', '0')
          line.setAttribute('y2', String(RIBBON_HEIGHT))
          line.setAttribute('stroke', 'var(--color-text-weak)')
          line.setAttribute('stroke-width', '1')
          line.setAttribute('opacity', '0.3')
          svg.appendChild(line)
        }
      }
      const onsets = s.onsetsSec ?? new Float32Array(0)
      for (let i = 0; i < onsets.length; i++) {
        const line = document.createElementNS(ns, 'line')
        const x = xForTime(onsets[i])
        line.setAttribute('x1', String(x))
        line.setAttribute('x2', String(x))
        line.setAttribute('y1', '0')
        line.setAttribute('y2', String(RIBBON_HEIGHT))
        line.setAttribute('stroke', 'var(--color-accent-2)')
        line.setAttribute('stroke-width', '1')
        line.setAttribute('opacity', '0.18')
        svg.appendChild(line)
      }
    }

    // ピッチリボン(二層描画: 太いグロー + 細い明色線)
    const pitchHz = s.pitchHz
    const hopSec = s.project?.analysis.hopSec ?? 0.005
    if (pitchHz && pitchHz.length > 0) {
      const step = Math.max(1, Math.floor(1 / Math.max(1, pps() * hopSec)))
      const points: [number, number][] = []
      const yForHz = (hz: number): number => {
        const minHz = 70
        const maxHz = 1100
        const clamped = Math.min(maxHz, Math.max(minHz, hz))
        const frac = (Math.log2(clamped) - Math.log2(minHz)) / (Math.log2(maxHz) - Math.log2(minHz))
        return RIBBON_HEIGHT - 8 - frac * (RIBBON_HEIGHT - 16)
      }

      let d = ''
      let penDown = false
      for (let i = 0; i < pitchHz.length; i += step) {
        const hz = pitchHz[i]
        const t = i * hopSec
        if (hz <= 0) {
          penDown = false
          continue
        }
        const x = xForTime(t)
        const y = yForHz(hz)
        d += `${penDown ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)} `
        penDown = true
        points.push([x, y])
      }

      const glow = document.createElementNS(ns, 'path')
      glow.setAttribute('d', d)
      glow.setAttribute('fill', 'none')
      glow.setAttribute('stroke', 'var(--color-accent)')
      glow.setAttribute('stroke-width', '5')
      glow.setAttribute('opacity', '0.35')
      glow.setAttribute('stroke-linecap', 'round')
      svg.appendChild(glow)

      const thin = document.createElementNS(ns, 'path')
      thin.setAttribute('d', d)
      thin.setAttribute('fill', 'none')
      thin.setAttribute('stroke', '#FFE9A8')
      thin.setAttribute('stroke-width', '1.5')
      thin.setAttribute('stroke-linecap', 'round')
      svg.appendChild(thin)
    }

    ribbonSvgWrap.appendChild(svg)
  }

  // ---------- 歌詞ブロック描画 ----------
  function renderBlocks(): void {
    clear(blocksLayer)
    const s = state()
    const lines = s.project?.lyrics ?? []
    const width = Math.max(1, totalDurationSec() * pps())
    blocksLayer.style.width = `${width}px`
    blocksLayer.style.height = `${BLOCK_HEIGHT}px`

    lines.forEach((line, index) => {
      const selected = s.selection.lineId === line.id
      const blockEl = el('div', { className: `editor-block${selected ? ' selected' : ''}` }, [line.text || '(空)'])
      const x = xForTime(line.start)
      const w = Math.max(4, xForTime(line.end) - x)
      blockEl.style.left = `${x}px`
      blockEl.style.width = `${w}px`

      const leftHandle = el('div', { className: 'editor-block-handle left' })
      const rightHandle = el('div', { className: 'editor-block-handle right' })
      blockEl.append(leftHandle, rightHandle)

      blockEl.addEventListener('click', (e) => {
        e.stopPropagation()
        selectLine(line.id)
      })

      attachBlockPointerHandlers(blockEl, line, index, lines)

      blocksLayer.appendChild(blockEl)
    })
  }

  function attachBlockPointerHandlers(blockEl: HTMLElement, line: DokokaraLine, index: number, allLines: DokokaraLine[]): void {
    blockEl.addEventListener('pointerdown', (e) => {
      e.stopPropagation()
      const rect = blockEl.getBoundingClientRect()
      const offsetX = e.clientX - rect.left
      let mode: 'move' | 'resize-left' | 'resize-right' = 'move'
      if (offsetX <= EDGE_GRAB_PX) mode = 'resize-left'
      else if (offsetX >= rect.width - EDGE_GRAB_PX) mode = 'resize-right'

      selectLine(line.id)
      ctx.editor.beginChange()
      isDragging = true

      const startClientX = e.clientX
      const origStart = line.start
      const origEnd = line.end
      const prevLine = allLines[index - 1] ?? null
      const nextLine = allLines[index + 1] ?? null
      const staticTargets = buildSnapTargets(index, allLines)

      const onMove = (ev: PointerEvent): void => {
        const deltaSec = (ev.clientX - startClientX) / pps()

        if (mode === 'move') {
          let newStart = snapCandidate(origStart + deltaSec, staticTargets, ev.altKey)
          let newEnd = newStart + (origEnd - origStart)
          const minStart = prevLine ? prevLine.end : 0
          const maxEnd = nextLine ? nextLine.start : Infinity
          if (newStart < minStart) {
            newStart = minStart
            newEnd = newStart + (origEnd - origStart)
          }
          if (newEnd > maxEnd) {
            newEnd = maxEnd
            newStart = newEnd - (origEnd - origStart)
          }
          updateLineTiming(line.id, newStart, newEnd, false)
        } else if (mode === 'resize-left') {
          let newStart = snapCandidate(origStart + deltaSec, staticTargets, ev.altKey)
          const minStart = prevLine ? prevLine.end : 0
          newStart = Math.max(minStart, Math.min(newStart, origEnd - MIN_LINE_DURATION))
          updateLineTiming(line.id, newStart, origEnd, true)
        } else {
          let newEnd = snapCandidate(origEnd + deltaSec, staticTargets, ev.altKey)
          const maxEnd = nextLine ? nextLine.start : Infinity
          newEnd = Math.min(maxEnd, Math.max(newEnd, origStart + MIN_LINE_DURATION))
          updateLineTiming(line.id, origStart, newEnd, true)
        }
      }
      const onUp = (): void => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        ctx.editor.commitChange()
        isDragging = false
        dragCleanup = null
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      dragCleanup = onUp
    })
  }

  /** ドラッグ中の候補時刻をスナップ候補へ吸着させる。0.1秒グリッドは候補値ごとに動的に算出する(§4.7.3優先度5)。 */
  function snapCandidate(candidateTime: number, staticTargets: SnapTarget[], altKeyHeld: boolean): number {
    if (!state().snapEnabled || altKeyHeld) return candidateTime
    const targets = [...staticTargets, { time: nearestGridTime(candidateTime), priority: SNAP_PRIORITY.grid }]
    return snapTime(candidateTime, targets, pps(), settings().snapDistancePx)
  }

  function buildSnapTargets(excludeIndex: number, allLines: DokokaraLine[]): SnapTarget[] {
    const s = state()
    const targets: SnapTarget[] = [{ time: playheadDisplaySec(), priority: SNAP_PRIORITY.playhead }]
    allLines.forEach((l, i) => {
      if (i === excludeIndex) return
      targets.push({ time: l.start, priority: SNAP_PRIORITY.adjacentBlockEdge })
      targets.push({ time: l.end, priority: SNAP_PRIORITY.adjacentBlockEdge })
    })
    for (const p of s.project?.analysis.phrases ?? []) {
      targets.push({ time: p.start, priority: SNAP_PRIORITY.phraseBoundary })
      targets.push({ time: p.end, priority: SNAP_PRIORITY.phraseBoundary })
    }
    const onsets = s.onsetsSec ?? new Float32Array(0)
    for (let i = 0; i < onsets.length; i++) targets.push({ time: onsets[i], priority: SNAP_PRIORITY.onset })
    return targets
  }

  function updateLineTiming(lineId: string, newStart: number, newEnd: number, rescale: boolean): void {
    ctx.editor.applyTransient((lyrics) =>
      lyrics.map((l) => {
        if (l.id !== lineId) return l
        const tokens = rescale ? rescaleTokensExcludingLocked(l.tokens, newStart, newEnd) : shiftTokens(l.tokens, newStart - l.start)
        return { ...l, start: newStart, end: newEnd, tokens }
      })
    )
    renderBlocks()
    if (state().selection.lineId === lineId) renderBoundary()
  }

  function shiftTokens(tokens: DokokaraToken[], deltaSec: number): DokokaraToken[] {
    return tokens.map((t) => ({ ...t, start: t.start + deltaSec, end: t.end + deltaSec }))
  }

  // ---------- 文字境界バー(選択行のみ) ----------
  function renderBoundary(): void {
    clear(boundaryLayer)
    const s = state()
    const line = (s.project?.lyrics ?? []).find((l) => l.id === s.selection.lineId)
    if (!line) {
      boundaryLayer.style.display = 'none'
      return
    }
    boundaryLayer.style.display = 'block'
    const width = Math.max(1, totalDurationSec() * pps())
    boundaryLayer.style.width = `${width}px`
    boundaryLayer.style.height = `${BOUNDARY_HEIGHT}px`
    boundaryLayer.style.left = '0px'

    line.tokens.forEach((token, i) => {
      const x = xForTime(token.start)
      const w = Math.max(2, xForTime(token.end) - x)
      const tokenEl = el('div', { className: `editor-token${token.locked ? ' locked' : ''}` }, [token.text])
      tokenEl.style.left = `${x}px`
      tokenEl.style.width = `${w}px`
      tokenEl.addEventListener('contextmenu', (e) => {
        e.preventDefault()
        showTokenMenu(e.clientX, e.clientY, line, i)
      })
      boundaryLayer.appendChild(tokenEl)

      if (i < line.tokens.length - 1) {
        const divider = el('div', { className: 'editor-token-divider' })
        divider.style.left = `${xForTime(token.end)}px`
        attachDividerDrag(divider, line, i)
        boundaryLayer.appendChild(divider)
      }
    })
  }

  function attachDividerDrag(divider: HTMLElement, line: DokokaraLine, tokenIndex: number): void {
    divider.addEventListener('pointerdown', (e) => {
      e.stopPropagation()
      ctx.editor.beginChange()
      isDragging = true
      const left = line.tokens[tokenIndex]
      const right = line.tokens[tokenIndex + 1]
      const origBoundary = left.end
      const startClientX = e.clientX

      // §4.7.3: 文字境界バーのドラッグにも同じスナップ機構を適用する(隣接ブロック端を除く)
      const s = state()
      const staticTargets: SnapTarget[] = [{ time: playheadDisplaySec(), priority: SNAP_PRIORITY.playhead }]
      for (const p of s.project?.analysis.phrases ?? []) {
        staticTargets.push({ time: p.start, priority: SNAP_PRIORITY.phraseBoundary })
        staticTargets.push({ time: p.end, priority: SNAP_PRIORITY.phraseBoundary })
      }
      const onsets = s.onsetsSec ?? new Float32Array(0)
      for (let i = 0; i < onsets.length; i++) staticTargets.push({ time: onsets[i], priority: SNAP_PRIORITY.onset })

      const onMove = (ev: PointerEvent): void => {
        const deltaSec = (ev.clientX - startClientX) / pps()
        let newBoundary = snapCandidate(origBoundary + deltaSec, staticTargets, ev.altKey)
        newBoundary = Math.max(left.start + 0.01, Math.min(newBoundary, right.end - 0.01))

        ctx.editor.applyTransient((lyrics) =>
          lyrics.map((l) => {
            if (l.id !== line.id) return l
            const tokens = l.tokens.map((t, i) => {
              if (i === tokenIndex) return { ...t, end: newBoundary }
              if (i === tokenIndex + 1) return { ...t, start: newBoundary }
              return t
            })
            return { ...l, tokens }
          })
        )
        renderBoundary()
      }
      const onUp = (): void => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        ctx.editor.commitChange()
        isDragging = false
        dragCleanup = null
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      dragCleanup = onUp
    })
  }

  // ---------- トークン右クリックメニュー ----------
  let openMenu: HTMLElement | null = null
  function closeTokenMenu(): void {
    openMenu?.remove()
    openMenu = null
  }
  function showTokenMenu(clientX: number, clientY: number, line: DokokaraLine, tokenIndex: number): void {
    closeTokenMenu()
    const menu = el('div', { className: 'editor-token-menu panel-2' })
    menu.style.left = `${clientX}px`
    menu.style.top = `${clientY}px`

    if (tokenIndex > 0) {
      const mergeItem = el('div', { className: 'editor-token-menu-item' }, ['前と結合'])
      mergeItem.addEventListener('click', () => {
        mergeTokenWithPrev(line.id, tokenIndex)
        closeTokenMenu()
      })
      menu.appendChild(mergeItem)
    }
    const splitItem = el('div', { className: 'editor-token-menu-item' }, ['ここで分割'])
    splitItem.addEventListener('click', () => {
      splitToken(line.id, tokenIndex)
      closeTokenMenu()
    })
    menu.appendChild(splitItem)

    const lockItem = el('div', { className: 'editor-token-menu-item' }, [line.tokens[tokenIndex].locked ? 'ロック解除' : 'ロック'])
    lockItem.addEventListener('click', () => {
      toggleTokenLock(line.id, tokenIndex)
      closeTokenMenu()
    })
    menu.appendChild(lockItem)

    document.body.appendChild(menu)
    openMenu = menu
    window.setTimeout(() => window.addEventListener('pointerdown', closeTokenMenu, { once: true }), 0)
  }

  /** トークンを2つに分割する。1文字以上あれば先頭1文字/残りに分け、1文字のみなら時間を等分する(ルビは失われる)。 */
  function splitToken(lineId: string, tokenIndex: number): void {
    ctx.editor.applyAndCommit((lyrics) =>
      lyrics.map((l) => {
        if (l.id !== lineId) return l
        const t = l.tokens[tokenIndex]
        const mid = (t.start + t.end) / 2
        const chars = Array.from(t.text)
        const a: DokokaraToken =
          chars.length > 1
            ? { text: chars[0], ruby: null, start: t.start, end: mid, locked: false }
            : { text: t.text, ruby: null, start: t.start, end: mid, locked: false }
        const b: DokokaraToken =
          chars.length > 1
            ? { text: chars.slice(1).join(''), ruby: null, start: mid, end: t.end, locked: false }
            : { text: t.text, ruby: null, start: mid, end: t.end, locked: false }
        const tokens = l.tokens.slice()
        tokens.splice(tokenIndex, 1, a, b)
        return { ...l, tokens }
      })
    )
    renderBoundary()
  }

  function mergeTokenWithPrev(lineId: string, tokenIndex: number): void {
    if (tokenIndex <= 0) return
    ctx.editor.applyAndCommit((lyrics) =>
      lyrics.map((l) => {
        if (l.id !== lineId) return l
        const tokens = l.tokens.slice()
        const prev = tokens[tokenIndex - 1]
        const cur = tokens[tokenIndex]
        const merged: DokokaraToken = {
          text: prev.text + cur.text,
          ruby: prev.ruby && cur.ruby ? prev.ruby + cur.ruby : (prev.ruby ?? cur.ruby),
          start: prev.start,
          end: cur.end,
          locked: prev.locked || cur.locked
        }
        tokens.splice(tokenIndex - 1, 2, merged)
        return { ...l, tokens }
      })
    )
    renderBoundary()
  }

  function toggleTokenLock(lineId: string, tokenIndex: number): void {
    ctx.editor.applyAndCommit((lyrics) =>
      lyrics.map((l) => {
        if (l.id !== lineId) return l
        const tokens = l.tokens.map((t, i) => (i === tokenIndex ? { ...t, locked: !t.locked } : t))
        return { ...l, tokens }
      })
    )
    renderBoundary()
  }

  // ---------- 行選択・追加・削除・分割・結合 ----------
  function selectLine(lineId: string | null): void {
    ctx.editor.store.setState({ selection: { lineId, tokenIndex: null } })
    renderBlocks()
    renderBoundary()
    renderSidePanel()
  }

  function renderSidePanel(): void {
    const s = state()
    const line = (s.project?.lyrics ?? []).find((l) => l.id === s.selection.lineId)
    if (!line) {
      sidePanelEmpty.style.display = 'block'
      textArea.style.display = 'none'
      lineTimeRow.textContent = ''
      return
    }
    sidePanelEmpty.style.display = 'none'
    textArea.style.display = 'block'
    if (document.activeElement !== textArea) textArea.value = line.text
    lineTimeRow.textContent = `${formatTime(line.start)} 〜 ${formatTime(line.end)}`
  }

  textArea.addEventListener('input', () => {
    const s = state()
    const lineId = s.selection.lineId
    if (!lineId) return
    if (textCommitTimer) clearTimeout(textCommitTimer)
    textCommitTimer = setTimeout(() => commitTextEdit(lineId, textArea.value), 500)
  })

  function commitTextEdit(lineId: string, newText: string): void {
    const s = state()
    const line = (s.project?.lyrics ?? []).find((l) => l.id === lineId)
    if (!line) return
    const tokens = tokenizeLine(newText)
    const onsetsSec = Array.from(s.onsetsSec ?? [])
    const pitchChangePoints = computePitchChangePoints()
    const timed = allocateTokenTimings(tokens, line.start, line.end, { onsetsSec, pitchChangePoints })
    ctx.editor.applyAndCommit((lyrics) =>
      lyrics.map((l) =>
        l.id === lineId
          ? { ...l, text: newText, tokens: timed.map((t) => ({ text: t.text, ruby: t.ruby, start: t.start, end: t.end, locked: false })) }
          : l
      )
    )
    renderBlocks()
    renderBoundary()
  }

  function computePitchChangePoints(): number[] {
    const s = state()
    if (!s.pitchHz) return []
    const hopSec = s.project?.analysis.hopSec ?? 0.005
    const frames = Array.from(s.pitchHz).map((hz, i) => ({ timeSec: i * hopSec, hz, voiced: hz > 0 }))
    return findPitchChangePoints(frames)
  }

  reallocateBtn.addEventListener('click', () => {
    const s = state()
    const line = (s.project?.lyrics ?? []).find((l) => l.id === s.selection.lineId)
    if (!line) return
    const onsetsSec = Array.from(s.onsetsSec ?? [])
    const pitchChangePoints = computePitchChangePoints()
    const newTokens = reallocateRespectingLocks(line.tokens, line.start, line.end, onsetsSec, pitchChangePoints)
    ctx.editor.applyAndCommit((lyrics) => lyrics.map((l) => (l.id === line.id ? { ...l, tokens: newTokens } : l)))
    renderBoundary()
  })

  addLineBtn.addEventListener('click', () => {
    const playheadT = playheadDisplaySec()
    const newLine: DokokaraLine = {
      id: generateLineId(),
      text: '新しい行',
      start: playheadT,
      end: playheadT + 1,
      tokens: [{ text: '新しい行', ruby: null, start: playheadT, end: playheadT + 1, locked: false }]
    }
    ctx.editor.applyAndCommit((lyrics) => [...lyrics, newLine].sort((a, b) => a.start - b.start))
    selectLine(newLine.id)
    renderBlocks()
  })

  function deleteSelectedLine(): void {
    const s = state()
    const lineId = s.selection.lineId
    if (!lineId) return
    ctx.editor.applyAndCommit((lyrics) => lyrics.filter((l) => l.id !== lineId))
    selectLine(null)
    renderBlocks()
  }

  function mergeSelectedWithNext(): void {
    const s = state()
    const lines = s.project?.lyrics ?? []
    const idx = lines.findIndex((l) => l.id === s.selection.lineId)
    if (idx === -1 || idx >= lines.length - 1) return
    const cur = lines[idx]
    const next = lines[idx + 1]
    const merged: DokokaraLine = {
      id: cur.id,
      text: `${cur.text}${next.text}`,
      start: cur.start,
      end: next.end,
      tokens: [...cur.tokens, ...next.tokens]
    }
    ctx.editor.applyAndCommit((lyrics) => {
      const copy = lyrics.slice()
      copy.splice(idx, 2, merged)
      return copy
    })
    selectLine(merged.id)
    renderBlocks()
    renderBoundary()
  }

  function splitSelectedAtPlayhead(): void {
    const s = state()
    const lines = s.project?.lyrics ?? []
    const idx = lines.findIndex((l) => l.id === s.selection.lineId)
    if (idx === -1) return
    const line = lines[idx]
    const t = playheadDisplaySec()
    if (t <= line.start || t >= line.end) return

    const splitTokenIdx = line.tokens.findIndex((tk) => tk.start >= t)
    const cut = splitTokenIdx === -1 ? line.tokens.length : Math.max(1, splitTokenIdx)
    const leftTokens = line.tokens.slice(0, cut)
    const rightTokens = line.tokens.slice(cut)
    if (leftTokens.length === 0 || rightTokens.length === 0) return

    const leftLine: DokokaraLine = {
      id: line.id,
      text: leftTokens.map((tk) => tk.text).join(''),
      start: line.start,
      end: leftTokens[leftTokens.length - 1].end,
      tokens: leftTokens
    }
    const rightLine: DokokaraLine = {
      id: generateLineId(),
      text: rightTokens.map((tk) => tk.text).join(''),
      start: rightTokens[0].start,
      end: line.end,
      tokens: rightTokens
    }
    ctx.editor.applyAndCommit((lyrics) => {
      const copy = lyrics.slice()
      copy.splice(idx, 1, leftLine, rightLine)
      return copy
    })
    renderBlocks()
    renderBoundary()
  }

  function generateLineId(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
    return `line-${Date.now()}-${Math.random().toString(36).slice(2)}`
  }

  // ---------- 再生・シーク・プレイヘッド ----------
  function playheadDisplaySec(): number {
    // §4.11: オフセットは表示系のみに適用する。正の値は表示を遅らせる方向。
    return Math.max(0, ctx.playback.getCurrentTime() - displayOffsetSec())
  }

  function updatePlayheadDom(): void {
    const t = playheadDisplaySec()
    playhead.style.transform = `translateX(${xForTime(t)}px)`
    timeLabel.textContent = formatTime(t)
    autoScrollToPlayhead(t)
  }

  function autoScrollToPlayhead(t: number): void {
    const x = xForTime(t)
    const viewLeft = scrollArea.scrollLeft
    const viewRight = viewLeft + scrollArea.clientWidth
    if (x < viewLeft + 40) scrollArea.scrollLeft = Math.max(0, x - 40)
    else if (x > viewRight - 40) scrollArea.scrollLeft = x - scrollArea.clientWidth + 40
  }

  let rafId: number | null = null
  function tick(): void {
    if (disposed) return
    updatePlayheadDom()
    rafId = requestAnimationFrame(tick)
  }
  rafId = requestAnimationFrame(tick)

  function togglePlay(): void {
    if (ctx.playback.isPlaying()) {
      ctx.playback.pause()
      playBtn.textContent = '▶'
    } else {
      ctx.playback.play()
      playBtn.textContent = '⏸'
    }
  }
  playBtn.addEventListener('click', togglePlay)

  function seekBy(deltaSec: number): void {
    ctx.playback.seek(Math.max(0, ctx.playback.getCurrentTime() + deltaSec))
    updatePlayheadDom()
  }

  // blocksLayer/boundaryLayerはCSSでpointer-events:noneにしてあり、実際に操作可能な子要素
  // (block/token/divider)のみpointer-events:autoなので、それ以外の背景クリックはここに落ちてくる。
  scrollArea.addEventListener('click', (e) => {
    const rect = track.getBoundingClientRect()
    const x = e.clientX - rect.left
    const t = timeForX(x) + displayOffsetSec()
    ctx.playback.seek(Math.max(0, t))
    updatePlayheadDom()
    selectLine(null)
  })

  // ---------- ソース切替 ----------
  sourceSelect.value = state().playSource
  sourceSelect.addEventListener('change', () => {
    const src = sourceSelect.value as 'playback' | 'analysis'
    ctx.editor.store.setState({ playSource: src })
    const s = state()
    ctx.playback.setBuffer(src === 'analysis' ? s.audio.analysisBuffer : s.audio.playbackBuffer ?? s.audio.analysisBuffer)
  })

  // ---------- ガイド・スナップ切替 ----------
  function syncToggleButtons(): void {
    guidesBtn.classList.toggle('active', state().showGuides)
    snapBtn.classList.toggle('active', state().snapEnabled)
    tapModeBtn.classList.toggle('active', state().tapMode)
  }
  guidesBtn.addEventListener('click', () => {
    ctx.editor.store.setState({ showGuides: !state().showGuides })
    syncToggleButtons()
    renderRibbon()
  })
  snapBtn.addEventListener('click', () => {
    ctx.editor.store.setState({ snapEnabled: !state().snapEnabled })
    syncToggleButtons()
  })
  tapModeBtn.addEventListener('click', () => {
    ctx.editor.store.setState({ tapMode: !state().tapMode })
    syncToggleButtons()
  })
  syncToggleButtons()

  // ---------- ズーム ----------
  function setZoom(z: number): void {
    const clamped = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z))
    ctx.editor.store.setState({ zoom: clamped })
    renderRibbon()
    renderBlocks()
    renderBoundary()
  }
  zoomInBtn.addEventListener('click', () => setZoom(state().zoom * 1.5))
  zoomOutBtn.addEventListener('click', () => setZoom(state().zoom / 1.5))
  zoomFitBtn.addEventListener('click', () => {
    const duration = totalDurationSec()
    if (duration <= 0) return
    setZoom(scrollArea.clientWidth / (BASE_PPS * duration))
  })

  // ---------- オフセット調整(§4.11) ----------
  function adjustOffset(deltaMs: number): void {
    const s = state()
    if (!s.project) return
    const newOffsetMs = s.project.playback.offsetMs + deltaMs
    ctx.editor.store.setState({ project: { ...s.project, playback: { ...s.project.playback, offsetMs: newOffsetMs } } })
    offsetLabel.textContent = `${newOffsetMs}ms`
  }
  offsetLabel.textContent = `${state().project?.playback.offsetMs ?? 0}ms`

  // ---------- タップ入力(§4.6.5) ----------
  function tapConfirmNext(): void {
    const s = state()
    const lines = s.project?.lyrics ?? []
    const line = lines.find((l) => l.id === s.selection.lineId)
    if (!line) return
    // 選択中のトークン番号(§4.6.5)。未設定なら先頭トークンから開始する。
    const target = s.selection.tokenIndex ?? 0
    if (target >= line.tokens.length) return
    const t = playheadDisplaySec()
    ctx.editor.applyAndCommit((lyrics) =>
      lyrics.map((l) => {
        if (l.id !== line.id) return l
        const tokens = l.tokens.map((tk, i) => {
          if (i === target - 1) return { ...tk, end: t }
          if (i === target) return { ...tk, start: t }
          return tk
        })
        return { ...l, tokens }
      })
    )
    if (target + 1 >= line.tokens.length) {
      // 行の最後のトークンを確定したので次の行へ自動的に移る(§4.6.5)
      const lineIdx = lines.findIndex((l) => l.id === line.id)
      const nextLine = lines[lineIdx + 1]
      if (nextLine) {
        selectLine(nextLine.id)
        ctx.editor.store.setState({ selection: { lineId: nextLine.id, tokenIndex: 0 } })
        return
      }
    }
    ctx.editor.store.setState({ selection: { lineId: line.id, tokenIndex: target + 1 } })
    renderBoundary()
  }
  function tapBack(): void {
    const s = state()
    const idx = s.selection.tokenIndex ?? 0
    ctx.editor.store.setState({ selection: { lineId: s.selection.lineId, tokenIndex: Math.max(0, idx - 1) } })
  }

  // ---------- キーボードショートカット(§4.9) ----------
  function isEditableTarget(target: EventTarget | null): boolean {
    const el = target as HTMLElement | null
    return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (isEditableTarget(e.target)) {
      if (e.key === 'Escape') (e.target as HTMLElement).blur()
      return
    }
    const s = state()
    const meta = e.metaKey || e.ctrlKey

    if (e.code === 'Space') {
      e.preventDefault()
      togglePlay()
      return
    }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault()
      const step = e.shiftKey ? settings().bigSeekStepSec : settings().seekStepSec
      seekBy(e.key === 'ArrowLeft' ? -step : step)
      return
    }
    if (e.key === 'Home') {
      e.preventDefault()
      ctx.playback.seek(0)
      updatePlayheadDom()
      return
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault()
      const lines = s.project?.lyrics ?? []
      const idx = lines.findIndex((l) => l.id === s.selection.lineId)
      const nextIdx = e.key === 'ArrowUp' ? Math.max(0, idx - 1) : Math.min(lines.length - 1, idx + 1)
      if (lines[nextIdx]) selectLine(lines[nextIdx].id)
      return
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      deleteSelectedLine()
      return
    }
    if (e.key === 'Escape') {
      selectLine(null)
      return
    }
    if (e.key === 'Return' || e.key === 'Enter') {
      if (s.selection.lineId) textArea.focus()
      return
    }
    if (e.key.toLowerCase() === 'i' && s.selection.lineId) {
      const t = playheadDisplaySec()
      ctx.editor.applyAndCommit((lyrics) => lyrics.map((l) => (l.id === s.selection.lineId ? { ...l, start: t } : l)))
      renderBlocks()
      return
    }
    if (e.key.toLowerCase() === 'o' && s.selection.lineId) {
      const t = playheadDisplaySec()
      ctx.editor.applyAndCommit((lyrics) => lyrics.map((l) => (l.id === s.selection.lineId ? { ...l, end: t } : l)))
      renderBlocks()
      return
    }
    if (e.key.toLowerCase() === 't' && s.tapMode) {
      e.preventDefault()
      if (e.shiftKey) tapBack()
      else tapConfirmNext()
      return
    }
    if (meta && e.key.toLowerCase() === 'k') {
      e.preventDefault()
      splitSelectedAtPlayhead()
      return
    }
    if (meta && e.key.toLowerCase() === 'j') {
      e.preventDefault()
      mergeSelectedWithNext()
      return
    }
    if (meta && !e.shiftKey && e.key.toLowerCase() === 'z') {
      e.preventDefault()
      ctx.editor.undo()
      renderAll()
      return
    }
    if (meta && e.shiftKey && e.key.toLowerCase() === 'z') {
      e.preventDefault()
      ctx.editor.redo()
      renderAll()
      return
    }
    if (meta && e.key === 'Enter') {
      e.preventDefault()
      ctx.navigate('perform')
      return
    }
    if (e.key === '+' || e.key === '=') {
      setZoom(state().zoom * 1.5)
      return
    }
    if (e.key === '-') {
      setZoom(state().zoom / 1.5)
      return
    }
    if (e.key === '0') {
      zoomFitBtn.click()
      return
    }
    if (e.key === ';') {
      adjustOffset(e.shiftKey ? -50 : -5)
      return
    }
    if (e.key === "'") {
      adjustOffset(e.shiftKey ? 50 : 5)
      return
    }
  }
  document.addEventListener('keydown', onKeyDown)

  // ---------- 全体再描画 ----------
  function renderAll(): void {
    title.textContent = state().project?.name ?? ''
    renderRibbon()
    renderBlocks()
    renderBoundary()
    renderSidePanel()
  }
  renderAll()

  const unsubEditor = ctx.editor.store.subscribe((s) => {
    if (disposed || isDragging) return
    title.textContent = s.project?.name ?? ''
    renderBlocks()
    renderBoundary()
    renderSidePanel()
  })

  return {
    unmount() {
      disposed = true
      if (rafId !== null) cancelAnimationFrame(rafId)
      document.removeEventListener('keydown', onKeyDown)
      dragCleanup?.()
      closeTokenMenu()
      unsubEditor()
      container.removeChild(root)
    }
  }
}
