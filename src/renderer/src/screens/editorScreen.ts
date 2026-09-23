import type { AppContext } from '../appContext'
import type { ScreenHandle } from '../lib/screen'
import { el, clear, formatTime } from '../lib/dom'
import { saveProject, confirmDiscardIfDirty, bufferForSource, notifyError } from '../lib/projectActions'
import { snapTime, nearestGridTime, SNAP_PRIORITY, type SnapTarget } from '../lib/snap'
import { reallocateRespectingLocks } from '../lib/retiming'
import { resizeLineTokens } from '../lib/resizeLine'
import { beatGridTimes, estimateTempo, nearestBeatGridTime, onsetStrengthEnvelope } from '../lib/tempo'
import { buildWaveformPeaks } from '../lib/waveform'
import {
  buildComboLookup,
  comboFromEvent,
  formatCombo,
  resolveBindings,
  type ShortcutActionId
} from '@shared/keybindings'
import { tokenizeLine } from '@shared/tokenize'
import { parseRubyLine, rubyToPlainText } from '@shared/ruby'
import { allocateTokenTimings, findPitchChangePoints } from '@shared/analysis/allocate'
import { DEFAULT_HOP_SEC, type DokokaraLine, type DokokaraRhythm, type DokokaraToken, type PlaySource } from '@shared/types'

