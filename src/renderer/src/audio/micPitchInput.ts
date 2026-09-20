/**
 * マイク入力の取得とリアルタイムピッチ検出のセッション管理(要件定義書v3 §4.12.1)。
 * 実際のYIN計算はAudioWorkletで行う(pitchWorkletProcessor.ts)。ここではgetUserMediaでの
 * 権限取得・AudioContext/AudioWorkletNodeの配線・後片付けだけを担当する。
 *
 * AudioWorkletにVite標準の`new URL(path, import.meta.url)`は使えない
 * (Viteがバンドル対象と認識するのは`new Worker(...)`直下の場合のみで、生の相対URL参照は
 * ビルド時に素通りしてしまい実機で404になることを確認済み)。Workerバンドルパイプラインを
 * 流用する`?worker&url`サフィックス(vite/client.d.tsで型定義済み)でビルド済みJSのURLを得る。
 */
import pitchWorkletUrl from './pitchWorkletProcessor.ts?worker&url'

export interface PitchSample {
  hz: number
  rms: number
  /** AudioContext.currentTime基準の時刻(秒) */
  time: number
}

export interface MicPitchSession {
  /** クリック音再生など、同じ時間軸(currentTime)で操作したい呼び出し元向けに公開する */
  readonly audioContext: AudioContext
  stop(): void
}

export type MicPermissionErrorKind = 'permission_denied' | 'no_device' | 'unknown'

/**
 * マイク権限拒否・デバイス不在時にthrowされる。呼び出し側はこれをcatchして、
 * 採点なしで本番再生を続行できるようにする(§4.12.1「マイク権限が拒否されている場合は、
 * 採点なしで本番再生を続行できること」)。
 */
export class MicPermissionError extends Error {
  readonly kind: MicPermissionErrorKind
  constructor(kind: MicPermissionErrorKind, message: string) {
    super(message)
    this.name = 'MicPermissionError'
    this.kind = kind
  }
}

/** micClickDetection.tsでも同じgetUserMediaエラー判定を再利用するためexportする */
export function toMicPermissionError(e: unknown): MicPermissionError {
  const err = e as DOMException
  if (err?.name === 'NotAllowedError' || err?.name === 'SecurityError') {
    return new MicPermissionError('permission_denied', 'マイクの使用が許可されていません')
  }
  if (err?.name === 'NotFoundError' || err?.name === 'OverconstrainedError') {
    return new MicPermissionError('no_device', '指定されたマイクが見つかりません')
  }
  return new MicPermissionError('unknown', err?.message || 'マイクの初期化に失敗しました')
}

/**
 * マイク入力を取得し、AudioWorkletでのリアルタイムピッチ検出を開始する。
 * 戻り値のセッションは使い終わったら必ず`stop()`を呼び、マイクのトラックとAudioContextを解放すること。
 */
export async function startMicPitchDetection(
  onSample: (sample: PitchSample) => void,
  options: { deviceId?: string | null } = {}
): Promise<MicPitchSession> {
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
  await audioContext.audioWorklet.addModule(pitchWorkletUrl)

  const source = audioContext.createMediaStreamSource(stream)
  const workletNode = new AudioWorkletNode(audioContext, 'pitch-detector-processor')
  workletNode.port.onmessage = (event: MessageEvent<PitchSample>) => onSample(event.data)

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

/**
 * 入力デバイス一覧を取得する(設定画面のデバイス選択用)。ラベルは事前に
 * マイク権限を得ていないと空文字になることがある(ブラウザ標準の挙動)。
 */
export async function listMicInputDevices(): Promise<MediaDeviceInfo[]> {
  const devices = await navigator.mediaDevices.enumerateDevices()
  return devices.filter((d) => d.kind === 'audioinput')
}
