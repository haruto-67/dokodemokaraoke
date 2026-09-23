import { PitchShifter } from 'soundtouchjs'

// PitchShifterのScriptProcessorNode一回あたりのサンプル数。小さいほど遅延は減るがCPU負荷・
// グリッチのリスクが増える。BGM再生用途では音切れの起きにくさを優先しやや大きめにする。
const PITCH_SHIFTER_BUFFER_SIZE = 4096

/** soundtouchjs の percentagePlayed は名前に反して 0..100 ではなく 0..1 の割合を受け取る。 */
export function playbackFractionForOffset(offsetSec: number, durationSec: number): number {
  if (!Number.isFinite(offsetSec) || !Number.isFinite(durationSec) || durationSec <= 0) return 0
  return Math.max(0, Math.min(1, offsetSec / durationSec))
}

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
  // 使い、0以外の時だけPitchShifter(soundtouchjs)経路に切り替える。tempoは再生速度(rate、既定1)で、
  // 実時間×rateが処理済み音声の曲中位置に一致するため、getCurrentTime()の時刻計算
  // (audioContext.currentTimeベース)は経路によらずそのまま使い回せる(PitchShifter自身のtimePlayedには依存しない)。
  private pitchShiftSemitones = 0
  // 再生速度(編集画面で低速再生しながらタイミングを合わせる用途)。1以外の時もPitchShifter経路を使い、
  // tempoだけを変えて音程は保つ。経過時間はaudioContext時間×rateで曲中の位置に換算する。
  private rate = 1
  private shifter: PitchShifter | null = null
  private overlayShifter: PitchShifter | null = null
  // soundtouchjsのPitchShifterは、コンストラクタに渡したonEndコールバックを内部の
  // ScriptProcessorNode(のonaudioprocess)に直接焼き込んでおり、.off()/.disconnect()では
  // 無効化できない(off()は別系統の'play'イベントリスナーにしか効かない)。disconnect()後も
  // 既にオーディオスレッド側でスケジュール済みのonaudioprocessが1回だけ遅れて発火し、
  // 古いshifterのonEnd(=曲終了扱い)が呼ばれてしまうことがある(キー変更のたびに新しい
  // shifterを作り直す都合上、これが「キー変更すると曲が途中で終了判定になる」不具合の原因)。
  // stopSourceOnly()でこのガードをfalseにしてから捨てることで、遅延発火を無視できるようにする。
  private shifterEndedGuard: { active: boolean } | null = null
  // 未来の時刻(startAtCtxTime)から再生を開始する場合(§4.12カウントイン/キー提示のプリロール、
  // performScreen.ts参照)、PitchShifter経路にはAudioBufferSourceNode.start(when)のような
  // ネイティブの将来スケジューリングが無いため、connect()自体をsetTimeoutで遅らせて模する。
  // stopSourceOnly()が先に呼ばれた場合はこのタイマーを確実に解除し、破棄済みshifterが
  // 遅れてconnectされて音が漏れることを防ぐ。
  private pendingShifterConnectTimeoutIds: ReturnType<typeof setTimeout>[] = []

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

  /** 再生速度(1=等速)を設定する。再生中なら同じ位置から新しい速度で再生し直す。 */
  setPlaybackRate(rate: number): void {
    const wasPlaying = this.playing
    const t = this.getCurrentTime()
    this.stopSourceOnly()
    this.rate = rate
    this.startOffsetSec = t
    if (wasPlaying) this.play(t)
  }

  getPlaybackRate(): number {
    return this.rate
  }

  /**
   * 指定バッファを、現在の移調設定に応じてAudioBufferSourceNodeかPitchShifterのいずれかで
   * offsetSec位置から再生開始する。onEndedはAudioBufferSourceNode経路でのみ発火する
   * (メイン音源のみ終了検知が必要で、オーバーレイ側はnullを渡す想定)。`startAt`は再生を
   * 開始するAudioContext時刻(絶対値)。現在時刻以前ならそのまま即座に開始する。
   */
  private startNode(
    buffer: AudioBuffer,
    offsetSec: number,
    destination: GainNode,
    onEnded: (() => void) | null,
    startAt: number
  ): { source: AudioBufferSourceNode | null; shifter: PitchShifter | null; endedGuard: { active: boolean } | null } {
    if (this.pitchShiftSemitones !== 0 || this.rate !== 1) {
      const endedGuard = onEnded ? { active: true } : null
      const shifter = new PitchShifter(this.audioContext, buffer, PITCH_SHIFTER_BUFFER_SIZE, () => {
        if (endedGuard && !endedGuard.active) return
        onEnded?.()
      })
      shifter.tempo = this.rate
      shifter.pitchSemitones = this.pitchShiftSemitones
      shifter.percentagePlayed = playbackFractionForOffset(offsetSec, buffer.duration)
      const delayMs = (startAt - this.audioContext.currentTime) * 1000
      if (delayMs > 0) {
        const timeoutId = setTimeout(() => {
          this.pendingShifterConnectTimeoutIds = this.pendingShifterConnectTimeoutIds.filter((id) => id !== timeoutId)
          shifter.connect(destination)
        }, delayMs)
        this.pendingShifterConnectTimeoutIds.push(timeoutId)
      } else {
        shifter.connect(destination)
      }
      return { source: null, shifter, endedGuard }
    }
    const src = this.audioContext.createBufferSource()
    src.buffer = buffer
    src.connect(destination)
    src.start(Math.max(startAt, this.audioContext.currentTime), offsetSec)
    if (onEnded) src.onended = onEnded
    return { source: src, shifter: null, endedGuard: null }
  }

  /**
   * `startAtCtxTime`(省略時は現在時刻)から再生を開始する。未来の時刻を指定すると、
   * その時刻まで無音のまま待ってから再生が始まる(§4.12カウントイン/キー提示のプリロール、
   * performScreen.tsのstartPlayback()参照)。getCurrentTime()はこの間、負の値
   * (=「あと何秒で曲の実際の頭に到達するか」)を返す。
   */
  play(fromSec?: number, startAtCtxTime?: number): void {
    if (!this.buffer) return
    if (this.audioContext.state === 'suspended') void this.audioContext.resume()
    this.stopSourceOnly()
    const offset = Math.max(0, Math.min(fromSec ?? this.getCurrentTime(), this.buffer.duration))
    const startAt = Math.max(this.audioContext.currentTime, startAtCtxTime ?? this.audioContext.currentTime)

    const main = this.startNode(
      this.buffer,
      offset,
      this.gainNode,
      () => {
        this.playing = false
        this.endedCallback?.()
      },
      startAt
    )
    this.source = main.source
    this.shifter = main.shifter
    this.shifterEndedGuard = main.endedGuard
    this.startedAtCtxTime = startAt
    this.startOffsetSec = offset
    this.playing = true

    if (this.overlayBuffer) {
      const overlay = this.startNode(
        this.overlayBuffer,
        Math.min(offset, this.overlayBuffer.duration),
        this.overlayGainNode,
        null,
        startAt
      )
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
    for (const id of this.pendingShifterConnectTimeoutIds) clearTimeout(id)
    this.pendingShifterConnectTimeoutIds = []
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
      if (this.shifterEndedGuard) this.shifterEndedGuard.active = false
      this.shifterEndedGuard = null
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
      return this.startOffsetSec + (this.audioContext.currentTime - this.startedAtCtxTime) * this.rate
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
