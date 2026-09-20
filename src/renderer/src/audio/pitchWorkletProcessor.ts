/**
 * マイク入力のリアルタイムピッチ検出用AudioWorkletProcessor(要件定義書v3 §4.12.1)。
 * メインスレッドをブロックしないよう、YIN計算はAudioWorkletGlobalScope側で行い、
 * 結果(hz/rms)だけをport経由でメインスレッドへ送る。
 */
import { detectPitchYin } from '@shared/analysis/yin'

// 44.1kHzで約46ms相当。歌唱ピッチ検出として十分な時間分解能と、
// 低音域(70Hz)を検出するのに必要な最低限のウィンドウ長を両立する。
const FRAME_SIZE = 2048

class PitchDetectorProcessor extends AudioWorkletProcessor {
  private readonly buffer = new Float32Array(FRAME_SIZE)
  private writeIndex = 0

  process(inputs: Float32Array[][]): boolean {
    const channel = inputs[0]?.[0]
    if (!channel) return true

    for (let i = 0; i < channel.length; i++) {
      this.buffer[this.writeIndex++] = channel[i]
      if (this.writeIndex >= FRAME_SIZE) {
        this.writeIndex = 0
        this.analyzeAndPost()
      }
    }
    return true
  }

  private analyzeAndPost(): void {
    let sumSquares = 0
    for (let i = 0; i < this.buffer.length; i++) sumSquares += this.buffer[i] * this.buffer[i]
    const rms = Math.sqrt(sumSquares / this.buffer.length)
    const hz = detectPitchYin(this.buffer, sampleRate)
    this.port.postMessage({ hz, rms, time: currentTime })
  }
}

registerProcessor('pitch-detector-processor', PitchDetectorProcessor)
