import { describe, expect, it } from 'vitest'
import { tokenizeLine, tokenWeight, type Token } from './tokenize'

describe('tokenizeLine', () => {
  it('基本: かな・漢字1文字を1トークンとする', () => {
    const tokens = tokenizeLine('今日は晴れ')
    expect(tokens.map((t) => t.text)).toEqual(['今', '日', 'は', '晴', 'れ'])
  })

  it('拗音は直前の文字と結合して1トークンになる', () => {
    const tokens = tokenizeLine('きょう')
    expect(tokens.map((t) => t.text)).toEqual(['きょ', 'う'])
  })

  it('促音は直前のトークンに結合する', () => {
    const tokens = tokenizeLine('がっこう')
    expect(tokens.map((t) => t.text)).toEqual(['がっ', 'こ', 'う'])
  })

  it('長音は直前のトークンに結合する', () => {
    const tokens = tokenizeLine('カー')
    expect(tokens.map((t) => t.text)).toEqual(['カー'])
  })

  it('撥音(ん)は独立した1トークンになる', () => {
    const tokens = tokenizeLine('こんにちは')
    expect(tokens.map((t) => t.text)).toEqual(['こ', 'ん', 'に', 'ち', 'は'])
  })

  it('ルビ付き漢字はルビの範囲を1トークンとする', () => {
    const tokens = tokenizeLine('今日(きょう)は晴れ')
    expect(tokens).toEqual<Token[]>([
      { text: '今日', ruby: 'きょう' },
      { text: 'は', ruby: null },
      { text: '晴', ruby: null },
      { text: 'れ', ruby: null }
    ])
  })

  it('英単語は1トークンとする(文字単位に割らない)', () => {
    const tokens = tokenizeLine('Hello World')
    expect(tokens.map((t) => t.text)).toEqual(['Hello ', 'World'])
  })

  it('連続する数字列は1トークンとする', () => {
    const tokens = tokenizeLine('第123話')
    expect(tokens.map((t) => t.text)).toEqual(['第', '123', '話'])
  })

  it('記号・空白はトークン化せず直前のトークンに含める', () => {
    const tokens = tokenizeLine('今日は、晴れ！')
    expect(tokens.map((t) => t.text)).toEqual(['今', '日', 'は、', '晴', 'れ！'])
  })

  it('空行は空配列を返す', () => {
    expect(tokenizeLine('')).toEqual([])
  })

  it('行頭が記号の場合、結合先の直前トークンが無いため破棄される', () => {
    const tokens = tokenizeLine('、今日')
    expect(tokens.map((t) => t.text)).toEqual(['今', '日'])
  })
})

describe('tokenWeight', () => {
  it('通常のトークンは重み1', () => {
    expect(tokenWeight({ text: '今', ruby: null })).toBe(1)
  })

  it('促音を含むトークンは重みが増える', () => {
    expect(tokenWeight({ text: 'がっ', ruby: null })).toBe(2)
  })

  it('長音を含むトークンは重みが増える', () => {
    expect(tokenWeight({ text: 'カー', ruby: null })).toBe(2)
  })

  it('拗音の結合のみでは重みは増えない(1モーラのまま)', () => {
    expect(tokenWeight({ text: 'きょ', ruby: null })).toBe(1)
  })

  it('ルビ付きトークンはルビのモーラ数を重みとする', () => {
    expect(tokenWeight({ text: '今日', ruby: 'きょう' })).toBe(2)
  })

  it('促音を含むルビは正しくモーラ数を数える', () => {
    expect(tokenWeight({ text: '学校', ruby: 'がっこう' })).toBe(4)
  })
})
