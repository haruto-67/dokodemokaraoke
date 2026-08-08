// ルビ記法パース（要件定義書 §4.5）
// 括弧記法: 今日(きょう)は晴れ
// 青空文庫記法: ｜今日《きょう》は晴れ  （｜が無い場合は《の直前の漢字連続をルビ対象とする）

export interface RubySegment {
  text: string
  ruby: string | null
}

const KANJI_RE = /[一-鿿々々]/

function isKanji(ch: string): boolean {
  return KANJI_RE.test(ch)
}

export function parseRubyLine(raw: string): RubySegment[] {
  const segments: RubySegment[] = []
  let plainBuf = ''
  let i = 0

  const flushPlain = (): void => {
    if (plainBuf) {
      segments.push({ text: plainBuf, ruby: null })
      plainBuf = ''
    }
  }

  while (i < raw.length) {
    const ch = raw[i]

    // 青空文庫記法: ｜漢字列《よみ》
    if (ch === '｜') {
      const closeOpen = raw.indexOf('《', i + 1)
      if (closeOpen !== -1) {
        const closeEnd = raw.indexOf('》', closeOpen + 1)
        if (closeEnd !== -1) {
          flushPlain()
          const kanjiPart = raw.slice(i + 1, closeOpen)
          const rubyPart = raw.slice(closeOpen + 1, closeEnd)
          segments.push({ text: kanjiPart, ruby: rubyPart })
          i = closeEnd + 1
          continue
        }
      }
      // 対応する《》が無ければ通常文字として扱う
      plainBuf += ch
      i++
      continue
    }

    // 青空文庫記法（｜省略）: 直前の漢字連続《よみ》
    if (ch === '《') {
      const closeEnd = raw.indexOf('》', i + 1)
      if (closeEnd !== -1 && plainBuf.length > 0 && isKanji(plainBuf[plainBuf.length - 1])) {
        let start = plainBuf.length
        while (start > 0 && isKanji(plainBuf[start - 1])) start--
        const kanjiPart = plainBuf.slice(start)
        const before = plainBuf.slice(0, start)
        if (before) segments.push({ text: before, ruby: null })
        plainBuf = ''
        const rubyPart = raw.slice(i + 1, closeEnd)
        segments.push({ text: kanjiPart, ruby: rubyPart })
        i = closeEnd + 1
        continue
      }
      plainBuf += ch
      i++
      continue
    }

    // 括弧記法: 漢字列(よみ)  ※半角丸括弧のみ対応
    if (ch === '(') {
      const closeEnd = raw.indexOf(')', i + 1)
      if (closeEnd !== -1 && plainBuf.length > 0 && isKanji(plainBuf[plainBuf.length - 1])) {
        const inner = raw.slice(i + 1, closeEnd)
        // 中身がひらがな/カタカナ主体でなければルビとみなさない（例: 半角数字の"(1)"等を誤検出しない）
        if (/^[぀-ゟ゠-ヿー]+$/.test(inner)) {
          let start = plainBuf.length
          while (start > 0 && isKanji(plainBuf[start - 1])) start--
          const kanjiPart = plainBuf.slice(start)
          const before = plainBuf.slice(0, start)
          if (before) segments.push({ text: before, ruby: null })
          plainBuf = ''
          segments.push({ text: kanjiPart, ruby: inner })
          i = closeEnd + 1
          continue
        }
      }
      plainBuf += ch
      i++
      continue
    }

    plainBuf += ch
    i++
  }
  flushPlain()
  return segments
}

/** プレビュー表示用に <ruby> HTML相当の構造を組み立てる際に使う正規化テキストを返す */
export function rubyToPlainText(segments: RubySegment[]): string {
  return segments.map((s) => s.text).join('')
}
