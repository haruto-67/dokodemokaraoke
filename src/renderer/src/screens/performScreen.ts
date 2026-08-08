import type { AppContext } from '../appContext'
import type { ScreenHandle } from '../lib/screen'
import { el, clear, formatTime } from '../lib/dom'
import type { DokokaraLine, DokokaraToken } from '@shared/types'

const INTERLUDE_THRESHOLD_SEC = 4
const CONTROLS_FADE_MS = 2500
const PITCH_STRIP_HEIGHT = 90
const PITCH_STRIP_MARKER_FRACTION = 0.2

/**
 * 本番(カラオケ再生)画面(§3 画面 #4, §4.10)。
 * 文字送り・ルビ表示・ピッチガイド・カウントイン/間奏カウントダウン・オフセット調整を実装する。
 */
export function mountPerformScreen(container: HTMLElement, ctx: AppContext): ScreenHandle {
  const root = el('div', { className: 'perform-screen' })
  container.appendChild(root)

  let disposed = false

  // ---------- 進捗バー ----------
  const progressBar = el('div', { className: 'perform-progress' })
  const progressFill = el('div', { className: 'perform-progress-fill' })
  progressBar.appendChild(progressFill)

  // ---------- ピッチガイド ----------
  const pitchStripWrap = el('div', { className: 'perform-pitch-strip' })
  const pitchStripInner = el('div', { className: 'perform-pitch-strip-inner' })
  const pitchMarker = el('div', { className: 'perform-pitch-marker' })
  pitchStripWrap.append(pitchStripInner, pitchMarker)

  // ---------- 歌詞表示 ----------
  const lyricsArea = el('div', { className: 'perform-lyrics' })
  const prevLineEl = el('div', { className: 'perform-line perform-line-adjacent' })
  const currentLineEl = el('div', { className: 'perform-line perform-line-current' })
  const nextLineEl = el('div', { className: 'perform-line perform-line-adjacent' })
  lyricsArea.append(prevLineEl, currentLineEl, nextLineEl)

  // ---------- カウントダウン ----------
  const countdownEl = el('div', { className: 'perform-countdown' })

  // ---------- コントロール ----------
  const controls = el('div', { className: 'perform-controls' })
  const backBtn = el('button', { className: 'btn btn-ghost' }, ['← 編集へ戻る'])
  const playBtn = el('button', { className: 'btn btn-ghost' }, ['▶'])
  const restartBtn = el('button', { className: 'btn btn-ghost' }, ['⏮ 最初から'])
  const sourceSelect = el('select', { className: 'editor-select' }) as HTMLSelectElement
  sourceSelect.append(el('option', { value: 'playback' }, ['オフボーカル']), el('option', { value: 'analysis' }, ['オンボーカル']))
  const fullscreenBtn = el('button', { className: 'btn btn-ghost' }, ['⛶ フルスクリーン'])
  const timeLabel = el('span', { className: 'mono perform-time' }, ['0:00.00'])
  controls.append(backBtn, playBtn, restartBtn, sourceSelect, fullscreenBtn, timeLabel)

  const offsetIndicator = el('div', { className: 'perform-offset-indicator' })

  root.append(progressBar, pitchStripWrap, lyricsArea, countdownEl, controls, offsetIndicator)

  // ---------- 状態ヘルパー ----------
  function state() {
    return ctx.editor.store.getState()
  }
  function lines(): DokokaraLine[] {
    return state().project?.lyrics ?? []
  }
  function displayOffsetSec(): number {
    return (state().project?.playback.offsetMs ?? 0) / 1000
  }
  function playheadDisplaySec(): number {
    return Math.max(0, ctx.playback.getCurrentTime() - displayOffsetSec())
  }
  function totalDurationSec(): number {
    return ctx.playback.duration
  }

  // ---------- ナビゲーション・再生操作 ----------
  backBtn.addEventListener('click', () => ctx.navigate('editor'))
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
  restartBtn.addEventListener('click', () => {
    ctx.playback.seek(0)
    ctx.playback.play()
    playBtn.textContent = '⏸'
  })

  sourceSelect.value = state().playSource
  sourceSelect.addEventListener('change', () => {
    const src = sourceSelect.value as 'playback' | 'analysis'
    ctx.editor.store.setState({ playSource: src })
    const s = state()
    ctx.playback.setBuffer(src === 'analysis' ? s.audio.analysisBuffer : s.audio.playbackBuffer ?? s.audio.analysisBuffer)
  })

  function toggleFullscreen(): void {
    if (!document.fullscreenElement) void root.requestFullscreen().catch(() => undefined)
    else void document.exitFullscreen().catch(() => undefined)
  }
  fullscreenBtn.addEventListener('click', toggleFullscreen)

  // ---------- オフセット調整(§4.11) ----------
  let offsetIndicatorTimer: ReturnType<typeof setTimeout> | null = null
  function adjustOffset(deltaMs: number): void {
    const s = state()
    if (!s.project) return
    const newOffsetMs = s.project.playback.offsetMs + deltaMs
    ctx.editor.store.setState({ project: { ...s.project, playback: { ...s.project.playback, offsetMs: newOffsetMs } } })
    offsetIndicator.textContent = `オフセット ${newOffsetMs}ms`
    offsetIndicator.classList.add('visible')
    if (offsetIndicatorTimer) clearTimeout(offsetIndicatorTimer)
    offsetIndicatorTimer = setTimeout(() => offsetIndicator.classList.remove('visible'), 1200)
  }

  // ---------- 文字送り(§4.6.6)付きの行DOMを構築 ----------
  function buildLineTokenDom(token: DokokaraToken): HTMLElement {
    const wrap = el('span', { className: 'perform-token' })
    if (token.ruby) {
      const rubyWrap = el('span', { className: 'perform-token-ruby-wrap' })
      const rubyBase = el('span', { className: 'perform-token-ruby-base' }, [token.ruby])
      const rubyFill = el('span', { className: 'perform-token-ruby-fill' }, [token.ruby])
      rubyWrap.append(rubyBase, rubyFill)
      wrap.appendChild(rubyWrap)
    }
    const textWrap = el('span', { className: 'perform-token-text-wrap' })
    const textBase = el('span', { className: 'perform-token-text-base' }, [token.text])
    const textFill = el('span', { className: 'perform-token-text-fill' }, [token.text])
    textWrap.append(textBase, textFill)
    wrap.appendChild(textWrap)
    return wrap
  }

  let currentLineId: string | null = 'uninitialized'
  function renderLines(): void {
    const all = lines()
    const t = playheadDisplaySec()
    const idx = all.findIndex((l) => t >= l.start && t < l.end)
    const activeIdx = idx !== -1 ? idx : all.findIndex((l) => l.start > t)
    const current = idx !== -1 ? all[idx] : null
    const prev = idx !== -1 ? all[idx - 1] : activeIdx > 0 ? all[activeIdx - 1] : null
    const next = idx !== -1 ? all[idx + 1] : activeIdx !== -1 ? all[activeIdx] : null

    if (current?.id !== currentLineId) {
      currentLineId = current?.id ?? null
      clear(currentLineEl)
      if (current) current.tokens.forEach((tk) => currentLineEl.appendChild(buildLineTokenDom(tk)))
      prevLineEl.textContent = prev?.text ?? ''
      nextLineEl.textContent = next?.text ?? ''
    }

    if (current) updateTokenFill(current, t)
  }

  function updateTokenFill(line: DokokaraLine, t: number): void {
    line.tokens.forEach((tk, i) => {
      const progress = tk.end > tk.start ? Math.min(1, Math.max(0, (t - tk.start) / (tk.end - tk.start))) : t >= tk.end ? 1 : 0
      const pct = `${(progress * 100).toFixed(1)}%`
      const tokenEl = currentLineEl.children[i] as HTMLElement | undefined
      if (!tokenEl) return
      const rubyFill = tokenEl.querySelector<HTMLElement>('.perform-token-ruby-fill')
      const bodyFill = tokenEl.querySelector<HTMLElement>('.perform-token-text-fill')
      if (rubyFill) rubyFill.style.width = pct
      if (bodyFill) bodyFill.style.width = pct
    })
  }

  // ---------- カウントイン・間奏カウントダウン ----------
  function renderCountdown(t: number): void {
    const all = lines()
    const settings = ctx.settings.getState()
    const currentIdx = all.findIndex((l) => t >= l.start && t < l.end)
    if (currentIdx !== -1) {
      countdownEl.textContent = ''
      countdownEl.classList.remove('visible')
      return
    }

    const nextIdx = all.findIndex((l) => l.start > t)
    if (nextIdx === -1) {
      countdownEl.textContent = ''
      countdownEl.classList.remove('visible')
      return
    }
    const next = all[nextIdx]
    const prevEnd = nextIdx > 0 ? all[nextIdx - 1].end : 0
    const isIntro = nextIdx === 0

    const gap = next.start - prevEnd
    const shouldCountdown = isIntro ? settings.countInEnabled : gap >= INTERLUDE_THRESHOLD_SEC
    if (!shouldCountdown) {
      countdownEl.textContent = ''
      countdownEl.classList.remove('visible')
      return
    }
    const remain = Math.max(0, next.start - t)
    countdownEl.textContent = String(Math.ceil(remain))
    countdownEl.classList.add('visible')
  }

  // ---------- ピッチガイド描画(初回のみ全体を構築し、以後はtransformでスクロール) ----------
  const PPS = 80
  function renderPitchStrip(): void {
    clear(pitchStripInner)
    const s = state()
    const pitchHz = s.pitchHz
    const hopSec = s.project?.analysis.hopSec ?? 0.005
    if (!pitchHz || pitchHz.length === 0) return

    const width = Math.max(1, totalDurationSec() * PPS)
    pitchStripInner.style.width = `${width}px`
    pitchStripInner.style.height = `${PITCH_STRIP_HEIGHT}px`

    const ns = 'http://www.w3.org/2000/svg'
    const svg = document.createElementNS(ns, 'svg')
    svg.setAttribute('width', String(width))
    svg.setAttribute('height', String(PITCH_STRIP_HEIGHT))

    const yForHz = (hz: number): number => {
      const minHz = 70
      const maxHz = 1100
      const clamped = Math.min(maxHz, Math.max(minHz, hz))
      const frac = (Math.log2(clamped) - Math.log2(minHz)) / (Math.log2(maxHz) - Math.log2(minHz))
      return PITCH_STRIP_HEIGHT - 8 - frac * (PITCH_STRIP_HEIGHT - 16)
    }
    const step = Math.max(1, Math.floor(1 / Math.max(1, PPS * hopSec)))
    let d = ''
    let penDown = false
    for (let i = 0; i < pitchHz.length; i += step) {
      const hz = pitchHz[i]
      if (hz <= 0) {
        penDown = false
        continue
      }
      const x = i * hopSec * PPS
      const y = yForHz(hz)
      d += `${penDown ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)} `
      penDown = true
    }
    const path = document.createElementNS(ns, 'path')
    path.setAttribute('d', d)
    path.setAttribute('fill', 'none')
    path.setAttribute('stroke', 'var(--color-accent)')
    path.setAttribute('stroke-width', '3')
    path.setAttribute('opacity', '0.85')
    path.setAttribute('stroke-linecap', 'round')
    svg.appendChild(path)
    pitchStripInner.appendChild(svg)
  }
  renderPitchStrip()

  function updatePitchStripScroll(t: number): void {
    const markerX = pitchStripWrap.clientWidth * PITCH_STRIP_MARKER_FRACTION
    pitchStripInner.style.transform = `translateX(${(markerX - t * PPS).toFixed(1)}px)`
    pitchMarker.style.left = `${markerX}px`
  }

  // ---------- メインループ ----------
  function tick(): void {
    if (disposed) return
    const t = playheadDisplaySec()
    timeLabel.textContent = formatTime(t)
    const duration = totalDurationSec()
    progressFill.style.width = duration > 0 ? `${Math.min(100, (t / duration) * 100)}%` : '0%'
    renderLines()
    renderCountdown(t)
    updatePitchStripScroll(t)
    rafId = requestAnimationFrame(tick)
  }
  let rafId: number | null = requestAnimationFrame(tick)

  // ---------- 操作UIの自動フェードアウト ----------
  let fadeTimer: ReturnType<typeof setTimeout> | null = null
  function showControls(): void {
    controls.classList.add('visible')
    if (fadeTimer) clearTimeout(fadeTimer)
    fadeTimer = setTimeout(() => controls.classList.remove('visible'), CONTROLS_FADE_MS)
  }
  root.addEventListener('mousemove', showControls)
  showControls()

  // ---------- キーボードショートカット ----------
  function onKeyDown(e: KeyboardEvent): void {
    if (e.code === 'Space') {
      e.preventDefault()
      togglePlay()
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      ctx.playback.seek(0)
      ctx.playback.play()
      playBtn.textContent = '⏸'
      return
    }
    if (e.key === 'Escape' && document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined)
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

  return {
    unmount() {
      disposed = true
      if (rafId !== null) cancelAnimationFrame(rafId)
      if (fadeTimer) clearTimeout(fadeTimer)
      if (offsetIndicatorTimer) clearTimeout(offsetIndicatorTimer)
      document.removeEventListener('keydown', onKeyDown)
      if (document.fullscreenElement === root) void document.exitFullscreen().catch(() => undefined)
      container.removeChild(root)
    }
  }
}
