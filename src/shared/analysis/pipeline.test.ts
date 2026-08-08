import { describe, expect, it } from 'vitest'
import { runSignalAnalysis, assignLyricsTiming } from './pipeline'
import { musicalSignal, whiteNoise, sineWave } from './testSignals'
import type { AnalysisStepProgress } from '../types'

const SAMPLE_RATE = 22050

describe('runSignalAnalysis', () => {
  it('オフボーカル無しでも(オンボーカルのみで)解析でき、alignment/vocalIsolationはskippedになる', () => {
    const signal = sineWave(SAMPLE_RATE * 1, 220, SAMPLE_RATE)
    const progressLog: AnalysisStepProgress[] = []

    const result = runSignalAnalysis(
      { analysis: { channels: [signal], sampleRate: SAMPLE_RATE }, playback: null },
      (p) => progressLog.push(p)
    )

    expect(result.alignmentOffsetSamples).toBe(0)
    expect(result.vocalIsolationUsed).toBe('none')
    expect(result.pitchHz.length).toBeGreaterThan(0)
    expect(result.hopSec).toBeCloseTo(0.005)

    const alignmentEvents = progressLog.filter((p) => p.id === 'alignment')
    expect(alignmentEvents.some((p) => p.status === 'skipped')).toBe(true)
  })

  it('オフボーカルが伴奏として与えられると差分ボーカル抽出が使われる', () => {
    const n = SAMPLE_RATE * 2
    const accompaniment = musicalSignal(n, SAMPLE_RATE, 1)
    const vocal = sineWave(n, 440, SAMPLE_RATE, 0.5)
    const analysisSignal = new Float32Array(n)
    for (let i = 0; i < n; i++) analysisSignal[i] = accompaniment[i] + vocal[i]

    const result = runSignalAnalysis({
      analysis: { channels: [analysisSignal], sampleRate: SAMPLE_RATE },
      playback: { channels: [accompaniment], sampleRate: SAMPLE_RATE }
    })

    expect(result.alignmentOffsetSamples).toBe(0)
    expect(result.vocalIsolationUsed).toBe('difference')
  })

  it('別マスター相当(無相関)のオフボーカルが渡された場合、アライメント不能としてSTEP2をスキップする', () => {
    const n = SAMPLE_RATE * 2
    const analysisSignal = musicalSignal(n, SAMPLE_RATE, 1)
    const unrelatedPlayback = whiteNoise(n, 999)

    const result = runSignalAnalysis({
      analysis: { channels: [analysisSignal], sampleRate: SAMPLE_RATE },
      playback: { channels: [unrelatedPlayback], sampleRate: SAMPLE_RATE }
    })

    expect(result.vocalIsolationUsed).toBe('none')
  })

  it('フレーズが検出されればphrasesとonsetsSecが返る', () => {
    const signal = sineWave(SAMPLE_RATE * 1, 220, SAMPLE_RATE)
    const result = runSignalAnalysis({
      analysis: { channels: [signal], sampleRate: SAMPLE_RATE },
      playback: null
    })
    expect(result.phrases.length).toBeGreaterThan(0)
    expect(result.onsetsSec).toBeInstanceOf(Float32Array)
  })
})

describe('assignLyricsTiming', () => {
  it('歌詞行数分のDokokaraLineを生成し、各行のトークンが時刻を持つ', () => {
    const signal = sineWave(SAMPLE_RATE * 3, 220, SAMPLE_RATE)
    const analysisResult = runSignalAnalysis({
      analysis: { channels: [signal], sampleRate: SAMPLE_RATE },
      playback: null
    })

    const lines = assignLyricsTiming(['今日は晴れ', '明日も晴れるといいな'], analysisResult, 3)

    expect(lines.length).toBe(2)
    for (const line of lines) {
      expect(line.id).toBeTruthy()
      expect(line.tokens.length).toBeGreaterThan(0)
      expect(line.start).toBeLessThanOrEqual(line.end)
      expect(line.tokens[0].start).toBeCloseTo(line.start)
      expect(line.tokens[line.tokens.length - 1].end).toBeCloseTo(line.end)
      for (let i = 1; i < line.tokens.length; i++) {
        expect(line.tokens[i].start).toBeCloseTo(line.tokens[i - 1].end)
      }
    }
  })

  it('ルビ記法を含む歌詞も正しくトークン化される', () => {
    const signal = sineWave(SAMPLE_RATE * 1, 220, SAMPLE_RATE)
    const analysisResult = runSignalAnalysis({
      analysis: { channels: [signal], sampleRate: SAMPLE_RATE },
      playback: null
    })
    const lines = assignLyricsTiming(['今日(きょう)は晴れ'], analysisResult, 1)
    expect(lines[0].tokens[0]).toMatchObject({ text: '今日', ruby: 'きょう' })
  })

  it('歌詞が空の場合は空配列を返す', () => {
    const analysisResult = runSignalAnalysis({
      analysis: { channels: [new Float32Array(SAMPLE_RATE)], sampleRate: SAMPLE_RATE },
      playback: null
    })
    expect(assignLyricsTiming([], analysisResult, 1)).toEqual([])
  })
})
