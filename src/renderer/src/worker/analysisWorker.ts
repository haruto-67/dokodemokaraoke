/// <reference lib="webworker" />
// 解析パイプライン(§4.4)をレンダラのメインスレッドから切り離して実行するWorker(§8.2)。
import { runSignalAnalysis, assignLyricsTiming, type RunAnalysisInput } from '@shared/analysis/pipeline'
import type { AnalysisWorkerRequest, AnalysisWorkerResponse } from './analysisWorkerProtocol'

function post(message: AnalysisWorkerResponse, transfer: Transferable[] = []): void {
  postMessage(message, transfer)
}

addEventListener('message', (event: MessageEvent<AnalysisWorkerRequest>) => {
  const { analysis, playback, lyricsLines, totalDurationSec } = event.data

  try {
    const input: RunAnalysisInput = {
      analysis: {
        channels: analysis.channels.map((buf) => new Float32Array(buf)),
        sampleRate: analysis.sampleRate
      },
      playback: playback
        ? { channels: playback.channels.map((buf) => new Float32Array(buf)), sampleRate: playback.sampleRate }
        : null
    }

    const analysisResult = runSignalAnalysis(input, (progress) => {
      post({ type: 'progress', progress })
    })

    const lines = assignLyricsTiming(lyricsLines, analysisResult, totalDurationSec, (progress) => {
      post({ type: 'progress', progress })
    })

    const pitchHzBuffer = analysisResult.pitchHz.buffer as ArrayBuffer
    const onsetsSecBuffer = analysisResult.onsetsSec.buffer as ArrayBuffer

    post(
      {
        type: 'done',
        analysisResult: {
          alignmentOffsetSamples: analysisResult.alignmentOffsetSamples,
          vocalIsolationUsed: analysisResult.vocalIsolationUsed,
          pitchHz: pitchHzBuffer,
          hopSec: analysisResult.hopSec,
          onsetsSec: onsetsSecBuffer,
          phrases: analysisResult.phrases,
          logs: analysisResult.logs
        },
        lines
      },
      [pitchHzBuffer, onsetsSecBuffer]
    )
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) })
  }
})
