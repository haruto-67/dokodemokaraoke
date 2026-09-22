import type { AppContext } from '../appContext'
import type { ScreenHandle } from '../lib/screen'
import { el, clear } from '../lib/dom'
import { decodeAudio } from '../lib/audio'
import { parseLyricsLines } from '../lib/lyrics'
import { notifyError, bufferForSource } from '../lib/projectActions'
import { tokenizeLine } from '@shared/tokenize'
import { allocateTokenTimings, findPitchChangePoints, melodyRangeForLine } from '@shared/analysis/allocate'
import {
  createEmptyProject,
  DEFAULT_HOP_SEC,
  type AnalysisStepId,
  type AnalysisStepProgress,
  type DokokaraLine,
  type DokokaraProject
} from '@shared/types'
import type { EditorAudioState } from '../state/editorStore'
import type {
  AnalysisDoneEvent,
  AnalysisErrorEvent,
  AnalysisProgressEvent,
  AnalysisStartParams
} from '@shared/ipc'
import type { AnalyzeSidecarResult, AnalyzeSidecarLine } from '@shared/pythonSidecarProtocol'

const STEP_ORDER: AnalysisStepId[] = ['vocalIsolation', 'pitch', 'phrase', 'assign']

const STEP_LABELS: Record<AnalysisStepId, string> = {
  vocalIsolation: 'ボーカル/伴奏分離',
  pitch: 'F0抽出・ノート化',
  phrase: 'フレーズ区間検出',
  assign: '歌詞のタイミング付け'
}

// 検出されたフレーズ区間が歌詞行数より少ない場合、対応しなかった末尾の行に与える
// 仮の長さ(§4.4.7: 完全自動を目指さず、ユーザーが編集画面でドラッグして直す前提のプレースホルダー)。
const FALLBACK_LINE_DURATION_SEC = 2

