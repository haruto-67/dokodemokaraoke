import type { AppContext } from '../appContext'
import type { ScreenHandle } from '../lib/screen'
import { el, clear, formatTime } from '../lib/dom'
import type { DokokaraLine, DokokaraToken, PlaySource } from '@shared/types'
import { scorePerformance, type SungPitchSample } from '@shared/analysis/scoring'
import { computeTokenPitchesMidi } from '@shared/analysis/tokenPitch'
import { parseRubyLine } from '@shared/ruby'
import { startMicPitchDetection, type MicPitchSession } from '../audio/micPitchInput'
import { bufferForSource, confirmDiscardIfDirty } from '../lib/projectActions'
import { scheduleCountInClicks, playKeyTone, computeStartCueSchedule, countInBeatForRemaining } from '../audio/performCues'

const INTERLUDE_THRESHOLD_SEC = 4
const CONTROLS_FADE_MS = 2500
const PITCH_STRIP_HEIGHT = 180
const PITCH_STRIP_MARKER_FRACTION = 0.2
/** マイク未許可等の通知を表示し続ける時間(ms)。オフセット表示と同じ演出を流用 */
const MIC_NOTICE_DURATION_MS = 4000

/** ピッチガイド(参照メロディ・歌唱ピッチ共通)のHz→縦位置変換 */
function hzToMidi(hz: number): number {
  return 69 + 12 * Math.log2(hz / 440)
}

