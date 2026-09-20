// AudioWorkletGlobalScope(pitchWorkletProcessor.ts)専用の最小限のアンビエント型。
// TypeScript標準libにAudioWorkletGlobalScopeの型は含まれないため自前で宣言する
// (レンダラの他コード全体からも見えてしまうが、このプロジェクト規模では
// 専用tsconfigを分ける複雑さに見合わないため許容する)。

declare const sampleRate: number
declare const currentTime: number

declare class AudioWorkletProcessor {
  readonly port: MessagePort
  constructor(options?: AudioWorkletNodeOptions)
  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean
}

declare function registerProcessor(
  name: string,
  processorCtor: new (options?: AudioWorkletNodeOptions) => AudioWorkletProcessor
): void
