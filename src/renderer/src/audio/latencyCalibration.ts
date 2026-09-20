/**
 * 入出力遅延のキャリブレーション(要件定義書v3 §4.12.2)。
 *
 * 手順: (1) クリック音を鳴らす前の環境ノイズフロアを一定時間測る → (2) 短いクリック音を
 * 再生し、鳴らし始めた時刻(AudioContext.currentTime)を記録する → (3) マイクの入力レベルが
 * ノイズフロアを一定以上超えた最初の時刻を「聞こえた時刻」とみなし、その差分を往復遅延とする。
 *
 * クリック再生とマイク監視を**同一のAudioContext**上で行うことが重要(異なるAudioContext同士は
 * currentTimeの原点が揃っている保証が無く、時刻の引き算が意味を持たない)。そのため
 * micClickDetection.tsのセッションが公開する`audioContext`上でクリックを再生する。
 *
 * この値は`playback.offsetMs`(§4.11、曲ごとの字幕表示用オフセット)とは別物であり、
 * アプリ設定(AppSettings.micLatencyCompensationMs)としてプロジェクトを跨いで保持する。
 */
import { startClickDetection, type ClickDetectionSession, type ClickSample } from './micClickDetection'

export interface LatencyCalibrationResult {
  latencyMs: number
}

const NOISE_SAMPLE_SEC = 0.3
const CLICK_LEAD_SEC = 0.15
const CLICK_DURATION_SEC = 0.03
const CAPTURE_TIMEOUT_SEC = 2
const POLL_INTERVAL_MS = 20
/** ノイズフロアに対してこれだけ上乗せしたRMSを「クリック音が聞こえた」とみなす閾値にする */
const THRESHOLD_MARGIN = 0.03

export async function runLatencyCalibration(options: { deviceId?: string | null } = {}): Promise<LatencyCalibrationResult> {
  let noiseFloor = 0
  let clickScheduledAt: number | null = null
  let detectedAt: number | null = null

  const session: ClickDetectionSession = await startClickDetection((sample: ClickSample) => {
    if (clickScheduledAt === null) {
      noiseFloor = Math.max(noiseFloor, sample.rms)
      return
    }
    if (detectedAt !== null) return
    if (sample.time < clickScheduledAt) return
    if (sample.rms >= noiseFloor + THRESHOLD_MARGIN) detectedAt = sample.time
  }, options)

  try {
    await sleep(NOISE_SAMPLE_SEC * 1000)

    const ctx = session.audioContext
    clickScheduledAt = ctx.currentTime + CLICK_LEAD_SEC
    playClick(ctx, clickScheduledAt)

    const deadline = clickScheduledAt + CAPTURE_TIMEOUT_SEC
    while (detectedAt === null && ctx.currentTime < deadline) {
      await sleep(POLL_INTERVAL_MS)
    }

    if (detectedAt === null) {
      throw new Error('クリック音を検出できませんでした。スピーカーとマイクの音量を確認してください。')
    }

    const latencySec = (detectedAt as number) - clickScheduledAt
    return { latencyMs: Math.max(0, Math.round(latencySec * 1000)) }
  } finally {
    session.stop()
  }
}

function playClick(ctx: AudioContext, when: number): void {
  const osc = ctx.createOscillator()
  osc.type = 'square'
  osc.frequency.value = 1000
  const gain = ctx.createGain()
  gain.gain.setValueAtTime(0.9, when)
  gain.gain.setValueAtTime(0, when + CLICK_DURATION_SEC)
  osc.connect(gain)
  gain.connect(ctx.destination)
  osc.start(when)
  osc.stop(when + CLICK_DURATION_SEC + 0.02)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
