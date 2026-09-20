/**
 * 入出力遅延補正(要件定義書v3 §4.12.2)用のクリック音検出AudioWorkletProcessor。
 * ピッチ検出(pitchWorkletProcessor.ts)とは異なりFRAME_SIZE単位で貯め込まず、
 * レンダークオンタム(通常128サンプル、約2.9ms@44.1kHz)ごとにRMSを都度送ることで、
 * 遅延測定に必要な数ミリ秒単位の時間分解能を確保する。
 */

class ClickDetectorProcessor extends AudioWorkletProcessor {
  process(inputs: Float32Array[][]): boolean {
    const channel = inputs[0]?.[0]
    if (!channel) return true

    let sumSquares = 0
    for (let i = 0; i < channel.length; i++) sumSquares += channel[i] * channel[i]
    const rms = Math.sqrt(sumSquares / channel.length)
    this.port.postMessage({ rms, time: currentTime })
    return true
  }
}

registerProcessor('click-detector-processor', ClickDetectorProcessor)