function generateLineId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `line-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/**
 * 解析中画面(§3 画面 #2, §4.4)。
 * 準備画面(setupDraft)の内容を元にPythonサイドカーへ解析を依頼し、進捗を表示する。
 * 完了すると新規プロジェクトを編集画面へ引き渡す。
 */
export function mountAnalyzingScreen(container: HTMLElement, ctx: AppContext): ScreenHandle {
  const root = el('div', { className: 'analyzing-screen' })
  container.appendChild(root)

  const draft = ctx.ui.getState().setupDraft
  if (!draft.analysisAudio) {
    // 直接この画面へ遷移してしまった等の想定外ケース。準備画面へ戻す。
    ctx.navigate('setup')
    return { unmount() {} }
  }

  const stepStatus = new Map<AnalysisStepId, AnalysisStepProgress>()
  let cancelled = false
  let jobId: string | null = null
  let unsubscribe: (() => void) | null = null

  const header = el('h1', { className: 'analyzing-title' }, ['解析しています…'])
  const percentLabel = el('p', { className: 'analyzing-percent mono' }, ['0%'])
  const overallBar = el('div', { className: 'analyzing-progress' })
  const overallBarFill = el('div', { className: 'analyzing-progress-fill' })
  overallBar.appendChild(overallBarFill)
  const stepList = el('div', { className: 'analyzing-steps' })
  const detailLabel = el('p', { className: 'analyzing-detail mono' }, [''])
  const cancelBtn = el('button', { className: 'btn btn-ghost' }, ['キャンセル'])

  root.append(
    el('div', { className: 'analyzing-body' }, [
      el('div', { className: 'analyzing-spinner' }),
      header,
      percentLabel,
      overallBar,
      stepList,
      detailLabel,
      cancelBtn
    ])
  )

  function renderSteps(): void {
    clear(stepList)
    for (const id of STEP_ORDER) {
      const status = stepStatus.get(id)?.status ?? 'pending'
      const label = stepStatus.get(id)?.label ?? STEP_LABELS[id]
      const pill = el('span', { className: `step-pill${status === 'running' ? ' active' : ''}${status === 'done' ? ' done' : ''}` }, [
        label + (status === 'skipped' ? '(スキップ)' : '')
      ])
      stepList.appendChild(pill)
    }
  }
  renderSteps()

  // 解析全体(4ステップ)に占める進捗を概算で百分率化する(§5「解析中の操作性」、
  // 曲の解析は5〜10分かかるため所要時間の見通しを示す)。各ステップは均等ウェイトとし、
  // 完了/スキップ済みは1、実行中はサイドカーが送るprogress(0..1)、未着手は0として合算する。
  function computeOverallPercent(): number {
    let sum = 0
    for (const id of STEP_ORDER) {
      const s = stepStatus.get(id)
      if (!s) continue
      if (s.status === 'done' || s.status === 'skipped') sum += 1
      else if (s.status === 'running') sum += Math.min(1, Math.max(0, s.progress))
    }
    return Math.round((sum / STEP_ORDER.length) * 100)
  }

  function renderOverallPercent(): void {
    const pct = computeOverallPercent()
    percentLabel.textContent = `${pct}%`
    overallBarFill.style.width = `${pct}%`
  }

  function handleProgress(progress: AnalysisStepProgress): void {
    stepStatus.set(progress.id, progress)
    renderSteps()
    renderOverallPercent()
    detailLabel.textContent = progress.detail ?? ''
  }

  function stopListening(): void {
    unsubscribe?.()
    unsubscribe = null
  }

  function cleanupAndReturnToSetup(message?: string): void {
    if (cancelled) return
    cancelled = true
    stopListening()
    if (jobId) void window.dokokara.cancelAnalysis(jobId)
    if (message) notifyError(message)
    ctx.navigate('setup')
  }

  cancelBtn.addEventListener('click', () => cleanupAndReturnToSetup())

  void runAnalysis()

  async function runAnalysis(): Promise<void> {
    const analysisAudio = draft.analysisAudio!
    const lyricsLines = parseLyricsLines(draft.lyricsText, draft.removeSpaces)
    const totalDurationSec = analysisAudio.buffer.duration

    const offProgress = window.dokokara.onAnalysisProgress((event: AnalysisProgressEvent) => {
      if (event.jobId !== jobId) return
      handleProgress(event.progress)
    })
    const offDone = window.dokokara.onAnalysisDone((event: AnalysisDoneEvent) => {
      if (event.jobId !== jobId) return
      void finishAnalysis(event.result)
    })
    const offError = window.dokokara.onAnalysisError((event: AnalysisErrorEvent) => {
      if (event.jobId !== jobId) return
      cleanupAndReturnToSetup(`解析に失敗しました: ${event.message}`)
    })
    unsubscribe = () => {
      offProgress()
      offDone()
      offError()
    }

    const params: AnalysisStartParams = {
      sourceAudioPath: analysisAudio.path,
      lyricsLines,
      totalDurationSec
    }

    try {
      const result = await window.dokokara.startAnalysis(params)
      if (cancelled) {
        void window.dokokara.cancelAnalysis(result.jobId)
        return
      }
      jobId = result.jobId
    } catch (e) {
      cleanupAndReturnToSetup(`解析の開始に失敗しました: ${(e as Error).message}`)
    }
  }

  /** 歌詞行と自動アライメント結果を組み合わせ、トークン単位のタイミングまで含めて構築する(§4.4.7〜4.6.3)。 */
  function buildLyricsLines(
    lyricsLines: string[],
    aligned: AnalyzeSidecarLine[],
    notes: AnalyzeSidecarResult['notes'],
    f0Hz: Float32Array
  ): DokokaraLine[] {
    const onsetsSec = notes.map((n) => n.start)
    const frames = Array.from(f0Hz).map((hz, i) => ({ timeSec: i * DEFAULT_HOP_SEC, hz, voiced: hz > 0 }))
    const pitchChangePoints = findPitchChangePoints(frames)

    let fallbackCursor = aligned.length > 0 ? aligned[aligned.length - 1].end : 0

    return lyricsLines.map((text, i) => {
      const a: AnalyzeSidecarLine | undefined = aligned[i]
      let start: number
      let end: number
      let confidence: number | null
      if (a) {
        start = a.start
        end = a.end
        confidence = a.confidence
      } else {
        start = fallbackCursor
        end = start + FALLBACK_LINE_DURATION_SEC
        confidence = null
      }
      fallbackCursor = end

      const annotatedText = a?.annotatedText ?? text
      const tokenRange = melodyRangeForLine(start, end, notes)
      const timedTokens = allocateTokenTimings(tokenizeLine(annotatedText), tokenRange.start, tokenRange.end, {
        onsetsSec,
        pitchChangePoints,
        alignedReadingTokens: a?.tokenTimings
      })
      return {
        id: generateLineId(),
        text: annotatedText,
        start,
        end,
        tokens: timedTokens.map((t) => ({ text: t.text, ruby: t.ruby, start: t.start, end: t.end, locked: false })),
        confidence
      }
    })
  }

  async function finishAnalysis(result: AnalyzeSidecarResult): Promise<void> {
    if (cancelled) return
    stopListening()

    const analysisAudio = draft.analysisAudio!
    const lyricsLines = parseLyricsLines(draft.lyricsText, draft.removeSpaces)

    let vocalsData: ArrayBuffer
    let instrumentalData: ArrayBuffer
    let f0Data: ArrayBuffer
    try {
      ;[vocalsData, instrumentalData, f0Data] = await Promise.all([
        window.dokokara.readFileBuffer(result.vocalsPath),
        window.dokokara.readFileBuffer(result.instrumentalPath),
        window.dokokara.readFileBuffer(result.f0Path)
      ])
    } catch (e) {
      cleanupAndReturnToSetup(`解析結果の読み込みに失敗しました: ${(e as Error).message}`)
      return
    }

    const audioCtx = ctx.playback.audioContext
    let vocalsBuffer: AudioBuffer
    let instrumentalBuffer: AudioBuffer
    try {
      vocalsBuffer = await decodeAudio(audioCtx, vocalsData)
      instrumentalBuffer = await decodeAudio(audioCtx, instrumentalData)
    } catch (e) {
      cleanupAndReturnToSetup((e as Error).message)
      return
    }

    const f0Hz = new Float32Array(f0Data)

    const project: DokokaraProject = createEmptyProject(draft.projectName || '無題のプロジェクト')
    project.playback.defaultSource = ctx.settings.getState().defaultPerformSource
    project.audio.analysis = {
      originalFileName: analysisAudio.fileName,
      path: 'audio/vocal.wav',
      duration: vocalsBuffer.duration,
      sampleRate: vocalsBuffer.sampleRate
    }
    project.audio.playback = {
      originalFileName: analysisAudio.fileName,
      path: 'audio/off.wav',
      duration: instrumentalBuffer.duration,
      sampleRate: instrumentalBuffer.sampleRate
    }
    // 分離前の元音源(本家ミックス、§4.10「音声パターン」)。解析前に準備画面で読み込んだ
    // バッファ・ファイルをそのまま使う(Pythonサイドカーへの再問い合わせは不要)。
    project.audio.original = {
      originalFileName: analysisAudio.fileName,
      path: `audio/original${analysisAudio.ext}`,
      duration: analysisAudio.buffer.duration,
      sampleRate: analysisAudio.buffer.sampleRate
    }
    project.analysis.notes = result.notes
    project.analysis.phrases = result.phraseSegments
    project.analysis.frameCount = f0Hz.length
    project.lyrics = buildLyricsLines(lyricsLines, result.lyrics, result.notes, f0Hz)

    const audioState: EditorAudioState = {
      analysisBuffer: vocalsBuffer,
      playbackBuffer: instrumentalBuffer,
      originalBuffer: analysisAudio.buffer,
      analysisSourcePath: result.vocalsPath,
      playbackSourcePath: result.instrumentalPath,
      originalSourcePath: analysisAudio.path,
      analysisExt: '.wav',
      playbackExt: '.wav',
      originalExt: analysisAudio.ext
    }

    ctx.editor.loadProject(null, project, f0Hz, audioState)
    ctx.playback.setBuffer(bufferForSource(audioState, project.playback.defaultSource))
    ctx.navigate('editor')
  }

  return {
    unmount() {
      cancelled = true
      stopListening()
      if (jobId) void window.dokokara.cancelAnalysis(jobId)
      container.removeChild(root)
    }
  }
}