function yForMidi(midi: number, minMidi: number, maxMidi: number): number {
  const clamped = Math.min(maxMidi, Math.max(minMidi, midi))
  const frac = (clamped - minMidi) / Math.max(1, maxMidi - minMidi)
  return PITCH_STRIP_HEIGHT - 8 - frac * (PITCH_STRIP_HEIGHT - 16)
}

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
  // 採点用: 歌唱ピッチのリアルタイム表示(§4.12.4)
  const livePitchDot = el('div', { className: 'perform-live-pitch-dot' })
  pitchStripWrap.append(pitchStripInner, pitchMarker, livePitchDot)

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
  const homeBtn = el('button', { className: 'btn btn-ghost' }, ['ホームへ'])
  const backBtn = el('button', { className: 'btn btn-ghost' }, ['← 編集へ戻る'])
  const playBtn = el('button', { className: 'btn btn-ghost' }, ['▶'])
  const restartBtn = el('button', { className: 'btn btn-ghost' }, ['⏮ 最初から'])
  const sourceSelect = el('select', { className: 'editor-select' }) as HTMLSelectElement
  sourceSelect.append(
    el('option', { value: 'playback' }, ['オフボーカル']),
    el('option', { value: 'original' }, ['オンボーカル']),
    el('option', { value: 'analysis' }, ['ボーカルのみ'])
  )
  const fullscreenBtn = el('button', { className: 'btn btn-ghost' }, ['⛶ フルスクリーン'])
  // ---------- キー変更(移調、§4.12) ----------
  const keyDownBtn = el('button', { className: 'btn btn-ghost' }, ['キー♭'])
  const keyLabel = el('span', { className: 'mono perform-key-label' }, ['±0'])
  const keyUpBtn = el('button', { className: 'btn btn-ghost' }, ['♯'])
  // ---------- ガイドボーカル音量(§4.12、設定モーダルの見つけにくさ改善: 本番画面にも直接置く) ----------
  const guideVocalLabel = el('span', { className: 'mono' }, ['ガイド'])
  const guideVocalInput = el('input', { type: 'range', min: '0', max: '1', step: '0.05' }) as HTMLInputElement
  const timeLabel = el('span', { className: 'mono perform-time' }, ['0:00.00'])
  controls.append(
    homeBtn,
    backBtn,
    playBtn,
    restartBtn,
    sourceSelect,
    keyDownBtn,
    keyLabel,
    keyUpBtn,
    guideVocalLabel,
    guideVocalInput,
    fullscreenBtn,
    timeLabel
  )

  const offsetIndicator = el('div', { className: 'perform-offset-indicator' })
  const micNotice = el('div', { className: 'perform-mic-notice' })
  const dragHandle = el('div', { className: 'perform-drag-handle' })

  root.append(progressBar, pitchStripWrap, lyricsArea, countdownEl, controls, offsetIndicator, micNotice, dragHandle)

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
  // §4.12 カウントイン/キー提示のプリロール中はPlaybackEngine.getCurrentTime()が負の値
  // (曲の実際の頭に到達するまでの残り秒数)を返す。ここで0にクランプせずそのまま通すことで、
  // renderCountdown()の残り秒数計算がプリロール中も自然に減っていき、4カウントの数字表示が
  // 実際のクリック音とずれずに連動する(クランプすると歌い出しまでの残り秒数が実際より
  // 短く見えてしまう)。0未満にしたくない表示箇所(進捗バー等)は呼び出し側で個別にクランプする。
  function playheadDisplaySec(): number {
    return ctx.playback.getCurrentTime() - displayOffsetSec()
  }
  function totalDurationSec(): number {
    return ctx.playback.duration
  }

  // ---------- 採点用マイク入力(§4.12.1/4.12.2) ----------
  let micSession: MicPitchSession | null = null
  let liveSungHz = 0
  const sungPitchSamples: SungPitchSample[] = []

  function showMicNotice(text: string): void {
    micNotice.textContent = text
    micNotice.classList.add('visible')
    setTimeout(() => micNotice.classList.remove('visible'), MIC_NOTICE_DURATION_MS)
  }

  async function setupScoring(): Promise<void> {
    const settings = ctx.settings.getState()
    try {
      const session = await startMicPitchDetection(
        (sample) => {
          liveSungHz = sample.hz
          const latencySec = ctx.settings.getState().micLatencyCompensationMs / 1000
          // playback(参照メロディ)のcurrentTimeをそのまま基準にする。表示用のdisplayOffsetSec()は
          // 字幕/ピッチガイド表示のためのユーザー調整値であり、採点の基準時刻には使わない(§4.12.2)。
          sungPitchSamples.push({ timeSec: ctx.playback.getCurrentTime() - latencySec, hz: sample.hz })
        },
        { deviceId: settings.micDeviceId }
      )
      if (disposed) {
        session.stop()
        return
      }
      micSession = session
    } catch {
      // マイク権限拒否・デバイス無し等: 採点なしで本番再生を続行する(§4.12.1)
      if (!disposed) showMicNotice('マイクが利用できないため、採点なしで再生します')
    }
  }
  void setupScoring()

  // ---------- ガイドボーカル(§4.12: 伴奏に分離済みボーカル音源を小さい音量で重ねて流す) ----------
  // 本番画面でのみ有効にし、離れる時は必ず解除する(PlaybackEngineはeditor画面とも共有する
  // シングルトンのため、ここで付けたオーバーレイが編集画面に漏れないようにするため)。
  // 再生ソース自体が既に「ボーカルのみ」の時は、同じ音源を重ねても意味が無いので無効にする。
  function syncGuideVocalOverlay(): void {
    const s = state()
    const overlayBuffer = s.playSource === 'analysis' ? null : s.audio.analysisBuffer
    ctx.playback.setOverlayBuffer(overlayBuffer)
  }
  syncGuideVocalOverlay()
  guideVocalInput.value = String(ctx.settings.getState().guideVocalVolume)
  ctx.playback.setOverlayVolume(ctx.settings.getState().guideVocalVolume)
  // 本番画面のスライダー操作中に設定モーダル側の値と食い違わないよう、設定側の変化も
  // 常にスライダーへ反映する(設定モーダルを別ウインドウ等で同時に開くケースは無いが、
  // 将来的な変更経路の増加に備えて一方向の描画同期にしておく)。
  const unsubGuideVocalVolume = ctx.settings.subscribe((s) => {
    ctx.playback.setOverlayVolume(s.guideVocalVolume)
    if (document.activeElement !== guideVocalInput) guideVocalInput.value = String(s.guideVocalVolume)
  })
  guideVocalInput.addEventListener('input', () => {
    ctx.playback.setOverlayVolume(Number(guideVocalInput.value))
  })
  guideVocalInput.addEventListener('change', () => {
    void window.dokokara.setSettings({ guideVocalVolume: Number(guideVocalInput.value) }).then((updated) => ctx.settings.setState(updated))
  })

  function finishAndShowResult(): void {
    micSession?.stop()
    micSession = null
    const s = state()
    const notes = s.project?.analysis.notes ?? []
    const keySemitones = s.project?.playback.keySemitones ?? 0
    const result = scorePerformance(notes, sungPitchSamples, { keySemitones })
    ctx.ui.setState({ lastScoreResult: result })
    ctx.navigate('result')
  }
  ctx.playback.onEnded(finishAndShowResult)

  // ---------- ナビゲーション・再生操作 ----------
  homeBtn.addEventListener('click', async () => {
    if (!(await confirmDiscardIfDirty(ctx))) return
    ctx.navigate('home')
    await ctx.refreshHome()
  })
  backBtn.addEventListener('click', () => ctx.navigate('editor'))
  // 再生開始時のジングル(§4.12「キー提示」)・歌い出し前4カウントは、曲の冒頭(位置0)から
  // 始める時だけ鳴らす。一時停止からの再開のたびに鳴ると煩わしいため。
  function startPlayback(): void {
    if (ctx.playback.getCurrentTime() === 0) {
      const settings = ctx.settings.getState()
      const projectPlayback = state().project?.playback
      // 曲ごとのオン/オフ(§4.12編集画面)がnull/未設定ならアプリ全体設定にフォールバックする
      // (既存プロジェクトのkeySemitonesマイグレーションと同じ考え方)。
      const keyJingleEnabled = projectPlayback?.keyJingleEnabled ?? settings.keyJingleEnabled
      const countInEnabled = projectPlayback?.countInEnabled ?? settings.countInEnabled
      const now = ctx.playback.audioContext.currentTime
      const firstLineStartSec = lines()[0]?.start ?? null
      const cueSchedule = computeStartCueSchedule(now, firstLineStartSec, countInEnabled, keyJingleEnabled)
      if (cueSchedule.firstLineStartAt !== null && cueSchedule.countInStartAt !== null) {
        scheduleCountInClicks(ctx.playback.audioContext, cueSchedule.firstLineStartAt)
      }
      if (cueSchedule.keyToneStartAt !== null) {
        playKeyTone(ctx.playback.audioContext, cueSchedule.keyToneStartAt)
      }
      ctx.playback.play(undefined, cueSchedule.songStartAt)
    } else {
      ctx.playback.play()
    }
    playBtn.textContent = '⏸'
  }
  function togglePlay(): void {
    if (ctx.playback.isPlaying()) {
      ctx.playback.pause()
      playBtn.textContent = '▶'
    } else {
      startPlayback()
    }
  }
  playBtn.addEventListener('click', togglePlay)
  restartBtn.addEventListener('click', () => {
    ctx.playback.seek(0)
    startPlayback()
  })

  sourceSelect.value = state().playSource
  sourceSelect.addEventListener('change', () => {
    const src = sourceSelect.value as PlaySource
    ctx.editor.store.setState({ playSource: src })
    ctx.playback.setBuffer(bufferForSource(state().audio, src))
    syncGuideVocalOverlay()
  })

  function toggleFullscreen(): void {
    if (!document.fullscreenElement) void root.requestFullscreen().catch(() => undefined)
    else void document.exitFullscreen().catch(() => undefined)
  }
  fullscreenBtn.addEventListener('click', toggleFullscreen)

  // ---------- オフセット調整(§4.11) ----------
  let offsetIndicatorTimer: ReturnType<typeof setTimeout> | null = null
  // 移調中のPitchShifter経路は音質面でコストがあるため、既定(半音0)の間は通常経路のまま。
  function syncKeyLabel(semitones: number): void {
    keyLabel.textContent = semitones === 0 ? '±0' : semitones > 0 ? `+${semitones}` : String(semitones)
  }
  function adjustKey(delta: number): void {
    const s = state()
    if (!s.project) return
    // 既存プロジェクト(このフィールド追加前に保存されたもの)ではkeySemitonesが
    // undefinedのことがあるため、演算前に必ず既定値0にフォールバックする。
    const newSemitones = (s.project.playback.keySemitones ?? 0) + delta
    ctx.editor.store.setState({ project: { ...s.project, playback: { ...s.project.playback, keySemitones: newSemitones } } })
    ctx.playback.setPitchShiftSemitones(newSemitones)
    syncKeyLabel(newSemitones)
    renderPitchStrip()
  }
  keyDownBtn.addEventListener('click', () => adjustKey(-1))
  keyUpBtn.addEventListener('click', () => adjustKey(1))
  {
    const initialKeySemitones = state().project?.playback.keySemitones ?? 0
    // 編集画面の低速再生設定を本番に持ち込まない
    ctx.playback.setPlaybackRate(1)
    ctx.playback.setPitchShiftSemitones(initialKeySemitones)
    syncKeyLabel(initialKeySemitones)
  }

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
  // tokenize.tsは1トークン=1モーラを保つ(Python自由デコードのモーラ単位タイミング精度を
  // 活かすため)。そのため「季節」の節(せつ)のように、ルビのモーラ数が本文の文字数より多い
  // 行では、本文が空('')のトークンが末尾に生まれる。これをそのまま独立した文字送り単位として
  // 描画すると「本文なし・ルビだけ」が浮いて見えてしまうため、本文が空のトークンは直前の
  // 表示単位へ視覚的に統合する(タイミングデータ自体はグループ化せず正確なまま保持する)。
  interface TokenDisplayGroup {
    text: string
    ruby: string
    start: number
    end: number
  }

  function groupTokensForDisplay(tokens: DokokaraToken[]): TokenDisplayGroup[] {
    const groups: TokenDisplayGroup[] = []
    for (const tk of tokens) {
      if (tk.text === '' && groups.length > 0) {
        const g = groups[groups.length - 1]
        g.ruby += tk.ruby ?? ''
        g.end = tk.end
      } else {
        groups.push({ text: tk.text, ruby: tk.ruby ?? '', start: tk.start, end: tk.end })
      }
    }
    return groups
  }

  function buildLineTokenDom(group: TokenDisplayGroup): HTMLElement {
    const wrap = el('span', { className: 'perform-token' })
    if (group.ruby) {
      const rubyWrap = el('span', { className: 'perform-token-ruby-wrap' })
      const rubyBase = el('span', { className: 'perform-token-ruby-base' }, [group.ruby])
      const rubyFill = el('span', { className: 'perform-token-ruby-fill' }, [group.ruby])
      rubyWrap.append(rubyBase, rubyFill)
      wrap.appendChild(rubyWrap)
    }
    const textWrap = el('span', { className: 'perform-token-text-wrap' })
    const textBase = el('span', { className: 'perform-token-text-base' }, [group.text])
    const textFill = el('span', { className: 'perform-token-text-fill' }, [group.text])
    textWrap.append(textBase, textFill)
    wrap.appendChild(textWrap)
    return wrap
  }

  let currentLineId: string | null = 'uninitialized'
  let currentLineGroups: TokenDisplayGroup[] = []
  function renderStaticLine(target: HTMLElement, line: DokokaraLine | null): void {
    clear(target)
    if (!line) return
    for (const segment of parseRubyLine(line.text)) {
      if (segment.ruby) {
        target.appendChild(el('ruby', {}, [segment.text, el('rt', {}, [segment.ruby])]))
      } else {
        target.appendChild(document.createTextNode(segment.text))
      }
    }
  }

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
      currentLineGroups = current ? groupTokensForDisplay(current.tokens) : []
      currentLineGroups.forEach((g) => currentLineEl.appendChild(buildLineTokenDom(g)))
      renderStaticLine(prevLineEl, prev)
      renderStaticLine(nextLineEl, next)
    }

    if (current) updateTokenFill(t)
  }

  function updateTokenFill(t: number): void {
    currentLineGroups.forEach((g, i) => {
      const progress = g.end > g.start ? Math.min(1, Math.max(0, (t - g.start) / (g.end - g.start))) : t >= g.end ? 1 : 0
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
  function resetCountdown(): void {
    countdownEl.textContent = ''
    countdownEl.classList.remove('visible')
  }
  function renderCountdown(t: number): void {
    const all = lines()
    const settings = ctx.settings.getState()
    const currentIdx = all.findIndex((l) => t >= l.start && t < l.end)
    if (currentIdx !== -1) {
      resetCountdown()
      return
    }

    const nextIdx = all.findIndex((l) => l.start > t)
    if (nextIdx === -1) {
      resetCountdown()
      return
    }
    const next = all[nextIdx]
    const prevEnd = nextIdx > 0 ? all[nextIdx - 1].end : 0
    const isIntro = nextIdx === 0

    const gap = next.start - prevEnd
    const countInEnabled = state().project?.playback.countInEnabled ?? settings.countInEnabled
    const shouldCountdown = isIntro ? countInEnabled : gap >= INTERLUDE_THRESHOLD_SEC
    if (!shouldCountdown) {
      resetCountdown()
      return
    }
    const remain = Math.max(0, next.start - t)
    const introBeat = isIntro ? countInBeatForRemaining(remain) : null
    if (isIntro && introBeat === null) {
      resetCountdown()
      return
    }
    const value = String(isIntro ? introBeat : Math.ceil(remain))
    // クリック音自体はここでは鳴らさない(startPlayback()で歌い出し直前の4カウントとして
    // まとめてスケジュール済み)。ここは数字表示の更新のみを担当する。
    countdownEl.textContent = value
    countdownEl.classList.add('visible')
  }

  // ---------- ピッチガイド描画(初回のみ全体を構築し、以後はtransformでスクロール) ----------
  const PPS = 100
  // ノート間をこの秒数以内なら段差(縦線)で繋ぐ。これを超える間隔は無音区間とみなし空白のままにする。
  const NOTE_CONNECT_THRESHOLD_SEC = 0.3
  let pitchMinMidi = 48
  let pitchMaxMidi = 72
  let sungPitchPath: SVGPathElement | null = null

  function renderPitchStrip(): void {
    clear(pitchStripInner)
    const s = state()
    const notes = s.project?.analysis.notes ?? []
    const keySemitones = s.project?.playback.keySemitones ?? 0
    const allTokens = (s.project?.lyrics ?? []).flatMap((line) => line.tokens)
    if (allTokens.length === 0) return
    const tokenPitchesMidi = computeTokenPitchesMidi(allTokens, notes)

    const plottedPitches = tokenPitchesMidi.filter((midi): midi is number => midi !== null).map((midi) => midi + keySemitones)
    if (plottedPitches.length > 0) {
      const detectedMin = Math.min(...plottedPitches)
      const detectedMax = Math.max(...plottedPitches)
      const center = (detectedMin + detectedMax) / 2
      const span = Math.max(14, detectedMax - detectedMin + 4)
      pitchMinMidi = center - span / 2
      pitchMaxMidi = center + span / 2
    }

    const width = Math.max(1, totalDurationSec() * PPS)
    pitchStripInner.style.width = `${width}px`
    pitchStripInner.style.height = `${PITCH_STRIP_HEIGHT}px`

    const ns = 'http://www.w3.org/2000/svg'
    const svg = document.createElementNS(ns, 'svg')
    svg.setAttribute('width', String(width))
    svg.setAttribute('height', String(PITCH_STRIP_HEIGHT))

    // 半音ごとの横線を薄く表示し、音程差を目で追いやすくする。C音だけ少し強調する。
    for (let midi = Math.ceil(pitchMinMidi); midi <= Math.floor(pitchMaxMidi); midi++) {
      const grid = document.createElementNS(ns, 'line')
      const y = yForMidi(midi, pitchMinMidi, pitchMaxMidi)
      grid.setAttribute('x1', '0')
      grid.setAttribute('x2', String(width))
      grid.setAttribute('y1', String(y))
      grid.setAttribute('y2', String(y))
      grid.setAttribute('stroke', 'var(--color-text-weakest)')
      grid.setAttribute('stroke-width', midi % 12 === 0 ? '1' : '0.5')
      grid.setAttribute('opacity', midi % 12 === 0 ? '0.28' : '0.1')
      svg.appendChild(grid)
    }

    // お手本メロディを、歌詞トークン(文字/ルビ単位、§4.6.1で既にモーラ重み配分・ルビ対応
    // 済みのtoken.start/endをそのまま使う)単位の水平バーで描画する(DAM等の採点画面のような
    // 「階段状」の見た目)。ノート単位(RMVPE→Basic Pitchの検出区間そのまま)だと歌詞の
    // 文字送りタイミングと視覚的にズレて精度が悪く見える、という指摘への対応。各トークンの
    // ピッチは重なるノートの重み付け平均(computeTokenPitchesMidi)。連続するトークンの間隔が
    // 十分短ければ縦線で段差を繋ぎ、無声トークン・間隔が大きい所は空白のままにする。
    let d = ''
    let prevPlotted: { end: number; y: number } | null = null
    for (let i = 0; i < allTokens.length; i++) {
      const midi = tokenPitchesMidi[i]
      if (midi === null) {
        prevPlotted = null
        continue
      }
      const token = allTokens[i]
      const xStart = token.start * PPS
      const xEnd = token.end * PPS
      const y = yForMidi(midi + keySemitones, pitchMinMidi, pitchMaxMidi)
      if (prevPlotted && token.start - prevPlotted.end <= NOTE_CONNECT_THRESHOLD_SEC) {
        d += `L${xStart.toFixed(1)},${prevPlotted.y.toFixed(1)} L${xStart.toFixed(1)},${y.toFixed(1)} L${xEnd.toFixed(1)},${y.toFixed(1)} `
      } else {
        d += `M${xStart.toFixed(1)},${y.toFixed(1)} L${xEnd.toFixed(1)},${y.toFixed(1)} `
      }
      prevPlotted = { end: token.end, y }
    }
    const path = document.createElementNS(ns, 'path')
    path.setAttribute('d', d)
    path.setAttribute('fill', 'none')
    path.setAttribute('stroke', 'var(--color-accent)')
    path.setAttribute('stroke-width', '3')
    path.setAttribute('opacity', '0.85')
    path.setAttribute('stroke-linecap', 'round')
    svg.appendChild(path)

    sungPitchPath = document.createElementNS(ns, 'path')
    sungPitchPath.setAttribute('fill', 'none')
    sungPitchPath.setAttribute('stroke', 'var(--color-accent-2)')
    sungPitchPath.setAttribute('stroke-width', '3')
    sungPitchPath.setAttribute('stroke-linecap', 'round')
    sungPitchPath.setAttribute('stroke-linejoin', 'round')
    sungPitchPath.setAttribute('opacity', '0.95')
    svg.appendChild(sungPitchPath)
    pitchStripInner.appendChild(svg)
  }
  renderPitchStrip()

  function updatePitchStripScroll(t: number): void {
    const markerX = pitchStripWrap.clientWidth * PITCH_STRIP_MARKER_FRACTION
    pitchStripInner.style.transform = `translateX(${(markerX - t * PPS).toFixed(1)}px)`
    pitchMarker.style.left = `${markerX}px`
    updateSungPitchTrail(t)
    updateLivePitchDot(markerX)
  }

  function updateSungPitchTrail(currentTime: number): void {
    if (!sungPitchPath) return
    const visiblePastSec = pitchStripWrap.clientWidth * PITCH_STRIP_MARKER_FRACTION / PPS + 1
    const visibleFutureSec = pitchStripWrap.clientWidth * (1 - PITCH_STRIP_MARKER_FRACTION) / PPS + 1
    const start = currentTime - visiblePastSec
    const end = currentTime + visibleFutureSec
    let d = ''
    let previousTime: number | null = null
    for (const sample of sungPitchSamples) {
      if (sample.timeSec < start || sample.timeSec > end) continue
      if (sample.hz <= 0 || (previousTime !== null && sample.timeSec - previousTime > 0.15)) {
        previousTime = null
        continue
      }
      const x = sample.timeSec * PPS
      const y = yForMidi(hzToMidi(sample.hz), pitchMinMidi, pitchMaxMidi)
      d += `${previousTime === null ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)} `
      previousTime = sample.timeSec
    }
    sungPitchPath.setAttribute('d', d)
  }

  // 採点用: 現在(=pitchMarkerの位置)の歌唱ピッチをお手本メロディに重ねて表示する(§4.12.4)
  function updateLivePitchDot(markerX: number): void {
    if (liveSungHz <= 0) {
      livePitchDot.classList.remove('visible')
      return
    }
    livePitchDot.classList.add('visible')
    livePitchDot.style.left = `${markerX}px`
    livePitchDot.style.top = `${yForMidi(hzToMidi(liveSungHz), pitchMinMidi, pitchMaxMidi)}px`
  }

  // ---------- メインループ ----------
  function tick(): void {
    if (disposed) return
    const t = playheadDisplaySec()
    timeLabel.textContent = formatTime(t)
    const duration = totalDurationSec()
    progressFill.style.width = duration > 0 ? `${Math.max(0, Math.min(100, (t / duration) * 100))}%` : '0%'
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
      startPlayback()
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
      ctx.playback.onEnded(null)
      ctx.playback.setOverlayBuffer(null)
      ctx.playback.setPitchShiftSemitones(0)
      unsubGuideVocalVolume()
      micSession?.stop()
      micSession = null
      if (rafId !== null) cancelAnimationFrame(rafId)
      if (fadeTimer) clearTimeout(fadeTimer)
      if (offsetIndicatorTimer) clearTimeout(offsetIndicatorTimer)
      document.removeEventListener('keydown', onKeyDown)
      if (document.fullscreenElement === root) void document.exitFullscreen().catch(() => undefined)
      container.removeChild(root)
    }
  }
}
