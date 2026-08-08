/** AudioBuffer から軽量なピーク配列（0..1）を生成する。ホーム画面サムネイルや波形背景描画に使う。 */
export function buildWaveformPeaks(buffer: AudioBuffer, bucketCount: number): number[] {
  const channelCount = buffer.numberOfChannels
  const length = buffer.length
  const bucketSize = Math.max(1, Math.floor(length / bucketCount))
  const peaks: number[] = new Array(bucketCount).fill(0)

  const channelData: Float32Array[] = []
  for (let c = 0; c < channelCount; c++) channelData.push(buffer.getChannelData(c))

  for (let b = 0; b < bucketCount; b++) {
    const start = b * bucketSize
    const end = Math.min(length, start + bucketSize)
    let max = 0
    for (let c = 0; c < channelCount; c++) {
      const data = channelData[c]
      for (let i = start; i < end; i++) {
        const v = Math.abs(data[i])
        if (v > max) max = v
      }
    }
    peaks[b] = max
  }

  const globalMax = Math.max(...peaks, 0.0001)
  return peaks.map((v) => Math.min(1, v / globalMax))
}
