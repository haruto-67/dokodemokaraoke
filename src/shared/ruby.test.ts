import { describe, expect, it } from 'vitest'
import { parseRubyLine, rubyToPlainText } from './ruby'

describe('parseRubyLine', () => {
  it('括弧記法でルビを抽出する', () => {
    expect(parseRubyLine('今日(きょう)は晴れ')).toEqual([
      { text: '今日', ruby: 'きょう' },
      { text: 'は晴れ', ruby: null }
    ])
  })

  it('青空文庫記法(｜あり)でルビを抽出する', () => {
    expect(parseRubyLine('｜明日《あした》も晴れるといいな')).toEqual([
      { text: '明日', ruby: 'あした' },
      { text: 'も晴れるといいな', ruby: null }
    ])
  })

  it('青空文庫記法(｜省略)で直前の漢字連続をルビ対象にする', () => {
    expect(parseRubyLine('今日《きょう》は晴れ')).toEqual([
      { text: '今日', ruby: 'きょう' },
      { text: 'は晴れ', ruby: null }
    ])
  })

  it('ルビでない括弧(数字など)は誤検出しない', () => {
    expect(parseRubyLine('第1章(1)')).toEqual([{ text: '第1章(1)', ruby: null }])
  })

  it('対応する閉じ括弧が無ければ通常文字として扱う', () => {
    expect(parseRubyLine('今日(きょう')).toEqual([{ text: '今日(きょう', ruby: null }])
  })

  it('ルビ記法を含まない行はそのまま1セグメントになる', () => {
    expect(parseRubyLine('ただの歌詞です')).toEqual([{ text: 'ただの歌詞です', ruby: null }])
  })

  it('空行は空配列を返す', () => {
    expect(parseRubyLine('')).toEqual([])
  })

  it('漢字が続かない場合は《》をルビとみなさない', () => {
    expect(parseRubyLine('あ《いう》')).toEqual([{ text: 'あ《いう》', ruby: null }])
  })
})

describe('rubyToPlainText', () => {
  it('本体テキストのみを連結する', () => {
    const segments = parseRubyLine('今日(きょう)は晴れ')
    expect(rubyToPlainText(segments)).toBe('今日は晴れ')
  })
})
