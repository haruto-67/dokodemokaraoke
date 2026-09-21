/**
 * 本番画面用の効果音(§4.12「カウントインに音を追加する」「キー提示」)。
 * 外部音声ファイルは使わず、Web Audioのオシレーターでその場合成する
 * (要件側でも「コード内蔵の簡易シンセ音でよい」と明示されている)。
 * 再生に使うAudioContextは`ctx.playback.audioContext`(曲再生と共有)をそのまま渡す想定。
 */

/** カウントダウンの数字が切り替わるたびに鳴らす、メトロノーム的な短いクリック音。 */
export function playCountInClick(audioContext: AudioContext): void {
  const now = audioContext.currentTime
  const osc = audioContext.createOscillator()
  osc.type = 'square'
  osc.frequency.value = 1500
  const gain = audioContext.createGain()
  gain.gain.setValueAtTime(0.25, now)
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.05)
  osc.connect(gain)
  gain.connect(audioContext.destination)
  osc.start(now)
  osc.stop(now + 0.06)
}

/** 再生開始時に1回だけ鳴らす、ピアノ風の簡易ジングル(分散和音)。 */
export function playStartJingle(audioContext: AudioContext): void {
  const now = audioContext.currentTime
  const notes = [523.25, 659.25, 783.99, 1046.5] // C5 - E5 - G5 - C6
  for (const [i, freq] of notes.entries()) {
    const startAt = now + i * 0.08
    const osc = audioContext.createOscillator()
    osc.type = 'triangle'
    osc.frequency.value = freq
    const gain = audioContext.createGain()
    gain.gain.setValueAtTime(0.0001, startAt)
    gain.gain.exponentialRampToValueAtTime(0.22, startAt + 0.02)
    gain.gain.exponentialRampToValueAtTime(0.0001, startAt + 0.6)
    osc.connect(gain)
    gain.connect(audioContext.destination)
    osc.start(startAt)
    osc.stop(startAt + 0.65)
  }
}
