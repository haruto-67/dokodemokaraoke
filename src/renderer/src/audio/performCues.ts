/**
 * 本番画面用の効果音(§4.12「カウントインに音を追加する」「キー提示」)。
 * 外部音声ファイルは使わず、Web Audioのオシレーターでその場合成する
 * (要件側でも「コード内蔵の簡易シンセ音でよい」と明示されている)。
 * 再生に使うAudioContextは`ctx.playback.audioContext`(曲再生と共有)をそのまま渡す想定。
 */

export const COUNT_IN_CLICK_COUNT = 4
export const COUNT_IN_CLICK_INTERVAL_SEC = 0.5
/** 4カウント全体を鳴らし切るのに必要なリード時間(秒)。歌い出しがこれより早い曲では、
 *  曲の実際の再生開始そのものを後ろにずらして必ずフルの4カウントを確保する(performScreen.ts参照)。 */
export const COUNT_IN_TOTAL_LEAD_SEC = COUNT_IN_CLICK_COUNT * COUNT_IN_CLICK_INTERVAL_SEC

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

/** キー提示音(単音)の長さ(秒)。4カウントが無い曲では、この時間だけ曲の再生開始を遅らせる。 */
export const KEY_TONE_DURATION_SEC = 1.0

/**
 * 再生開始前に1回だけ鳴らす、ピアノ風の単音(キー提示)。以前は4音の分散和音(ジングル)
 * だったが、「ジングルという名前だと何の音か分かりづらい」「間隔が短く基準音として使いにくい」
 * という指摘を受け、約1秒伸びる単音に変更した。`startAt`(省略時は現在時刻)から開始する。
 */
export function playKeyTone(audioContext: AudioContext, startAt?: number): void {
  const at = startAt ?? audioContext.currentTime
  const osc = audioContext.createOscillator()
  osc.type = 'triangle'
  osc.frequency.value = 523.25 // C5
  const gain = audioContext.createGain()
  gain.gain.setValueAtTime(0.0001, at)
  gain.gain.exponentialRampToValueAtTime(0.26, at + 0.03)
  gain.gain.exponentialRampToValueAtTime(0.0001, at + KEY_TONE_DURATION_SEC)
  osc.connect(gain)
  gain.connect(audioContext.destination)
  osc.start(at)
  osc.stop(at + KEY_TONE_DURATION_SEC + 0.05)
}
