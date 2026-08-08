/** AudioBufferから各チャンネルのPCMデータを取り出す。Workerへtransferする前提でコピーを返す。 */
export function extractChannelData(buffer: AudioBuffer): { channels: Float32Array[]; sampleRate: number } {
  const channels: Float32Array[] = []
  for (let i = 0; i < buffer.numberOfChannels; i++) channels.push(buffer.getChannelData(i).slice())
  return { channels, sampleRate: buffer.sampleRate }
}

/** §4.12: デコード失敗時に原因が分かるメッセージを投げる */
export async function decodeAudio(ctx: BaseAudioContext, data: ArrayBuffer): Promise<AudioBuffer> {
  try {
    return await ctx.decodeAudioData(data.slice(0))
  } catch {
    throw new Error(
      '音声ファイルのデコードに失敗しました。非対応の形式か、ファイルが破損している可能性があります（対応形式: wav / mp3 / m4a / flac）。'
    )
  }
}

/**
 * 単一の AudioContext 上で再生ソースを切り替え可能な再生エンジン。
 * §4.11: オフセットは表示系のみに適用するため、ここでは音声の開始時刻には一切関与しない。
 */
export class PlaybackEngine {
  readonly audioContext: AudioContext
  private gainNode: GainNode
  private source: AudioBufferSourceNode | null = null
  private buffer: AudioBuffer | null = null
  private startedAtCtxTime = 0
  private startOffsetSec = 0
  private playing = false
  private endedCallback: (() => void) | null = null

  constructor() {
    this.audioContext = new AudioContext()
    this.gainNode = this.audioContext.createGain()
    this.gainNode.connect(this.audioContext.destination)
  }

  onEnded(cb: (() => void) | null): void {
    this.endedCallback = cb
  }

  /** バッファを切り替える。再生中であれば現在位置を保ったまま新バッファで再生継続する。 */
  setBuffer(buffer: AudioBuffer | null): void {
    const wasPlaying = this.playing
    const t = this.getCurrentTime()
    this.stopSourceOnly()
    this.buffer = buffer
    this.startOffsetSec = Math.min(t, buffer?.duration ?? t)
    if (wasPlaying && buffer) this.play(this.startOffsetSec)
  }

  play(fromSec?: number): void {
    if (!this.buffer) return
    if (this.audioContext.state === 'suspended') void this.audioContext.resume()
    this.stopSourceOnly()
    const offset = Math.max(0, Math.min(fromSec ?? this.getCurrentTime(), this.buffer.duration))
    const src = this.audioContext.createBufferSource()
    src.buffer = this.buffer
    src.connect(this.gainNode)
    src.start(0, offset)
    this.source = src
    this.startedAtCtxTime = this.audioContext.currentTime
    this.startOffsetSec = offset
    this.playing = true
    src.onended = () => {
      if (this.source === src) {
        this.playing = false
        this.endedCallback?.()
      }
    }
  }

  pause(): void {
    const t = this.getCurrentTime()
    this.stopSourceOnly()
    this.startOffsetSec = t
    this.playing = false
  }

  seek(sec: number): void {
    const wasPlaying = this.playing
    const clamped = Math.max(0, Math.min(sec, this.buffer?.duration ?? sec))
    this.stopSourceOnly()
    this.startOffsetSec = clamped
    if (wasPlaying) this.play(clamped)
  }

  private stopSourceOnly(): void {
    if (this.source) {
      this.source.onended = null
      try {
        this.source.stop()
      } catch {
        /* already stopped */
      }
      this.source.disconnect()
      this.source = null
    }
  }

  getCurrentTime(): number {
    if (this.playing) {
      return this.startOffsetSec + (this.audioContext.currentTime - this.startedAtCtxTime)
    }
    return this.startOffsetSec
  }

  isPlaying(): boolean {
    return this.playing
  }

  get duration(): number {
    return this.buffer?.duration ?? 0
  }

  dispose(): void {
    this.stopSourceOnly()
    void this.audioContext.close()
  }
}