const BASE_PPS = 80 // 1倍ズームでの1秒あたりピクセル数
// タイムラインの末尾より先(再生バーが存在しない範囲)へも手動スクロールできるようにする余白(px)
const SCROLL_END_PADDING_PX = 400
const MIN_ZOOM = 0.25
const MAX_ZOOM = 8
const RIBBON_HEIGHT = 110
const BLOCK_HEIGHT = 40
const BOUNDARY_HEIGHT = 36
const EDGE_GRAB_PX = 6
const MIN_LINE_DURATION = 0.05
// 文字(トークン)本体をドラッグ移動とみなすまでの移動量(px)。これ未満ならクリック扱い
const TOKEN_DRAG_THRESHOLD_PX = 3
const MIN_TOKEN_DURATION = 0.02
// 再生速度の選択肢。主な用途は低速再生でのタイミング合わせ
const SPEED_STEPS = [0.5, 0.6, 0.7, 0.75, 0.8, 0.9, 1, 1.25, 1.5]
// リズムスナップの選択肢(値=1拍あたりの分割数、0はオフ)
const BEAT_SNAP_OPTIONS: [number, string][] = [
  [0, 'リズム: オフ'],
  [1, '4分音符'],
  [2, '8分音符'],
  [3, '3連8分'],
  [4, '16分音符']
]
const BOTTOM_PANEL_HEIGHT_KEY = 'dokokara.editor.bottomPanelHeight'
const MIN_BOTTOM_PANEL_HEIGHT = 100

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
  const settingsBtn = el('button', { className: 'btn btn-ghost' }, ['⚙ 設定'])
  const performBtn = el('button', { className: 'btn btn-primary' }, ['本番へ →'])
  header.append(backBtn, title, saveBtn, settingsBtn, performBtn)

  backBtn.addEventListener('click', async () => {
    if (!(await confirmDiscardIfDirty(ctx))) return
    ctx.navigate('home')
    await ctx.refreshHome()
  })
  saveBtn.addEventListener('click', () => void saveProject(ctx, false))
  settingsBtn.addEventListener('click', () => ctx.openSettings())
  performBtn.addEventListener('click', () => ctx.navigate('perform'))

  // ---------- ツールバー ----------
  const toolbar = el('div', { className: 'editor-toolbar' })
  const playBtn = el('button', { className: 'btn btn-ghost' }, ['▶'])
  const timeLabel = el('span', { className: 'mono editor-time' }, ['0:00.00'])
  const speedSelect = el('select', { className: 'editor-select' }) as HTMLSelectElement
  for (const r of SPEED_STEPS) speedSelect.appendChild(el('option', { value: String(r) }, [`${r}x`]))
  const sourceSelect = el('select', { className: 'editor-select' }) as HTMLSelectElement
  sourceSelect.append(
    el('option', { value: 'playback' }, ['オフボーカル']),
    el('option', { value: 'original' }, ['オンボーカル']),
    el('option', { value: 'analysis' }, ['ボーカルのみ'])
  )
  const guidesBtn = el('button', { className: 'btn btn-ghost' }, ['ガイド線'])
  const snapBtn = el('button', { className: 'btn btn-ghost' }, ['スナップ'])
  const beatSnapSelect = el('select', { className: 'editor-select' }) as HTMLSelectElement
  for (const [value, label] of BEAT_SNAP_OPTIONS) beatSnapSelect.appendChild(el('option', { value: String(value) }, [label]))
  const bpmInput = el('input', { type: 'number', min: '30', max: '300', step: '0.1', className: 'editor-bpm-input' }) as HTMLInputElement
  const bpmEstimateBtn = el('button', { className: 'btn btn-ghost' }, ['BPM推定'])
  const beatAlignBtn = el('button', { className: 'btn btn-ghost' }, ['拍を合わせる'])
  const zoomOutBtn = el('button', { className: 'btn btn-ghost' }, ['−'])
  const zoomFitBtn = el('button', { className: 'btn btn-ghost' }, ['全体表示'])
  const zoomInBtn = el('button', { className: 'btn btn-ghost' }, ['＋'])
  const addLineBtn = el('button', { className: 'btn btn-ghost' }, ['+ 行を追加'])
  const tapModeBtn = el('button', { className: 'btn btn-ghost' }, ['タップ入力'])
  const offsetLabel = el('span', { className: 'mono editor-offset' }, ['0ms'])
  const reallocateBtn = el('button', { className: 'btn btn-ghost' }, ['この行を再配分'])

  // --- 曲ごとの4カウント/キー提示音のオン/オフ(§4.12) ---
  // オン/オフの2値のみ(「既定」という3つ目の選択肢は分かりにくいという指摘を受けて廃止)。
  // 表示中のチェック状態は常に有効値(project側の値、無ければアプリ全体設定)を反映するが、
  // 操作すると必ずプロジェクト側に明示的なtrue/falseを書き込む。
  const cueLabelStyle = { display: 'inline-flex', alignItems: 'center', gap: '4px' } as unknown as CSSStyleDeclaration
  const countInCheckbox = el('input', { type: 'checkbox' }) as HTMLInputElement
  const countInLabel = el('label', { className: 'editor-select', style: cueLabelStyle }, [countInCheckbox, '4カウント'])
  const jingleCheckbox = el('input', { type: 'checkbox' }) as HTMLInputElement
  const jingleLabel = el('label', { className: 'editor-select', style: cueLabelStyle }, [jingleCheckbox, 'キー提示音'])

  const group = (...children: HTMLElement[]): HTMLElement => el('div', { className: 'editor-toolbar-group' }, children)
  const offsetWrap = el('span', { className: 'editor-offset-wrap' }, [el('span', { className: 'mono' }, ['オフセット']), offsetLabel])
  toolbar.append(
    group(playBtn, timeLabel, speedSelect, sourceSelect),
    group(zoomOutBtn, zoomFitBtn, zoomInBtn, guidesBtn),
    group(snapBtn, beatSnapSelect, bpmInput, bpmEstimateBtn, beatAlignBtn),
    group(addLineBtn, reallocateBtn, tapModeBtn),
    group(countInLabel, jingleLabel),
    el('span', { className: 'editor-toolbar-spacer' }, []),
    offsetWrap
  )

  // ---------- ツールチップ(カーソルを置くと説明が出る。割り当て済みのショートカットも併記) ----------
  const tipDefs: [HTMLElement, string, ShortcutActionId | null][] = [
    [backBtn, 'ホーム画面へ戻ります(未保存の変更があれば確認します)', null],
    [saveBtn, 'プロジェクトを上書き保存します', null],
    [settingsBtn, '設定を開きます(ショートカットキーの変更もここから)', 'openSettings'],
    [performBtn, '本番(カラオケ再生)画面へ移ります', 'goToPerform'],
    [playBtn, '再生・一時停止', 'playPause'],
    [timeLabel, '現在の再生位置', null],
    [speedSelect, '再生速度。音程は変えずに速さだけ変わります。ゆっくり再生してタイミングを合わせる時に', null],
    [sourceSelect, '編集中に流す音声(伴奏のみ / 原曲 / ボーカルのみ)', null],
    [zoomOutBtn, 'タイムラインを縮小', 'zoomOut'],
    [zoomFitBtn, '曲全体が画面に収まるように表示', 'zoomFit'],
    [zoomInBtn, 'タイムラインを拡大(トラックパッドのピンチでも可)', 'zoomIn'],
    [
      guidesBtn,
      'ガイド線の表示切り替え。自動解析で見つけたフレーズの区切り(灰色)と音の出だし(赤)、リズムスナップ中は拍の線を波形に重ねて表示します',
      'toggleGuides'
    ],
    [snapBtn, 'ドラッグ時に再生位置・他の行の端・ガイド線などへ吸着させます。Altキーを押しながらドラッグすると一時的に無効', 'toggleSnap'],
    [beatSnapSelect, 'リズムスナップ: 曲のテンポに合わせた音符単位(4分・8分など)へ吸着させます', 'cycleBeatSnap'],
    [bpmInput, '曲のテンポ(BPM)。リズムスナップの拍の間隔になります', null],
    [bpmEstimateBtn, '伴奏の音からBPMと拍の位置を自動で推定します', null],
    [beatAlignBtn, '拍の線がずれている時に、現在の再生位置を拍の頭として合わせ直します', null],
    [addLineBtn, '再生位置に新しい行を追加します', 'addLine'],
    [reallocateBtn, '選択中の行の文字タイミングを自動で割り振り直します(ロックした文字はそのまま)', 'reallocateLine'],
    [
      tapModeBtn,
      'タップ入力モード: 曲を再生しながらキーを押すたびに、選択中の行の文字の開始時刻を1文字ずつ確定していきます',
      'toggleTapMode'
    ],
    [countInLabel, '本番で再生前に4カウントを鳴らすか(この曲だけの設定)', null],
    [jingleLabel, '本番で再生前にキーの音を鳴らすか(この曲だけの設定)', null],
    [offsetWrap, '歌詞表示のタイミング補正。音声はずらさず、表示だけを前後させます', 'offsetIncrease']
  ]
  function refreshTips(): void {
    const isMac = navigator.platform.toLowerCase().includes('mac')
    const bindings = resolveBindings(settings().shortcuts)
    for (const [target, text, actionId] of tipDefs) {
      const combos = actionId ? bindings[actionId] : []
      target.dataset.tip = combos.length > 0 ? `${text}\n[${combos.map((c) => formatCombo(c, isMac)).join(' / ')}]` : text
    }
  }

  function syncCueSelects(): void {
    const pb = state().project?.playback
    countInCheckbox.checked = pb?.countInEnabled ?? settings().countInEnabled
    jingleCheckbox.checked = pb?.keyJingleEnabled ?? settings().keyJingleEnabled
  }
  countInCheckbox.addEventListener('change', () => {
    const s = state()
    if (!s.project) return
    ctx.editor.store.setState({
      project: { ...s.project, playback: { ...s.project.playback, countInEnabled: countInCheckbox.checked } }
    })
  })
  jingleCheckbox.addEventListener('change', () => {
    const s = state()
    if (!s.project) return
    ctx.editor.store.setState({
      project: { ...s.project, playback: { ...s.project.playback, keyJingleEnabled: jingleCheckbox.checked } }
    })
  })

  // ---------- タイムライン(ピッチリボン・波形・ガイド・ブロック・境界バー) ----------
  const scrollArea = el('div', { className: 'editor-track-scroll' })
  const track = el('div', { className: 'editor-track' })
  const ribbonSvgWrap = el('div', { className: 'editor-ribbon' })
  const blocksLayer = el('div', { className: 'editor-blocks-layer' })
  const boundaryLayer = el('div', { className: 'editor-boundary-layer' })
  const playhead = el('div', { className: 'editor-playhead' })
  track.append(ribbonSvgWrap, blocksLayer, boundaryLayer, playhead)
  scrollArea.appendChild(track)
  // 手動スクロールで再生バーが画面外に出た時の方向インジケーター(§スクロール)。
  // scrollAreaの外(editor-main直下)に置き、スクロールに追従せずビューポート基準で固定表示する。
  const playheadIndicator = el('button', { className: 'editor-playhead-indicator' })
  playheadIndicator.addEventListener('click', () => {
    const x = xForTime(playheadDisplaySec())
    scrollArea.scrollLeft = Math.max(0, x - scrollArea.clientWidth / 2)
  })

  // ---------- 下段パネル(選択行のテキスト編集) ----------
  const sidePanel = el('div', { className: 'editor-side-panel panel' })
  const sidePanelEmpty = el('p', { className: 'editor-side-empty' }, ['行を選択するとここで歌詞を編集できます'])
  const textArea = el('textarea', { className: 'editor-text-input', rows: 3 }) as HTMLTextAreaElement
  const lineTimeRow = el('div', { className: 'editor-line-time-row mono' })
  const lineConfidenceRow = el('div', { className: 'editor-line-confidence-row mono' })
  const tapModeHint = el('p', { className: 'editor-tap-hint' })
  const tokenEditHint = el('ul', { className: 'editor-token-edit-hint' }, [
    el('li', {}, ['文字をドラッグで移動、文字の区切り線をドラッグで境界を調整']),
    el('li', {}, ['行ブロックの端をドラッグで行の長さを変更(はみ出した文字だけ縮みます)']),
    el('li', {}, ['文字を右クリックで分割・結合・ロック・休符の追加'])
  ])
  const sideInfo = el('div', { className: 'editor-side-info' }, [lineTimeRow, lineConfidenceRow, tapModeHint, tokenEditHint])
  sidePanel.append(sidePanelEmpty, textArea, sideInfo)
  textArea.style.display = 'none'
  sideInfo.style.display = 'none'

  // タイムラインと下段パネルの境界をドラッグして下段の高さを変えられるようにする
  // (以前はテキスト欄右下の小さなつまみでしかサイズ変更できず分かりにくかった)
  const splitter = el('div', { className: 'editor-splitter' })
  splitter.dataset.tip = 'ドラッグで歌詞入力欄の高さを変更'
  const editorMain = el('div', { className: 'editor-main' }, [scrollArea, playheadIndicator, splitter, sidePanel])
  root.append(header, toolbar, editorMain)

  function applyBottomPanelHeight(px: number): void {
    const max = Math.max(MIN_BOTTOM_PANEL_HEIGHT, editorMain.clientHeight - 240)
    const clamped = Math.round(Math.max(MIN_BOTTOM_PANEL_HEIGHT, Math.min(px, max)))
    sidePanel.style.height = `${clamped}px`
  }
  {
    let saved = NaN
    try {
      saved = Number(localStorage.getItem(BOTTOM_PANEL_HEIGHT_KEY))
    } catch {
      /* 保存値が読めなくても既定の高さで表示する */
    }
    if (Number.isFinite(saved) && saved > 0) sidePanel.style.height = `${saved}px`
  }
  splitter.addEventListener('pointerdown', (e) => {
    e.preventDefault()
    const startY = e.clientY
    const startHeight = sidePanel.getBoundingClientRect().height
    splitter.classList.add('dragging')
    const onMove = (ev: PointerEvent): void => applyBottomPanelHeight(startHeight - (ev.clientY - startY))
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      splitter.classList.remove('dragging')
      try {
        localStorage.setItem(BOTTOM_PANEL_HEIGHT_KEY, String(sidePanel.getBoundingClientRect().height))
      } catch {
        /* 保存できなくても操作自体は有効 */
      }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  })

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
    return a.playbackBuffer?.duration ?? a.analysisBuffer?.duration ?? a.originalBuffer?.duration ?? 0
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
    // タイムライン末尾より先まで手動スクロールできるよう、trackの幅にだけ余白を足す
    // (ribbon/blocks/boundary各レイヤー自体の描画幅は音源長のままでよい)
    track.style.minWidth = `${width + SCROLL_END_PADDING_PX}px`

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
      for (const onset of onsetsFromState()) {
        const line = document.createElementNS(ns, 'line')
        const x = xForTime(onset)
        line.setAttribute('x1', String(x))
        line.setAttribute('x2', String(x))
        line.setAttribute('y1', '0')
        line.setAttribute('y2', String(RIBBON_HEIGHT))
        line.setAttribute('stroke', 'var(--color-accent-2)')
        line.setAttribute('stroke-width', '1')
        line.setAttribute('opacity', '0.18')
        svg.appendChild(line)
      }
      // リズムスナップ中は拍グリッドを表示する(拍の頭は濃く、分割線は薄く)
      const rhythm = s.project?.rhythm
      if (rhythm && s.beatSnapDivision > 0) {
        const beatSec = 60 / rhythm.bpm
        for (const t of beatGridTimes(rhythm, s.beatSnapDivision, 0, totalDurationSec())) {
          const beatPos = (t - rhythm.firstBeatSec) / beatSec
          const onBeat = Math.abs(beatPos - Math.round(beatPos)) < 1e-6
          const line = document.createElementNS(ns, 'line')
          const x = xForTime(t)
          line.setAttribute('x1', String(x))
          line.setAttribute('x2', String(x))
          line.setAttribute('y1', '0')
          line.setAttribute('y2', String(RIBBON_HEIGHT))
          line.setAttribute('stroke', 'var(--color-accent)')
          line.setAttribute('stroke-width', '1')
          line.setAttribute('opacity', onBeat ? '0.45' : '0.15')
          svg.appendChild(line)
        }
      }
    }

    // ピッチリボン(二層描画: 太いグロー + 細い明色線)
    const pitchHz = s.pitchHz
    const hopSec = s.project?.analysis.hopSec ?? DEFAULT_HOP_SEC
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
      const plainText = rubyToPlainText(parseRubyLine(line.text))
      const blockEl = el('div', { className: `editor-block${selected ? ' selected' : ''}` }, [plainText || '(空)'])
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
      if (e.button !== 0) return
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
          updateLineTiming(line.id, newStart, newEnd, false, line.tokens)
        } else if (mode === 'resize-left') {
          let newStart = snapCandidate(origStart + deltaSec, staticTargets, ev.altKey)
          const minStart = prevLine ? prevLine.end : 0
          newStart = Math.max(minStart, Math.min(newStart, origEnd - MIN_LINE_DURATION))
          updateLineTiming(line.id, newStart, origEnd, true, line.tokens)
        } else {
          let newEnd = snapCandidate(origEnd + deltaSec, staticTargets, ev.altKey)
          const maxEnd = nextLine ? nextLine.start : Infinity
          newEnd = Math.min(maxEnd, Math.max(newEnd, origStart + MIN_LINE_DURATION))
          updateLineTiming(line.id, origStart, newEnd, true, line.tokens)
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
    const rhythm = state().project?.rhythm
    const division = state().beatSnapDivision
    // リズムスナップ中は0.1秒グリッドの代わりに拍グリッドへ吸着させる(両方あると拍から外れた位置に吸われる)
    const gridTarget: SnapTarget =
      rhythm && division > 0
        ? { time: nearestBeatGridTime(candidateTime, rhythm, division), priority: SNAP_PRIORITY.beatGrid }
        : { time: nearestGridTime(candidateTime), priority: SNAP_PRIORITY.grid }
    return snapTime(candidateTime, [...staticTargets, gridTarget], pps(), settings().snapDistancePx)
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
    for (const onset of onsetsFromState()) targets.push({ time: onset, priority: SNAP_PRIORITY.onset })
    return targets
  }

  /**
   * resizeがtrueなら行の端だけを動かす。均等割り付けはせず、行からはみ出した文字だけを縮める
   * (手で合わせた文字タイミングが行末調整で崩れる不具合への対応)。ドラッグ開始時点のトークンを
   * 基準に毎回計算し直すことで、縮めてから戻した時に元の文字タイミングへ戻るようにする。
   */
  function updateLineTiming(
    lineId: string,
    newStart: number,
    newEnd: number,
    resize: boolean,
    origTokens: DokokaraToken[]
  ): void {
    ctx.editor.applyTransient((lyrics) =>
      lyrics.map((l) => {
        if (l.id !== lineId) return l
        const tokens = resize ? resizeLineTokens(origTokens, newStart, newEnd, MIN_TOKEN_DURATION) : shiftTokens(l.tokens, newStart - l.start)
        return { ...l, start: newStart, end: newEnd, tokens }
      })
    )
    renderBlocks()
    renderBoundary()
  }

  function shiftTokens(tokens: DokokaraToken[], deltaSec: number): DokokaraToken[] {
    return tokens.map((t) => ({ ...t, start: t.start + deltaSec, end: t.end + deltaSec }))
  }

  // ---------- 文字境界バー(全行を常時表示、選択行のみ境界操作を有効化) ----------
  function renderBoundary(): void {
    clear(boundaryLayer)
    const s = state()
    const lines = s.project?.lyrics ?? []
    if (lines.length === 0) {
      boundaryLayer.style.display = 'none'
      return
    }
    boundaryLayer.style.display = 'block'
    const width = Math.max(1, totalDurationSec() * pps())
    boundaryLayer.style.width = `${width}px`
    boundaryLayer.style.height = `${BOUNDARY_HEIGHT}px`
    boundaryLayer.style.left = '0px'

    lines.forEach((line, lineIndex) => {
      const selectedLine = line.id === s.selection.lineId
      line.tokens.forEach((token, i) => {
        const x = xForTime(token.start)
        const w = Math.max(2, xForTime(token.end) - x)
        const tokenEl = el(
          'div',
          { className: `editor-token${token.locked ? ' locked' : ''}${selectedLine ? ' selected-line' : ''}` },
          [token.ruby ?? token.text]
        )
        tokenEl.title = token.ruby ? `${token.text || '（続き）'} / ${token.ruby}` : token.text
        tokenEl.style.left = `${x}px`
        tokenEl.style.width = `${w}px`
        // クリックはpointerdown→pointerupの移動量で判定する(attachTokenDrag内)。
        // clickイベントでは選択しない: ドラッグ後のclickで選択し直すと二重に再描画されるため。
        tokenEl.addEventListener('click', (event) => event.stopPropagation())
        attachTokenDrag(tokenEl, line, i)
        tokenEl.addEventListener('contextmenu', (e) => {
          e.preventDefault()
          e.stopPropagation()
          ctx.editor.store.setState({ selection: { lineId: line.id, tokenIndex: i } })
          showTokenMenu(e.clientX, e.clientY, line.id, i)
        })
        boundaryLayer.appendChild(tokenEl)

        // 区切り線は選択中の行に限らず全行に出す(以前は一度行をクリックしないと文字境界を触れなかった)
        if (i < line.tokens.length - 1) {
          const divider = el('div', { className: `editor-token-divider${selectedLine ? ' selected-line' : ''}` })
          divider.style.left = `${xForTime(token.end)}px`
          attachDividerDrag(divider, line, i)
          boundaryLayer.appendChild(divider)
        }
      })

      // 行頭・行末のハンドル(§4.7.3): 最初/最後の文字だけの開始・終了時刻を個別調整する。
      if (line.tokens.length > 0) {
        const startHandle = el('div', { className: 'editor-token-divider editor-line-edge-handle' })
        startHandle.style.left = `${xForTime(line.tokens[0].start)}px`
        attachLineEdgeDrag(startHandle, line, lineIndex, lines, 'start')
        boundaryLayer.appendChild(startHandle)

        const endHandle = el('div', { className: 'editor-token-divider editor-line-edge-handle' })
        endHandle.style.left = `${xForTime(line.tokens[line.tokens.length - 1].end)}px`
        attachLineEdgeDrag(endHandle, line, lineIndex, lines, 'end')
        boundaryLayer.appendChild(endHandle)
      }
    })
  }

  /** 行頭(最初のトークンのstart)・行末(最後のトークンのend)の個別ドラッグ。行のstart/endも追従させる。 */
  function attachLineEdgeDrag(
    handle: HTMLElement,
    line: DokokaraLine,
    lineIndex: number,
    allLines: DokokaraLine[],
    edge: 'start' | 'end'
  ): void {
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return
      e.stopPropagation()
      selectLineIfNeeded(line.id)
      ctx.editor.beginChange()
      isDragging = true
      const startClientX = e.clientX
      const origBoundary = edge === 'start' ? line.start : line.end
      const prevLine = allLines[lineIndex - 1] ?? null
      const nextLine = allLines[lineIndex + 1] ?? null
      const staticTargets = buildSnapTargets(lineIndex, allLines)

      const onMove = (ev: PointerEvent): void => {
        const deltaSec = (ev.clientX - startClientX) / pps()
        let newBoundary = snapCandidate(origBoundary + deltaSec, staticTargets, ev.altKey)

        if (edge === 'start') {
          const minStart = prevLine ? prevLine.end : 0
          const maxStart = line.tokens[0].end - 0.01
          newBoundary = Math.max(minStart, Math.min(newBoundary, maxStart))
        } else {
          const lastIndex = line.tokens.length - 1
          const minEnd = line.tokens[lastIndex].start + 0.01
          const maxEnd = nextLine ? nextLine.start : Infinity
          newBoundary = Math.min(maxEnd, Math.max(newBoundary, minEnd))
        }

        ctx.editor.applyTransient((lyrics) =>
          lyrics.map((l) => {
            if (l.id !== line.id) return l
            const tokens = l.tokens.map((t, i) => {
              if (edge === 'start' && i === 0) return { ...t, start: newBoundary }
              if (edge === 'end' && i === l.tokens.length - 1) return { ...t, end: newBoundary }
              return t
            })
            return edge === 'start' ? { ...l, start: newBoundary, tokens } : { ...l, end: newBoundary, tokens }
          })
        )
        renderBoundary()
        renderBlocks()
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

  function attachDividerDrag(divider: HTMLElement, line: DokokaraLine, tokenIndex: number): void {
    divider.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return
      e.stopPropagation()
      selectLineIfNeeded(line.id)
      ctx.editor.beginChange()
      isDragging = true
      const left = line.tokens[tokenIndex]
      const right = line.tokens[tokenIndex + 1]
      const origBoundary = left.end
      const startClientX = e.clientX

      const staticTargets = buildTokenSnapTargets()

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

  /** §4.7.3: 文字単位のドラッグにも同じスナップ機構を適用する(隣接ブロック端を除く) */
  function buildTokenSnapTargets(): SnapTarget[] {
    const s = state()
    const targets: SnapTarget[] = [{ time: playheadDisplaySec(), priority: SNAP_PRIORITY.playhead }]
    for (const p of s.project?.analysis.phrases ?? []) {
      targets.push({ time: p.start, priority: SNAP_PRIORITY.phraseBoundary })
      targets.push({ time: p.end, priority: SNAP_PRIORITY.phraseBoundary })
    }
    for (const onset of onsetsFromState()) targets.push({ time: onset, priority: SNAP_PRIORITY.onset })
    return targets
  }

  /** ドラッグを始めた行が未選択なら選択する(ドラッグ前に一度クリックして選択する手間を無くすため) */
  function selectLineIfNeeded(lineId: string): void {
    if (state().selection.lineId !== lineId) selectLine(lineId)
  }

  /**
   * 文字本体のドラッグ移動。文字の長さは保ったまま前後に動かし、接している隣の文字の境界も追従させる
   * (隣の文字は最小長まで縮む)。動かさずに離した場合はクリックとしてその文字を選択する。
   */
  function attachTokenDrag(tokenEl: HTMLElement, line: DokokaraLine, tokenIndex: number): void {
    tokenEl.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return
      e.stopPropagation()
      const startClientX = e.clientX
      const tokens = line.tokens
      const tok = tokens[tokenIndex]
      const prev = tokens[tokenIndex - 1] ?? null
      const next = tokens[tokenIndex + 1] ?? null
      const duration = tok.end - tok.start
      // 隣と接している(境界を共有している)時だけ隣の端を追従させる。離れている時は隣の端までしか動かさない
      const prevTouching = prev !== null && Math.abs(prev.end - tok.start) < 1e-6
      const nextTouching = next !== null && Math.abs(next.start - tok.end) < 1e-6
      const minStart = prev ? (prevTouching ? prev.start + MIN_TOKEN_DURATION : prev.end) : line.start
      const maxEnd = next ? (nextTouching ? next.end - MIN_TOKEN_DURATION : next.start) : line.end
      let staticTargets: SnapTarget[] | null = null
      let dragging = false

      const onMove = (ev: PointerEvent): void => {
        if (!dragging) {
          if (Math.abs(ev.clientX - startClientX) < TOKEN_DRAG_THRESHOLD_PX) return
          dragging = true
          selectLineIfNeeded(line.id)
          ctx.editor.beginChange()
          isDragging = true
          staticTargets = buildTokenSnapTargets()
        }
        const deltaSec = (ev.clientX - startClientX) / pps()
        let newStart = snapCandidate(tok.start + deltaSec, staticTargets ?? [], ev.altKey)
        newStart = Math.max(minStart, Math.min(newStart, maxEnd - duration))
        const newEnd = newStart + duration
        ctx.editor.applyTransient((lyrics) =>
          lyrics.map((l) => {
            if (l.id !== line.id) return l
            const updated = l.tokens.map((t, i) => {
              if (i === tokenIndex) return { ...t, start: newStart, end: newEnd }
              if (i === tokenIndex - 1 && prevTouching) return { ...t, end: newStart }
              if (i === tokenIndex + 1 && nextTouching) return { ...t, start: newEnd }
              return t
            })
            return { ...l, tokens: updated, confidence: null }
          })
        )
        renderBoundary()
      }
      const onUp = (): void => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        dragCleanup = null
        if (dragging) {
          ctx.editor.commitChange()
          isDragging = false
          renderAll()
          return
        }
        ctx.editor.store.setState({ selection: { lineId: line.id, tokenIndex } })
        renderBlocks()
        renderBoundary()
        renderSidePanel()
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
    window.removeEventListener('pointerdown', onPointerDownOutsideMenu, true)
  }
  // 以前はメニュー項目を押した時のpointerdownでもメニューが閉じてしまい、clickが届かず
  // どの項目も効かなかった。メニューの外を押した時だけ閉じる。
  function onPointerDownOutsideMenu(e: PointerEvent): void {
    if (openMenu && !openMenu.contains(e.target as Node)) closeTokenMenu()
  }
  function showTokenMenu(clientX: number, clientY: number, lineId: string, tokenIndex: number): void {
    closeTokenMenu()
    const line = (state().project?.lyrics ?? []).find((l) => l.id === lineId)
    const token = line?.tokens[tokenIndex]
    if (!line || !token) return
    const menu = el('div', { className: 'editor-token-menu panel-2' })
    const addItem = (label: string, action: () => void, enabled = true, tip = ''): void => {
      const item = el('div', { className: `editor-token-menu-item${enabled ? '' : ' disabled'}` }, [label])
      if (tip) item.dataset.tip = tip
      if (enabled) {
        item.addEventListener('click', () => {
          closeTokenMenu()
          action()
        })
      }
      menu.appendChild(item)
    }
    const chars = Array.from(token.text)
    const label = token.text || token.ruby || '（続き）'
    menu.appendChild(el('div', { className: 'editor-token-menu-title' }, [`「${label}」`]))
    addItem('前の文字と結合', () => mergeTokenWithPrev(lineId, tokenIndex), tokenIndex > 0)
    addItem('次の文字と結合', () => mergeTokenWithPrev(lineId, tokenIndex + 1), tokenIndex < line.tokens.length - 1)
    addItem(
      '1文字目で分割',
      () => splitToken(lineId, tokenIndex),
      chars.length > 1,
      chars.length > 1 ? '' : '1文字だけの文字は分割できません'
    )
    addItem(token.locked ? 'ロック解除' : 'ロック(再配分で動かさない)', () => toggleTokenLock(lineId, tokenIndex))
    addItem('前に0.2秒の休符を入れる', () => addRestAroundToken(lineId, tokenIndex, 'before'))
    addItem('後ろに0.2秒の休符を入れる', () => addRestAroundToken(lineId, tokenIndex, 'after'))
    addItem('この文字を再生位置から始める', () => startTokenAtPlayhead(lineId, tokenIndex))

    document.body.appendChild(menu)
    // 画面外にはみ出さないよう位置を補正する
    const rect = menu.getBoundingClientRect()
    menu.style.left = `${Math.max(4, Math.min(clientX, window.innerWidth - rect.width - 4))}px`
    menu.style.top = `${Math.max(4, Math.min(clientY, window.innerHeight - rect.height - 4))}px`
    openMenu = menu
    window.addEventListener('pointerdown', onPointerDownOutsideMenu, true)
  }

  /** 文字の開始時刻を再生位置にする(前の文字の終わりも合わせて動かす)。タップ入力の1回分と同じ操作 */
  function startTokenAtPlayhead(lineId: string, tokenIndex: number): void {
    const t = playheadDisplaySec()
    ctx.editor.applyAndCommit((lyrics) =>
      lyrics.map((l) => {
        if (l.id !== lineId) return l
        const cur = l.tokens[tokenIndex]
        const prev = l.tokens[tokenIndex - 1]
        const lower = prev ? prev.start + MIN_TOKEN_DURATION : l.start
        const clamped = Math.max(lower, Math.min(t, cur.end - MIN_TOKEN_DURATION))
        const tokens = l.tokens.map((tk, i) => {
          if (i === tokenIndex) return { ...tk, start: clamped }
          if (i === tokenIndex - 1) return { ...tk, end: clamped }
          return tk
        })
        return { ...l, tokens, confidence: null }
      })
    )
    renderAll()
  }

  /** トークンの端を縮め、隣接トークンとの間(または行端)に発声しない空白を作る。 */
  function addRestAroundToken(lineId: string, tokenIndex: number, side: 'before' | 'after'): void {
    ctx.editor.applyAndCommit((lyrics) =>
      lyrics.map((line) => {
        if (line.id !== lineId) return line
        const tokens = line.tokens.map((token, index) => {
          if (index !== tokenIndex) return token
          const duration = token.end - token.start
          const restDuration = Math.min(0.2, Math.max(0, duration - 0.02))
          if (restDuration <= 0) return token
          return side === 'before'
            ? { ...token, start: token.start + restDuration }
            : { ...token, end: token.end - restDuration }
        })
        return { ...line, tokens, confidence: null }
      })
    )
    renderBoundary()
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
      sideInfo.style.display = 'none'
      return
    }
    sidePanelEmpty.style.display = 'none'
    textArea.style.display = 'block'
    sideInfo.style.display = 'flex'
    if (s.tapMode) {
      const bindings = resolveBindings(settings().shortcuts)
      const isMac = navigator.platform.toLowerCase().includes('mac')
      const keyName = (id: ShortcutActionId): string => bindings[id].map((c) => formatCombo(c, isMac)).join(' / ') || '未割り当て'
      const next = line.tokens[s.selection.tokenIndex ?? 0]
      tapModeHint.textContent = `タップ入力中: 再生しながら [${keyName('tapConfirm')}] で「${next ? next.ruby ?? next.text : '―'}」の開始を確定、[${keyName('tapBack')}] で1文字戻る`
      tapModeHint.style.display = 'block'
    } else {
      tapModeHint.style.display = 'none'
    }
    if (document.activeElement !== textArea) textArea.value = line.text
    lineTimeRow.textContent = `${formatTime(line.start)} 〜 ${formatTime(line.end)}`
    lineConfidenceRow.textContent =
      line.confidence == null ? '自動タイミング付け: 未検出(手動)' : `自動タイミング付けの信頼度: ${Math.round(line.confidence * 100)}%`
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
    const onsetsSec = onsetsFromState()
    const pitchChangePoints = computePitchChangePoints()
    const timed = allocateTokenTimings(tokens, line.start, line.end, { onsetsSec, pitchChangePoints })
    ctx.editor.applyAndCommit((lyrics) =>
      lyrics.map((l) =>
        l.id === lineId
          ? {
              ...l,
              text: newText,
              tokens: timed.map((t) => ({ text: t.text, ruby: t.ruby, start: t.start, end: t.end, locked: false })),
              confidence: null
            }
          : l
      )
    )
    renderBlocks()
    renderBoundary()
  }

  /** STEP4で検出したノートの開始時刻を、トークン境界のスナップ候補として使う(§4.6.3手順2)。 */
  function onsetsFromState(): number[] {
    const s = state()
    return (s.project?.analysis.notes ?? []).map((n) => n.start)
  }

  function computePitchChangePoints(): number[] {
    const s = state()
    if (!s.pitchHz) return []
    const hopSec = s.project?.analysis.hopSec ?? DEFAULT_HOP_SEC
    const frames = Array.from(s.pitchHz).map((hz, i) => ({ timeSec: i * hopSec, hz, voiced: hz > 0 }))
    return findPitchChangePoints(frames)
  }

  reallocateBtn.addEventListener('click', () => {
    const s = state()
    const line = (s.project?.lyrics ?? []).find((l) => l.id === s.selection.lineId)
    if (!line) return
    const onsetsSec = onsetsFromState()
    const pitchChangePoints = computePitchChangePoints()
    const newTokens = reallocateRespectingLocks(line.tokens, line.start, line.end, onsetsSec, pitchChangePoints)
    ctx.editor.applyAndCommit((lyrics) =>
      lyrics.map((l) => (l.id === line.id ? { ...l, tokens: newTokens, confidence: null } : l))
    )
    renderBoundary()
  })

  addLineBtn.addEventListener('click', () => {
    const playheadT = playheadDisplaySec()
    const newLine: DokokaraLine = {
      id: generateLineId(),
      text: '新しい行',
      start: playheadT,
      end: playheadT + 1,
      tokens: [{ text: '新しい行', ruby: null, start: playheadT, end: playheadT + 1, locked: false }],
      confidence: null
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
      tokens: [...cur.tokens, ...next.tokens],
      confidence: null
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
      tokens: leftTokens,
      confidence: line.confidence
    }
    const rightLine: DokokaraLine = {
      id: generateLineId(),
      text: rightTokens.map((tk) => tk.text).join(''),
      start: rightTokens[0].start,
      end: line.end,
      tokens: rightTokens,
      confidence: line.confidence
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
    // 再生中だけ追従スクロールする。一時停止中も無条件に実行すると、手動でタイムラインを
    // 見て回ろうとしても毎フレーム再生バー付近へ引き戻されてしまい、再生バーが無い場所まで
    // スクロールできない不具合になっていた(実機で報告)。
    if (ctx.playback.isPlaying()) autoScrollToPlayhead(t)
    updatePlayheadOffscreenIndicator(t)
  }

  function autoScrollToPlayhead(t: number): void {
    const x = xForTime(t)
    const viewLeft = scrollArea.scrollLeft
    const viewRight = viewLeft + scrollArea.clientWidth
    if (x < viewLeft + 40) scrollArea.scrollLeft = Math.max(0, x - 40)
    else if (x > viewRight - 40) scrollArea.scrollLeft = x - scrollArea.clientWidth + 40
  }

  // 手動スクロールで再生バーが画面外になった時、左右どちら側にあるか示すインジケーター。
  // クリックすると再生バーへスクロールし直す。
  function updatePlayheadOffscreenIndicator(t: number): void {
    const x = xForTime(t)
    const viewLeft = scrollArea.scrollLeft
    const viewRight = viewLeft + scrollArea.clientWidth
    if (x < viewLeft) {
      playheadIndicator.textContent = '◀ 再生バー'
      playheadIndicator.classList.add('visible', 'left')
      playheadIndicator.classList.remove('right')
    } else if (x > viewRight) {
      playheadIndicator.textContent = '再生バー ▶'
      playheadIndicator.classList.add('visible', 'right')
      playheadIndicator.classList.remove('left')
    } else {
      playheadIndicator.classList.remove('visible', 'left', 'right')
    }
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

  // ---------- ソース切替(§4.10 音声パターン) ----------
  sourceSelect.value = state().playSource
  sourceSelect.addEventListener('change', () => {
    const src = sourceSelect.value as PlaySource
    ctx.editor.store.setState({ playSource: src })
    ctx.playback.setBuffer(bufferForSource(state().audio, src))
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
    const tapMode = !state().tapMode
    const s = state()
    // タップ入力を始める時に行が未選択なら、再生位置付近の行を自動で選ぶ(何も起きないように見えるのを防ぐ)
    if (tapMode && !s.selection.lineId) {
      const t = playheadDisplaySec()
      const lines = s.project?.lyrics ?? []
      const target = lines.find((l) => l.end > t) ?? lines[lines.length - 1]
      if (target) ctx.editor.store.setState({ selection: { lineId: target.id, tokenIndex: 0 } })
    }
    ctx.editor.store.setState({ tapMode })
    syncToggleButtons()
    renderAll()
  })
  syncToggleButtons()

  // ---------- 再生速度(低速再生での編集用) ----------
  function setPlaybackRate(rate: number): void {
    ctx.editor.store.setState({ playbackRate: rate })
    ctx.playback.setPlaybackRate(rate)
    speedSelect.value = String(rate)
    speedSelect.classList.toggle('active', rate !== 1)
  }
  speedSelect.addEventListener('change', () => setPlaybackRate(Number(speedSelect.value)))
  setPlaybackRate(state().playbackRate)

  // ---------- リズムスナップ(曲のテンポに合わせた音符単位への吸着) ----------
  function setRhythm(rhythm: DokokaraRhythm | null): void {
    const p = state().project
    if (!p) return
    ctx.editor.store.setState({ project: { ...p, rhythm } })
    syncRhythmControls()
    renderRibbon()
  }
  function setBeatSnapDivision(division: number): void {
    ctx.editor.store.setState({ beatSnapDivision: division })
    // テンポ未設定のままリズムスナップを選んだら、まず自動推定する
    if (division > 0 && !state().project?.rhythm) estimateRhythm()
    syncRhythmControls()
    renderRibbon()
  }
  function syncRhythmControls(): void {
    const s = state()
    const rhythm = s.project?.rhythm ?? null
    beatSnapSelect.value = String(s.beatSnapDivision)
    beatSnapSelect.classList.toggle('active', s.beatSnapDivision > 0)
    if (document.activeElement !== bpmInput) bpmInput.value = rhythm ? String(rhythm.bpm) : ''
    bpmInput.placeholder = 'BPM'
    const on = s.beatSnapDivision > 0
    bpmInput.style.display = on ? '' : 'none'
    bpmEstimateBtn.style.display = on ? '' : 'none'
    beatAlignBtn.style.display = on ? '' : 'none'
  }
  function estimateRhythm(): void {
    const s = state()
    // 伴奏(オフボーカル)の方がドラム等のリズムが明瞭なので優先する
    const buffer = s.audio.playbackBuffer ?? s.audio.originalBuffer ?? s.audio.analysisBuffer
    if (!buffer) return
    const channels: Float32Array[] = []
    for (let i = 0; i < buffer.numberOfChannels; i++) channels.push(buffer.getChannelData(i))
    const { envelope, frameRate } = onsetStrengthEnvelope(channels, buffer.sampleRate)
    const rhythm = estimateTempo(envelope, frameRate)
    if (!rhythm) {
      notifyError('テンポを推定できませんでした。BPMを直接入力してください。')
      return
    }
    setRhythm(rhythm)
  }
  beatSnapSelect.addEventListener('change', () => setBeatSnapDivision(Number(beatSnapSelect.value)))
  bpmInput.addEventListener('change', () => {
    const bpm = Number(bpmInput.value)
    if (!Number.isFinite(bpm) || bpm < 30 || bpm > 300) {
      syncRhythmControls()
      return
    }
    setRhythm({ bpm, firstBeatSec: state().project?.rhythm?.firstBeatSec ?? 0 })
  })
  bpmEstimateBtn.addEventListener('click', estimateRhythm)
  beatAlignBtn.addEventListener('click', () => {
    const rhythm = state().project?.rhythm
    if (!rhythm) return
    setRhythm({ ...rhythm, firstBeatSec: playheadDisplaySec() })
  })
  syncRhythmControls()

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

  // タッチパッドのピンチジェスチャーは、ブラウザ(Chromium)側でctrlKey付きwheelイベントとして
  // 届く(実際にCtrlキーを押しながらのホイール操作と区別できないが、トラックパッド由来の
  // ピンチ操作を検知する標準的な方法)。カーソル位置の時刻を保ったままズームする。
  scrollArea.addEventListener(
    'wheel',
    (e) => {
      if (!e.ctrlKey) return
      e.preventDefault()
      const rect = scrollArea.getBoundingClientRect()
      const cursorOffsetX = e.clientX - rect.left
      const timeAtCursor = (scrollArea.scrollLeft + cursorOffsetX) / pps()
      const factor = Math.exp(-e.deltaY * 0.01)
      setZoom(state().zoom * factor)
      scrollArea.scrollLeft = timeAtCursor * pps() - cursorOffsetX
    },
    { passive: false }
  )

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

  // ---------- キーボードショートカット(§4.9、割り当ては設定画面で変更可能) ----------
  /** 文字入力中の欄ではショートカットを効かせない(チェックボックス等は対象外にして、押した後もショートカットが効くようにする) */
  function isEditableTarget(target: EventTarget | null): boolean {
    const el = target as HTMLElement | null
    if (!el) return false
    if (el.tagName === 'TEXTAREA') return true
    if (el.tagName === 'INPUT') return !['checkbox', 'radio', 'range', 'button'].includes((el as HTMLInputElement).type)
    return false
  }

  let comboLookup = buildComboLookup(resolveBindings(settings().shortcuts))

  function runShortcut(action: ShortcutActionId): void {
    const s = state()
    const lineId = s.selection.lineId
    switch (action) {
      case 'playPause':
        togglePlay()
        break
      case 'seekBack':
        seekBy(-settings().seekStepSec)
        break
      case 'seekForward':
        seekBy(settings().seekStepSec)
        break
      case 'seekBackLarge':
        seekBy(-settings().bigSeekStepSec)
        break
      case 'seekForwardLarge':
        seekBy(settings().bigSeekStepSec)
        break
      case 'seekToStart':
        ctx.playback.seek(0)
        updatePlayheadDom()
        break
      case 'prevLine':
      case 'nextLine': {
        const lines = s.project?.lyrics ?? []
        const idx = lines.findIndex((l) => l.id === lineId)
        const nextIdx = action === 'prevLine' ? Math.max(0, idx - 1) : Math.min(lines.length - 1, idx + 1)
        if (lines[nextIdx]) selectLine(lines[nextIdx].id)
        break
      }
      case 'deselect':
        selectLine(null)
        break
      case 'editLineText':
        if (lineId) textArea.focus()
        break
      case 'deleteLine':
        deleteSelectedLine()
        break
      case 'addLine':
        addLineBtn.click()
        break
      case 'splitLine':
        splitSelectedAtPlayhead()
        break
      case 'mergeLine':
        mergeSelectedWithNext()
        break
      case 'reallocateLine':
        reallocateBtn.click()
        break
      case 'setLineStart':
      case 'setLineEnd': {
        if (!lineId) break
        const t = playheadDisplaySec()
        const key = action === 'setLineStart' ? 'start' : 'end'
        ctx.editor.applyAndCommit((lyrics) => lyrics.map((l) => (l.id === lineId ? { ...l, [key]: t } : l)))
        renderBlocks()
        break
      }
      case 'toggleTapMode':
        tapModeBtn.click()
        break
      case 'tapConfirm':
        if (s.tapMode) tapConfirmNext()
        break
      case 'tapBack':
        if (s.tapMode) tapBack()
        break
      case 'toggleSnap':
        snapBtn.click()
        break
      case 'cycleBeatSnap': {
        const values = BEAT_SNAP_OPTIONS.map(([v]) => v)
        const next = values[(values.indexOf(s.beatSnapDivision) + 1) % values.length]
        setBeatSnapDivision(next)
        break
      }
      case 'toggleGuides':
        guidesBtn.click()
        break
      case 'zoomIn':
        setZoom(s.zoom * 1.5)
        break
      case 'zoomOut':
        setZoom(s.zoom / 1.5)
        break
      case 'zoomFit':
        zoomFitBtn.click()
        break
      case 'speedDown':
      case 'speedUp': {
        const idx = SPEED_STEPS.indexOf(s.playbackRate)
        const base = idx === -1 ? SPEED_STEPS.indexOf(1) : idx
        const nextIdx = Math.max(0, Math.min(SPEED_STEPS.length - 1, base + (action === 'speedUp' ? 1 : -1)))
        setPlaybackRate(SPEED_STEPS[nextIdx])
        break
      }
      case 'speedReset':
        setPlaybackRate(1)
        break
      case 'offsetDecrease':
        adjustOffset(-5)
        break
      case 'offsetIncrease':
        adjustOffset(5)
        break
      case 'offsetDecreaseLarge':
        adjustOffset(-50)
        break
      case 'offsetIncreaseLarge':
        adjustOffset(50)
        break
      case 'goToPerform':
        ctx.navigate('perform')
        break
      case 'openSettings':
        ctx.openSettings()
        break
    }
  }

  function onKeyDown(e: KeyboardEvent): void {
    // ツールバーのセレクトボックスを操作した直後はフォーカスが残り、矢印キーで値が変わってしまうので外す
    if ((e.target as HTMLElement | null)?.tagName === 'SELECT') (e.target as HTMLElement).blur()
    // 設定画面(ショートカットの割り当て変更中を含む)が開いている間は編集画面の操作をしない
    if (ctx.ui.getState().settingsOpen) return
    if (isEditableTarget(e.target)) {
      if (e.key === 'Escape') (e.target as HTMLElement).blur()
      return
    }
    const meta = e.metaKey || e.ctrlKey
    // Undo/Redoはメニュー(menu.ts)と同じ固定キー。割り当て変更の対象外
    if (meta && e.key.toLowerCase() === 'z') {
      e.preventDefault()
      if (e.shiftKey) ctx.editor.redo()
      else ctx.editor.undo()
      renderAll()
      return
    }
    const combo = comboFromEvent(e)
    if (!combo) return
    const action = comboLookup.get(combo)
    if (!action) return
    e.preventDefault()
    closeTokenMenu()
    runShortcut(action)
  }
  document.addEventListener('keydown', onKeyDown)

  // 設定画面でショートカットが変更されたら即座に反映する
  const unsubSettings = ctx.settings.subscribe(() => {
    comboLookup = buildComboLookup(resolveBindings(settings().shortcuts))
    refreshTips()
    renderSidePanel()
  })
  refreshTips()

  // ---------- 全体再描画 ----------
  function renderAll(): void {
    title.textContent = state().project?.name ?? ''
    syncRhythmControls()
    renderRibbon()
    renderBlocks()
    renderBoundary()
    renderSidePanel()
    syncCueSelects()
  }
  renderAll()

  const unsubEditor = ctx.editor.store.subscribe((s) => {
    if (disposed || isDragging) return
    title.textContent = s.project?.name ?? ''
    renderBlocks()
    renderBoundary()
    renderSidePanel()
    syncCueSelects()
  })

  return {
    unmount() {
      disposed = true
      if (rafId !== null) cancelAnimationFrame(rafId)
      document.removeEventListener('keydown', onKeyDown)
      dragCleanup?.()
      closeTokenMenu()
      unsubEditor()
      unsubSettings()
      ctx.playback.setPlaybackRate(1)
      container.removeChild(root)
    }
  }
}
