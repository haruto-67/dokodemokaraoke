// soundtouchjs(https://github.com/cutterbl/SoundTouchJS)には型定義が同梱されておらず、
// @types/soundtouchjsも存在しないため、実際に使う部分だけ最小限のアンビエント宣言を用意する。
declare module 'soundtouchjs' {
  export class PitchShifter {
    constructor(context: AudioContext, buffer: AudioBuffer, bufferSize: number, onEnd?: () => void)
    tempo: number
    rate: number
    pitch: number
    pitchSemitones: number
    percentagePlayed: number
    readonly duration: number
    readonly node: AudioNode
    connect(toNode: AudioNode): void
    disconnect(): void
    on(eventName: string, cb: (detail: unknown) => void): void
    off(eventName?: string): void
  }
}
