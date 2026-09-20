"""歌詞のモーラ読み変換とwav2vec2 CTC forced align(要件定義書v3 §4.4.6/§4.4.7 STEP6/STEP7)。

同梱チェックポイント(japanese-wav2vec2-base-rs35kh.safetensors, Apache-2.0,
reazon-research)は標準のHuggingFace `Wav2Vec2ForCTC`アーキテクチャ(config
vocab_size=3003)とstate_dictキーが完全一致することを確認済み。

このモデルの語彙(`wav2vec2_vocab.json`、元リポジトリのvocab.jsonをそのまま
同梱。3000エントリの書き言葉サブワード単位)は漢字・ひらがな中心で、
カタカナはごく一部しか含まない。一方pyopenjtalkの読み(`kana=True`)は
カタカナを返すため、そのままでは大半が<unk>になってしまう。そこで
カタカナ→ひらがな変換をしてから、この語彙に対する自前の貪欲最長一致
トークナイザーでID列化する(transformersの`Wav2Vec2CTCTokenizer`を使わず
vocab.jsonだけを持つのは、依存を増やさず動作をこちらで完全に把握するため)。
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import List, Tuple, TypedDict

import numpy as np
import torch

VOCAB_PATH = Path(__file__).with_name("wav2vec2_vocab.json")
UNK_TOKEN = "<unk>"

# Wav2Vec2の畳み込み特徴抽出器の全体ストライド(config既定: 5,2,2,2,2,2,2の積)。
# 16kHz入力に対して1出力フレームあたりのサンプル数。
WAV2VEC2_STRIDE_SAMPLES = 320
WAV2VEC2_SAMPLE_RATE = 16000


class AlignedToken(TypedDict):
    text: str
    start: float
    end: float


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


def _load_wav2vec2_model(model_path: Path):
    from safetensors.torch import load_file
    from transformers import Wav2Vec2Config, Wav2Vec2ForCTC

    state_dict = load_file(str(model_path))
    config = Wav2Vec2Config(vocab_size=len(state_dict["lm_head.bias"]))
    model = Wav2Vec2ForCTC(config)
    model.load_state_dict(state_dict)
    model.eval()
    return model


def _normalize_audio(audio: np.ndarray) -> np.ndarray:
    """Wav2Vec2はzero-mean/unit-varianceに正規化された入力を前提とする。"""
    mean = audio.mean()
    std = audio.std()
    return ((audio - mean) / (std + 1e-7)).astype(np.float32)


def align_tokens_to_audio(
    hiragana_text: str,
    audio_16k_mono: np.ndarray,
    model_path: Path,
    vocab: Wav2Vec2Vocab | None = None,
) -> Tuple[List[AlignedToken], float]:
    """ひらがな読みのテキストを、指定区間の16kHzモノラル音声にforced alignする。

    戻り値: (アライメント済みトークン(1文字ずつ,区間内相対秒), 信頼度(0..1、平均対数尤度をexpで戻した値))
    """
    from torchaudio.functional import forced_align

    if vocab is None:
        vocab = Wav2Vec2Vocab()

    target_ids = vocab.encode(hiragana_text)
    if not target_ids:
        return [], 0.0

    model = _load_wav2vec2_model(model_path)
    audio = _normalize_audio(audio_16k_mono)
    with torch.no_grad():
        logits = model(torch.from_numpy(audio).unsqueeze(0)).logits
        log_probs = torch.log_softmax(logits, dim=-1)

    targets = torch.tensor([target_ids], dtype=torch.int64)
    # CTCのblank IDはmodel.config.pad_token_id(既定0)。元リポジトリのconfig.jsonも
    # pad_token_id=0のため、これがfine-tuning時に実際に使われたblankと一致する
    # (tokenizer_config.json上のpad_token="<pad>"(id 3002)はテキスト側のパディング用で別物、
    # vocab.json上のid 0は"<unk>"表記だが、CTC上は数値としてのblankとして機能する)。
    blank_id = model.config.pad_token_id if model.config.pad_token_id is not None else 0
    alignment, scores = forced_align(log_probs, targets, blank=blank_id)

    frame_labels = alignment[0].tolist()
    frame_scores = scores[0].tolist()

    tokens: List[AlignedToken] = []
    current_label = None
    current_start_frame = 0
    current_scores: List[float] = []

    def flush(end_frame: int) -> None:
        nonlocal current_label, current_scores
        if current_label is None or current_label == blank_id:
            return
        char = vocab.decode_single(current_label)
        if char in (UNK_TOKEN,):
            return
        start_sec = current_start_frame * WAV2VEC2_STRIDE_SAMPLES / WAV2VEC2_SAMPLE_RATE
        end_sec = end_frame * WAV2VEC2_STRIDE_SAMPLES / WAV2VEC2_SAMPLE_RATE
        tokens.append({"text": char, "start": start_sec, "end": end_sec})

    for frame_idx, label in enumerate(frame_labels):
        if label != current_label:
            flush(frame_idx)
            current_label = label
            current_start_frame = frame_idx
            current_scores = []
        current_scores.append(frame_scores[frame_idx])
    flush(len(frame_labels))

    # forced_alignのscoresはフレームごとの対数尤度(負値、0が最良)。編集画面にそのまま
    # 出しても直感的でないため、平均対数尤度をexpで0..1の値(幾何平均的な確率)へ戻す。
    avg_confidence = float(np.exp(np.mean(frame_scores))) if frame_scores else 0.0
    return tokens, avg_confidence
