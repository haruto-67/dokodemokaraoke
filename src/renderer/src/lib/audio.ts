import { PitchShifter } from 'soundtouchjs'

// PitchShifterのScriptProcessorNode一回あたりのサンプル数。小さいほど遅延は減るがCPU負荷・
// グリッチのリスクが増える。BGM再生用途では音切れの起きにくさを優先しやや大きめにする。
const PITCH_SHIFTER_BUFFER_SIZE = 4096

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
      '音声ファイルのデコードに失敗しました。非対応の形式か、ファイルが破損している可能性があります（対応形式: wav / mp3 / m4a / flac / aac / ogg）。'
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

  // ガイドボーカル(§4.12、分離済みボーカル音源を伴奏に重ねて流すオプション)用のオーバーレイ再生。
  // メインのsource/bufferと全く同じ考え方で、常に同じ位置・タイミングで開始/停止/シークする
  // (タイミングロジックを重複させドリフトさせないよう、既存のplay/pause/seekにそのまま相乗りする)。
  private overlayGainNode: GainNode
  private overlaySource: AudioBufferSourceNode | null = null
  private overlayBuffer: AudioBuffer | null = null

  // キー変更(移調、§4.12)。0の間は通常のAudioBufferSourceNode経路(音質劣化・CPU負荷が無い)を
  // 使い、0以外の時だけPitchShifter(soundtouchjs)経路に切り替える。tempoは常に1に固定して
  // テンポは変えずピッチだけシフトする。tempo=1である限り、実時間と処理済み音声の長さが
  // 1:1で一致するため、getCurrentTime()の時刻計算(audioContext.currentTimeベース)は
  // 経路によらずそのまま使い回せる(PitchShifter自身のtimePlayedには依存しない)。
  private pitchShiftSemitones = 0
  private shifter: PitchShifter | null = null
  private overlayShifter: PitchShifter | null = null

  constructor() {
    this.audioContext = new AudioContext()
    this.gainNode = this.audioContext.createGain()
    this.gainNode.connect(this.audioContext.destination)
    this.overlayGainNode = this.audioContext.createGain()
    this.overlayGainNode.gain.value = 0
    this.overlayGainNode.connect(this.audioContext.destination)
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

  /** ガイドボーカル用の重ね合わせバッファ。nullで無効(オーバーレイ無し)。 */
  setOverlayBuffer(buffer: AudioBuffer | null): void {
    const wasPlaying = this.playing
    this.overlayBuffer = buffer
    if (wasPlaying) this.play(this.getCurrentTime())
  }

  /** ガイドボーカルの音量(0..1)。setOverlayBufferとは独立に、再生中でも即座に変更できる。 */
  setOverlayVolume(volume: number): void {
    this.overlayGainNode.gain.value = Math.max(0, Math.min(1, volume))
  }

  /** キー変更(移調)量を半音単位で設定する。0で通常再生に戻る。再生中なら同じ位置で経路を切り替える。 */
  setPitchShiftSemitones(semitones: number): void {
    const wasPlaying = this.playing
    const t = this.getCurrentTime()
    this.stopSourceOnly()
    this.pitchShiftSemitones = semitones
    if (wasPlaying) this.play(t)
  }

  getPitchShiftSemitones(): number {
    return this.pitchShiftSemitones
  }

  /**
   * 指定バッファを、現在の移調設定に応じてAudioBufferSourceNodeかPitchShifterのいずれかで
   * offsetSec位置から再生開始する。onEndedはAudioBufferSourceNode経路でのみ発火する
   * (メイン音源のみ終了検知が必要で、オーバーレイ側はnullを渡す想定)。
   */
  private startNode(
    buffer: AudioBuffer,
    offsetSec: number,
    destination: GainNode,
    onEnded: (() => void) | null
  ): { source: AudioBufferSourceNode | null; shifter: PitchShifter | null } {
    if (this.pitchShiftSemitones !== 0) {
      const shifter = new PitchShifter(this.audioContext, buffer, PITCH_SHIFTER_BUFFER_SIZE, () => onEnded?.())
      shifter.tempo = 1
      shifter.pitchSemitones = this.pitchShiftSemitones
      shifter.percentagePlayed = buffer.duration > 0 ? (offsetSec / buffer.duration) * 100 : 0
      shifter.connect(destination)
      return { source: null, shifter }
    }
    const src = this.audioContext.createBufferSource()
    src.buffer = buffer
    src.connect(destination)
    src.start(0, offsetSec)
    if (onEnded) src.onended = onEnded
    return { source: src, shifter: null }
  }

  play(fromSec?: number): void {
    if (!this.buffer) return
    if (this.audioContext.state === 'suspended') void this.audioContext.resume()
    this.stopSourceOnly()
    const offset = Math.max(0, Math.min(fromSec ?? this.getCurrentTime(), this.buffer.duration))

    const main = this.startNode(this.buffer, offset, this.gainNode, () => {
      this.playing = false
      this.endedCallback?.()
    })
    this.source = main.source
    this.shifter = main.shifter
    this.startedAtCtxTime = this.audioContext.currentTime
    this.startOffsetSec = offset
    this.playing = true

    if (this.overlayBuffer) {
      const overlay = this.startNode(this.overlayBuffer, Math.min(offset, this.overlayBuffer.duration), this.overlayGainNode, null)
      this.overlaySource = overlay.source
      this.overlayShifter = overlay.shifter
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
    if (this.shifter) {
      this.shifter.off()
      this.shifter.disconnect()
      this.shifter = null
    }
    if (this.overlaySource) {
      try {
        this.overlaySource.stop()
      } catch {
        /* already stopped */
      }
      this.overlaySource.disconnect()
      this.overlaySource = null
    }
    if (this.overlayShifter) {
      this.overlayShifter.off()
      this.overlayShifter.disconnect()
      this.overlayShifter = null
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
