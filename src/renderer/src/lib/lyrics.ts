/** 歌詞テキストを行配列へ変換する(§4.5: 1行=1フレーズ、空行は無視)。setup/analyzing両画面で共有する。 */
export function parseLyricsLines(text: string, removeSpaces: boolean): string[] {
  return text
    .split('\n')
    .map((l) => (removeSpaces ? l.replace(/[ 　]/g, '') : l))
    .filter((l) => l.trim().length > 0)
}
