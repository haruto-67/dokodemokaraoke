/**
 * マイク入力の取得とクリック音検出のセッション管理(要件定義書v3 §4.12.2 入出力遅延補正)。
 * 構造はmicPitchInput.tsとほぼ同じだが、YIN計算は行わずレンダークオンタム毎のRMSだけを
 * 受け取る(clickDetectorWorkletProcessor.ts)。getUserMediaのエラー判定は
 * micPitchInput.tsの`toMicPermissionError`/`MicPermissionError`をそのまま再利用する。
 */
import clickWorkletUrl from './clickDetectorWorkletProcessor.ts?worker&url'
import { MicPermissionError, toMicPermissionError } from './micPitchInput'

export interface ClickSample {
  rms: number
  /** AudioContext.currentTime基準の時刻(秒) */
  time: number
}

export interface ClickDetectionSession {
  /** 呼び出し元がこれと同じ時間軸(currentTime)でクリック音を再生するために公開する */
  readonly audioContext: AudioContext
  stop(): void
}

export { MicPermissionError }

/**
 * マイク入力を取得し、AudioWorkletでのクリック音検出(RMS監視)を開始する。
 * 戻り値のセッションは使い終わったら必ず`stop()`を呼び、マイクのトラックとAudioContextを解放すること。
 */
export async function startClickDetection(
  onSample: (sample: ClickSample) => void,
  options: { deviceId?: string | null } = {}
): Promise<ClickDetectionSession> {
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: options.deviceId ? { exact: options.deviceId } : undefined,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    })
  } catch (e) {
    throw toMicPermissionError(e)
  }

  const audioContext = new AudioContext()
  await audioContext.audioWorklet.addModule(clickWorkletUrl)

  const source = audioContext.createMediaStreamSource(stream)
  const workletNode = new AudioWorkletNode(audioContext, 'click-detector-processor')
  workletNode.port.onmessage = (event: MessageEvent<ClickSample>) => onSample(event.data)

  // destinationへ無音Gainを介して繋ぐ: マイク音がそのままスピーカーへ出てハウリングするのを防ぎつつ、
  // destinationに到達しないノードは処理自体が呼ばれない可能性があるWeb Audioのpullベース仕様を避ける。
  const silentGain = audioContext.createGain()
  silentGain.gain.value = 0
  source.connect(workletNode)
  workletNode.connect(silentGain)
  silentGain.connect(audioContext.destination)

  let stopped = false
  return {
    audioContext,
    stop(): void {
      if (stopped) return
      stopped = true
      workletNode.port.onmessage = null
      workletNode.disconnect()
      silentGain.disconnect()
      source.disconnect()
      stream.getTracks().forEach((track) => track.stop())
      void audioContext.close()
    }
  }
}
