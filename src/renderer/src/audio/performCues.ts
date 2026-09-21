/**
 * 本番画面用の効果音(§4.12「カウントインに音を追加する」「キー提示」)。
 * 外部音声ファイルは使わず、Web Audioのオシレーターでその場合成する
 * (要件側でも「コード内蔵の簡易シンセ音でよい」と明示されている)。
 * 再生に使うAudioContextは`ctx.playback.audioContext`(曲再生と共有)をそのまま渡す想定。
 */

const COUNT_IN_CLICK_COUNT = 4
const COUNT_IN_CLICK_INTERVAL_SEC = 0.5

/** メトロノーム的な短いクリック音を、指定したAudioContext時刻(絶対値)に1回鳴らす。 */
function scheduleClick(audioContext: AudioContext, at: number): void {
  const osc = audioContext.createOscillator()
  osc.type = 'square'
  osc.frequency.value = 1500
  const gain = audioContext.createGain()
  gain.gain.setValueAtTime(0.25, at)
  gain.gain.exponentialRampToValueAtTime(0.001, at + 0.05)
  osc.connect(gain)
  gain.connect(audioContext.destination)
  osc.start(at)
  osc.stop(at + 0.06)
}

/**
 * 歌い出し直前だけ鳴らす4カウント(§4.12「カウントインに音を追加する」)。
 * 曲のBPM検出は行わず(解析パイプラインにBPM検出が無いため)、固定間隔で機械的に
 * 4回鳴らす簡易版。`firstLineStartAtCtxTime`(1行目の歌い出しに対応するAudioContext時刻)を
 * 起点に、そこへ向けて逆算した4つの時刻にまとめてスケジュールする(数字表示の更新tickとは
 * 完全に独立させ、間奏カウントダウンでは一切呼ばない。以前は数字が切り替わるたびに
 * 毎回クリック音を鳴らしていたため、間奏のたびに鳴る・4カウントとして揃っていない
 * という不具合があった)。
 */
export function scheduleCountInClicks(audioContext: AudioContext, firstLineStartAtCtxTime: number): void {
  for (let i = 0; i < COUNT_IN_CLICK_COUNT; i++) {
    const at = firstLineStartAtCtxTime - (COUNT_IN_CLICK_COUNT - i) * COUNT_IN_CLICK_INTERVAL_SEC
    if (at >= audioContext.currentTime) scheduleClick(audioContext, at)
  }
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
