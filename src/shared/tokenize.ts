// トークン分割ルール(要件定義書 §4.6.1)・モーラ重み(§4.6.3手順1)
import { parseRubyLine } from './ruby'

export interface Token {
  text: string
  ruby: string | null
}

const SMALL_KANA = new Set(['ゃ', 'ゅ', 'ょ', 'ぁ', 'ぃ', 'ぅ', 'ぇ', 'ぉ', 'ャ', 'ュ', 'ョ', 'ァ', 'ィ', 'ゥ', 'ェ', 'ォ'])
const SOKUON = new Set(['っ', 'ッ'])
const CHOON = new Set(['ー'])

function isDigit(ch: string): boolean {
  return /[0-9]/.test(ch)
}
function isAsciiLetter(ch: string): boolean {
  return /[A-Za-z]/.test(ch)
}
/** かな・漢字(長音記号ーを含む)かどうか */
function isKanaOrKanji(ch: string): boolean {
  return /[一-鿿々ぁ-んァ-ヶー]/.test(ch)
}

function tokenizePlainTextInto(text: string, tokens: Token[]): void {
  let i = 0
  while (i < text.length) {
    const ch = text[i]

    if (isDigit(ch)) {
      // 連続する数字列は1トークン
      let j = i + 1
      while (j < text.length && isDigit(text[j])) j++
      tokens.push({ text: text.slice(i, j), ruby: null })
      i = j
      continue
    }

    if (isAsciiLetter(ch)) {
      // 英単語は1トークン(文字単位に割らない)
      let j = i + 1
      while (j < text.length && isAsciiLetter(text[j])) j++
      tokens.push({ text: text.slice(i, j), ruby: null })
      i = j
      continue
    }

    if (isKanaOrKanji(ch)) {
      if (SMALL_KANA.has(ch) || SOKUON.has(ch) || CHOON.has(ch)) {
        // 拗音・促音・長音は直前の文字/トークンと結合する
        if (tokens.length > 0) tokens[tokens.length - 1].text += ch
        else tokens.push({ text: ch, ruby: null })
      } else {
        // 基本(かな・漢字1文字。撥音「ん」もここに含まれ独立した1トークンになる)
        tokens.push({ text: ch, ruby: null })
      }
      i++
      continue
    }

    // 記号・空白: トークンとして扱わず、直前のトークンに含める
    if (tokens.length > 0) tokens[tokens.length - 1].text += ch
    i++
  }
}

/** 読みを、拗音だけ直前へ結合したモーラ単位へ分割する。促音・長音・撥音は独立モーラ。 */
export function splitMoras(reading: string): string[] {
  const moras: string[] = []
  for (const ch of reading) {
    if (SMALL_KANA.has(ch) && moras.length > 0) moras[moras.length - 1] += ch
    else moras.push(ch)
  }
  return moras
}

function tokenizeRubySegment(text: string, ruby: string): Token[] {
  const moras = splitMoras(ruby)
  if (moras.length === 0) return [{ text, ruby }]
  const baseChars = Array.from(text)
  return moras.map((mora, index) => ({
    // ルビの方が長い場合も各モーラを独立したタイミング単位として残す。最後の数トークンは
    // 本文が空になるが、本番画面ではrubyが表示されるため読み自体は欠落しない。
    text: index < moras.length - 1 ? (baseChars[index] ?? '') : baseChars.slice(index).join(''),
    ruby: mora
  }))
}

/** 1つの行テキストをルビ記法解決の上、トークン列へ分割する(§4.6.1)。 */
export function tokenizeLine(text: string): Token[] {
  const segments = parseRubyLine(text)
  const tokens: Token[] = []
  for (const seg of segments) {
    if (seg.ruby) {
      // 編集・文字送りとも、漢字の字数ではなく実際の読みのモーラ単位にする。
      tokens.push(...tokenizeRubySegment(seg.text, seg.ruby))
      continue
    }
    tokenizePlainTextInto(seg.text, tokens)
  }
  return tokens
}

function moraCountOfKana(str: string): number {
  let count = 0
  for (const ch of str) {
    if (SMALL_KANA.has(ch)) continue // 拗音は直前と合わせて1モーラなのでカウントしない
    count++
  }
  return count
}

/**
 * トークンのモーラ重み(§4.6.3手順1)。
 * ルビ付き漢字はルビのモーラ数を重みとする。それ以外は基本1モーラとし、
 * 促音・長音が結合されているトークンはその分だけ重みを増やす(拗音の結合は増やさない)。
 */
export function tokenWeight(token: Token): number {
  if (token.ruby) return moraCountOfKana(token.ruby)

  let weight = 1
  for (const ch of token.text) {
    if (SOKUON.has(ch) || CHOON.has(ch)) weight++
  }
  return weight
}
