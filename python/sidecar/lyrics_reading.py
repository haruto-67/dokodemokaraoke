"""歌詞の読み(ひらがな・モーラ)と自動ルビ、wav2vec2モデルの読み込み(要件定義書v3 §4.4.6)。

歌詞のタイミング付け自体は vowel_align.py(母音・子音のDP)で行う。2026-10-20に、以前の
wav2vec2 CTCの自由デコード+編集距離による方式(このファイルの旧名 lyrics_align.py)から置き換えた。

同梱チェックポイント(japanese-wav2vec2-base-rs35kh.safetensors, Apache-2.0,
reazon-research)は標準のHuggingFace `Wav2Vec2ForCTC`アーキテクチャ(config
vocab_size=3003)とstate_dictキーが完全一致することを確認済み。語彙(`wav2vec2_vocab.json`、
元リポジトリのvocab.jsonをそのまま同梱。3000エントリの書き言葉サブワード単位)は、
vowel_align.pyで各単位の読みの母音を求める(初回の母音確率を作る)のに使う。
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import List, Tuple

import numpy as np

VOCAB_PATH = Path(__file__).with_name("wav2vec2_vocab.json")
UNK_TOKEN = "<unk>"


def katakana_to_hiragana(text: str) -> str:
    """カタカナをひらがなへ変換する(Unicode上0x60の固定オフセット)。長音記号「ー」等は対象外でそのまま残す。"""
    result = []
    for ch in text:
        code = ord(ch)
        if 0x30A1 <= code <= 0x30F6:  # ァ..ヶ
            result.append(chr(code - 0x60))
        else:
            result.append(ch)
    return "".join(result)


_KANJI_RE = re.compile(r"[一-鿿々]")


def _is_kanji(ch: str) -> bool:
    return bool(_KANJI_RE.match(ch))


def _split_ruby_segments(raw: str) -> List[Tuple[str, str | None]]:
    """`src/shared/ruby.ts`の`parseRubyLine`と同じルビ記法(青空文庫方式・括弧方式)を
    パースし、(本文, ルビ or None)のセグメント列を返す。要件定義書v3 §4.4.6の
    「ユーザーがルビを明示している場合は常にそちらを優先する」を実現するための下ごしらえ。
    """
    segments: List[Tuple[str, str | None]] = []
    plain_buf = ""
    i = 0
    n = len(raw)

    def flush_plain() -> None:
        nonlocal plain_buf
        if plain_buf:
            segments.append((plain_buf, None))
            plain_buf = ""

    while i < n:
        ch = raw[i]

        if ch == "｜":
            open_idx = raw.find("《", i + 1)
            if open_idx != -1:
                close_idx = raw.find("》", open_idx + 1)
                if close_idx != -1:
                    flush_plain()
                    segments.append((raw[i + 1 : open_idx], raw[open_idx + 1 : close_idx]))
                    i = close_idx + 1
                    continue
            plain_buf += ch
            i += 1
            continue

        if ch == "《":
            close_idx = raw.find("》", i + 1)
            if close_idx != -1 and plain_buf and _is_kanji(plain_buf[-1]):
                start = len(plain_buf)
                while start > 0 and _is_kanji(plain_buf[start - 1]):
                    start -= 1
                kanji_part = plain_buf[start:]
                before = plain_buf[:start]
                plain_buf = ""
                if before:
                    segments.append((before, None))
                segments.append((kanji_part, raw[i + 1 : close_idx]))
                i = close_idx + 1
                continue
            plain_buf += ch
            i += 1
            continue

        if ch == "(":
            close_idx = raw.find(")", i + 1)
            if close_idx != -1 and plain_buf and _is_kanji(plain_buf[-1]):
                inner = raw[i + 1 : close_idx]
                if re.fullmatch(r"[぀-ゟ゠-ヿー]+", inner):
                    start = len(plain_buf)
                    while start > 0 and _is_kanji(plain_buf[start - 1]):
                        start -= 1
                    kanji_part = plain_buf[start:]
                    before = plain_buf[:start]
                    plain_buf = ""
                    if before:
                        segments.append((before, None))
                    segments.append((kanji_part, inner))
                    i = close_idx + 1
                    continue
            plain_buf += ch
            i += 1
            continue

        plain_buf += ch
        i += 1

    flush_plain()
    return segments


def text_to_hiragana_reading(text: str) -> str:
    """漢字仮名混じりの歌詞1行を、ひらがな読みに変換する。

    `｜漢字《かんじ》`/`漢字(かんじ)`記法で明示されたルビは常にそちらを読みとして採用し
    (要件定義書v3 §4.4.6)、ルビが無い区間だけpyopenjtalkで読みを推定する。
    """
    import pyopenjtalk

    parts: List[str] = []
    for text_part, ruby in _split_ruby_segments(text):
        if ruby is not None:
            parts.append(katakana_to_hiragana(ruby))
        else:
            katakana = pyopenjtalk.g2p(text_part, kana=True)
            parts.append(katakana_to_hiragana(katakana))
    return "".join(parts)


_OKURIGANA_CHAR_RE = re.compile(r"[ぁ-ゟー]")


def _strip_trailing_okurigana(surface: str, reading: str) -> Tuple[str, str, str]:
    """形態素のsurface末尾にある送り仮名(ひらがな)を、readingの対応する末尾と
    1文字ずつ照合しながら切り出す。「捨て(すて)」のように送り仮名にまでルビが
    振られてしまう問題への対処(漢字部分にのみルビを付けたい)。

    戻り値は(ルビ対象の先頭部分, その読み, 送り仮名部分)。両方の末尾が一致する
    ひらがなである間だけ切り詰めるため、漢字の直前で必ず止まる。
    """
    surface_end = len(surface)
    reading_end = len(reading)
    while surface_end > 0 and reading_end > 0:
        s_ch = surface[surface_end - 1]
        r_ch = reading[reading_end - 1]
        if s_ch == r_ch and _OKURIGANA_CHAR_RE.fullmatch(s_ch):
            surface_end -= 1
            reading_end -= 1
            continue
        break
    return surface[:surface_end], reading[:reading_end], surface[surface_end:]


def auto_annotate_ruby(text: str) -> str:
    """漢字を含む形態素へ青空文庫形式のルビを付ける。ユーザー指定ルビは変更しない。
    送り仮名(活用語尾等)にはルビを付けず、漢字部分だけに絞る。
    """
    import pyopenjtalk

    annotated: List[str] = []
    for text_part, explicit_ruby in _split_ruby_segments(text):
        if explicit_ruby is not None:
            annotated.append(f"｜{text_part}《{katakana_to_hiragana(explicit_ruby)}》")
            continue

        cursor = 0
        for node in pyopenjtalk.run_frontend(text_part):
            surface = str(node.get("string", ""))
            if not surface:
                continue
            if surface.isspace():
                whitespace_start = cursor
                while cursor < len(text_part) and text_part[cursor].isspace():
                    cursor += 1
                annotated.append(text_part[whitespace_start:cursor])
                continue
            index = text_part.find(surface, cursor)
            if index < 0:
                # OpenJTalk側で表記が正規化され、元文字列へ安全に対応付けられない場合は
                # 残りをそのまま保持する。誤った範囲へルビを付けるより欠落しない方を優先する。
                annotated.append(text_part[cursor:])
                cursor = len(text_part)
                break
            annotated.append(text_part[cursor:index])
            reading = katakana_to_hiragana(str(node.get("read", "")))
            if any(_is_kanji(ch) for ch in surface) and reading and reading != "*":
                kanji_part, kanji_reading, okurigana = _strip_trailing_okurigana(surface, reading)
                if kanji_part and any(_is_kanji(ch) for ch in kanji_part) and kanji_reading:
                    annotated.append(f"｜{kanji_part}《{kanji_reading}》{okurigana}")
                else:
                    annotated.append(surface)
            else:
                annotated.append(surface)
            cursor = index + len(surface)
        annotated.append(text_part[cursor:])
    return "".join(annotated)


class Wav2Vec2Vocab:
    """`wav2vec2_vocab.json`に対する貪欲最長一致トークナイザー。

    HuggingFaceの`Wav2Vec2CTCTokenizer`はvocab.json全エントリを`added_tokens`
    として扱い、実質的に最長一致で分割する。ここではその挙動を、追加の
    トークナイザー依存無しに再現する。
    """

    def __init__(self, vocab_path: Path = VOCAB_PATH) -> None:
        with vocab_path.open(encoding="utf-8") as f:
            self.token_to_id: dict[str, int] = json.load(f)
        self.id_to_token = {v: k for k, v in self.token_to_id.items()}
        self.unk_id = self.token_to_id[UNK_TOKEN]
        self.max_token_len = max(len(t) for t in self.token_to_id)

    def encode(self, text: str) -> List[int]:
        """貪欲最長一致でトークンID列を返す。1文字も一致しない箇所は<unk>として1文字分だけ消費する。"""
        ids: List[int] = []
        i = 0
        n = len(text)
        while i < n:
            matched = False
            for length in range(min(self.max_token_len, n - i), 0, -1):
                candidate = text[i : i + length]
                if candidate in self.token_to_id:
                    ids.append(self.token_to_id[candidate])
                    i += length
                    matched = True
                    break
            if not matched:
                ids.append(self.unk_id)
                i += 1
        return ids

    def decode_single(self, token_id: int) -> str:
        return self.id_to_token.get(token_id, UNK_TOKEN)


def load_wav2vec2_model(model_path: Path):
    from safetensors.torch import load_file
    from transformers import Wav2Vec2Config, Wav2Vec2ForCTC

    state_dict = load_file(str(model_path))
    # 訂正(2026-09-21実機デバッグで発覚): vocab_size以外は全てHuggingFaceのdataclass既定値
    # (do_stable_layer_norm=False等)のままconfigを構築していたため、state_dictのkey名・shapeは
    # 完全一致してload_state_dict自体は例外無く成功するにもかかわらず、実際の計算経路(各
    # transformer層内でのLayerNormの適用位置: pre-norm/post-norm)がモデルの学習時と異なり、
    # 出力が入力(実音声・無音・ランダムノイズのいずれでも)にほぼ依存しない退化した確率分布に
    # 収束してしまっていた(実機検証: 同じ音声区間で全フレームが常に同一の<unk>支配的な分布を
    # 返し、実際の歌詞内容と無関係に歌詞が曲冒頭の1〜2秒に圧縮される不具合の真因だった)。
    # reazon-research/japanese-wav2vec2-base-rs35kh の実config.json
    # (https://huggingface.co/reazon-research/japanese-wav2vec2-base-rs35kh/raw/main/config.json)
    # を取得して確認したところ do_stable_layer_norm=true であり、HuggingFaceの既定値(False)とは
    # 異なっていた。これを明示することで、TTS生成の既知テキスト音声に対して実際に対応する
    # 文字が(不完全ながら)greedy decodeで現れるようになることを実機で確認した。
    config = Wav2Vec2Config(vocab_size=len(state_dict["lm_head.bias"]), do_stable_layer_norm=True)
    model = Wav2Vec2ForCTC(config)
    model.load_state_dict(state_dict)
    model.eval()
    return model


def normalize_audio(audio: np.ndarray) -> np.ndarray:
    """Wav2Vec2はzero-mean/unit-varianceに正規化された入力を前提とする。"""
    mean = audio.mean()
    std = audio.std()
    return ((audio - mean) / (std + 1e-7)).astype(np.float32)


def subword_to_reading(sub: str, cache: dict[str, str]) -> str:
    """wav2vec2の語彙の1単位(「季節」等、漢字混じりのことがある)をひらがな読みへ変換する。
    語彙は3000種のうち8割超が漢字を含むサブワード単位のため、歌詞側と同じpyopenjtalk経由の
    変換で読みにそろえる(vowel_align.pyで各単位を母音へ対応付けるのに使う)。
    文脈のない単語単体でのg2pは読み間違いもあり得る(例:「節」単体は「ふし」)。
    """
    if sub in cache:
        return cache[sub]
    plain = sub.lstrip("▁")
    if not plain or plain == UNK_TOKEN:
        cache[sub] = ""
        return ""
    try:
        import pyopenjtalk

        reading = katakana_to_hiragana(pyopenjtalk.g2p(plain, kana=True))
    except Exception:
        reading = plain
    cache[sub] = reading
    return reading
