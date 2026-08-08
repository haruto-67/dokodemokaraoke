import type { AppContext } from '../appContext'
import type { ScreenHandle } from '../lib/screen'
import { el, clear } from '../lib/dom'
import { extractChannelData } from '../lib/audio'
import { parseLyricsLines } from '../lib/lyrics'
import { notifyError } from '../lib/projectActions'
import { createEmptyProject, type AnalysisStepId, type AnalysisStepProgress, type DokokaraProject } from '@shared/types'
import type { EditorAudioState } from '../state/editorStore'
import type { AnalysisWorkerRequest, AnalysisWorkerResponse } from '../worker/analysisWorkerProtocol'
import AnalysisWorker from '../worker/analysisWorker?worker'

const STEP_ORDER: AnalysisStepId[] = [
  'alignment',
  'vocalIsolation',
  'preprocess',
  'pitch',
  'onset',
  'phrase',
  'assign',
  'tokenAllocate'
]

const STEP_LABELS: Record<AnalysisStepId, string> = {
  alignment: 'STEP1 時間軸アライメント',
  vocalIsolation: 'STEP2 差分ボーカル抽出',
  preprocess: 'STEP3 前処理',
  pitch: 'STEP4 ピッチ検出',
  onset: 'STEP5 オンセット検出',
  phrase: 'STEP6 フレーズ区間検出',
  assign: 'STEP7 歌詞行への割り当て',
  tokenAllocate: 'STEP8 文字タイミング配分'
}

/**
 * 解析中画面(§3 画面 #2, §4.4)。
 * 準備画面(setupDraft)の内容を元にWorkerで解析パイプラインを実行し、進捗を表示する。
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
  let worker: Worker | null = null

  const header = el('h1', { className: 'analyzing-title' }, ['解析しています…'])
  const stepList = el('div', { className: 'analyzing-steps' })
  const detailLabel = el('p', { className: 'analyzing-detail mono' }, [''])
  const cancelBtn = el('button', { className: 'btn btn-ghost' }, ['キャンセル'])

  root.append(
    el('div', { className: 'analyzing-body' }, [
      el('div', { className: 'analyzing-spinner' }),
      header,
      stepList,
      detailLabel,
      cancelBtn
    ])
  )

  function renderSteps(): void {
    clear(stepList)
    for (const id of STEP_ORDER) {
      const status = stepStatus.get(id)?.status ?? 'pending'
      const pill = el('span', { className: `step-pill${status === 'running' ? ' active' : ''}${status === 'done' ? ' done' : ''}` }, [
        STEP_LABELS[id] + (status === 'skipped' ? '(スキップ)' : '')
      ])
      stepList.appendChild(pill)
    }
  }
  renderSteps()

  function handleProgress(progress: AnalysisStepProgress): void {
    stepStatus.set(progress.id, progress)
    renderSteps()
    detailLabel.textContent = progress.detail ?? ''
  }

  function cleanupAndReturnToSetup(message?: string): void {
    if (cancelled) return
    cancelled = true
    worker?.terminate()
    if (message) notifyError(message)
    ctx.navigate('setup')
  }

  cancelBtn.addEventListener('click', () => cleanupAndReturnToSetup())

  void runAnalysis()

  async function runAnalysis(): Promise<void> {
    const analysisAudio = draft.analysisAudio!
    const playbackAudio = draft.playbackAudio
    const lyricsLines = parseLyricsLines(draft.lyricsText, draft.removeSpaces)

    const { channels: analysisChannels, sampleRate: analysisSampleRate } = extractChannelData(analysisAudio.buffer)
    const playbackExtracted = playbackAudio ? extractChannelData(playbackAudio.buffer) : null

    const totalDurationSec = playbackAudio ? playbackAudio.buffer.duration : analysisAudio.buffer.duration

    worker = new AnalysisWorker()
    const w = worker

    w.onmessage = (event: MessageEvent<AnalysisWorkerResponse>) => {
      if (cancelled) return
      const msg = event.data
      if (msg.type === 'progress') {
        handleProgress(msg.progress)
        return
      }
      if (msg.type === 'error') {
        cleanupAndReturnToSetup(`解析に失敗しました: ${msg.message}`)
        return
      }
      // msg.type === 'done'
      finishAnalysis(msg)
    }
    w.onerror = (event: ErrorEvent) => {
      cleanupAndReturnToSetup(`解析処理中にエラーが発生しました: ${event.message}`)
    }

    const request: AnalysisWorkerRequest = {
      analysis: { channels: analysisChannels.map((c) => c.buffer as ArrayBuffer), sampleRate: analysisSampleRate },
      playback: playbackExtracted
        ? { channels: playbackExtracted.channels.map((c) => c.buffer as ArrayBuffer), sampleRate: playbackExtracted.sampleRate }
        : null,
      lyricsLines,
      totalDurationSec
    }
    const transferList: Transferable[] = [
      ...request.analysis.channels,
      ...(request.playback?.channels ?? [])
    ]
    w.postMessage(request, transferList)
  }

  function finishAnalysis(msg: Extract<AnalysisWorkerResponse, { type: 'done' }>): void {
    if (cancelled) return
    const analysisAudio = draft.analysisAudio!
    const playbackAudio = draft.playbackAudio

    const project: DokokaraProject = createEmptyProject(draft.projectName || '無題のプロジェクト')
    project.audio.analysis = {
      originalFileName: analysisAudio.fileName,
      path: `audio/vocal${analysisAudio.ext}`,
      duration: analysisAudio.buffer.duration,
      sampleRate: analysisAudio.buffer.sampleRate
    }
    project.audio.playback = playbackAudio
      ? {
          originalFileName: playbackAudio.fileName,
          path: `audio/off${playbackAudio.ext}`,
          duration: playbackAudio.buffer.duration,
          sampleRate: playbackAudio.buffer.sampleRate
        }
      : null
    project.audio.alignmentOffsetSamples = msg.analysisResult.alignmentOffsetSamples
    project.analysis.vocalIsolation = msg.analysisResult.vocalIsolationUsed
    project.analysis.hopSec = msg.analysisResult.hopSec
    project.analysis.frameCount = msg.analysisResult.pitchHz.byteLength / Float32Array.BYTES_PER_ELEMENT
    project.analysis.phrases = msg.analysisResult.phrases
    project.lyrics = msg.lines

    const audioState: EditorAudioState = {
      analysisBuffer: analysisAudio.buffer,
      playbackBuffer: playbackAudio?.buffer ?? null,
      analysisSourcePath: analysisAudio.path,
      playbackSourcePath: playbackAudio?.path ?? null,
      analysisExt: analysisAudio.ext,
      playbackExt: playbackAudio?.ext ?? null
    }

    const pitchHz = new Float32Array(msg.analysisResult.pitchHz)
    const onsetsSec = new Float32Array(msg.analysisResult.onsetsSec)

    ctx.editor.loadProject(null, project, pitchHz, onsetsSec, audioState)
    ctx.playback.setBuffer(
      project.playback.defaultSource === 'analysis' ? audioState.analysisBuffer : audioState.playbackBuffer ?? audioState.analysisBuffer
    )
    ctx.navigate('editor')
  }

  return {
    unmount() {
      cancelled = true
      worker?.terminate()
      container.removeChild(root)
    }
  }
}
