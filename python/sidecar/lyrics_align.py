"""歌詞のモーラ読み変換とwav2vec2 CTCベースのタイミング付け(要件定義書v3 §4.4.6/§4.4.7)。

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

メインの歌詞タイミング付けは`align_lyrics_lines_to_song`(ctc-segmentation使用、
歌詞行リスト全体を曲全体に一括アライメントする方式)。`align_tokens_to_audio`
(forced_align、1区間ずつの旧方式)は現在main.pyからは呼ばれていないが、
wav2vec2モデルの読み込み・blank ID・CTC長さ制約まわりの回帰テストとして
引き続き価値があるため残している。
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Callable, List, Optional, Tuple, TypedDict

import numpy as np
import torch

from f0_notes import NoteEvent

VOCAB_PATH = Path(__file__).with_name("wav2vec2_vocab.json")
# 文字境界をノート開始時刻へスナップする際の許容誤差(§4.4.7後処理)。歌は1文字を長く伸ばす・
# ビブラートがかかるため、CTCが出す確信度ピークだけに基づく中間点は実際の発音開始とズレやすい。
# 隣接モーラの開始点に誤ってスナップしないよう、日本語の平均的なモーラ長より狭く設定する。
NOTE_SNAP_TOLERANCE_SEC = 0.12
# 文字間の自動休符判定(§4.4.7後処理)。自由デコードが検出した文字認識時刻の間隔がこれを
# 超える場合、機械的な中間点分割ではなく実際に無音(ブレス等)があると判断し、
# 前後の文字を詰めて隙間(休符)を作る。日本語の1モーラは通常0.1〜0.2秒程度のため、
# その2倍以上離れていれば明確に休符とみなせる。
REST_GAP_THRESHOLD_SEC = 0.5
# 休符を作る際、前後の文字それぞれに残すマージン(発音の余韻・立ち上がり分)
REST_MARGIN_SEC = 0.1
UNK_TOKEN = "<unk>"

# Wav2Vec2の畳み込み特徴抽出器の全体ストライド(config既定: 5,2,2,2,2,2,2の積)。
# 16kHz入力に対して1出力フレームあたりのサンプル数。
WAV2VEC2_STRIDE_SAMPLES = 320
WAV2VEC2_SAMPLE_RATE = 16000


class AlignedToken(TypedDict):
    text: str
    start: float
    end: float


class AlignedReadingToken(TypedDict):
    """CTCが認識した読みトークンと、曲全体上の時間範囲。"""

    reading: str
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


def _load_wav2vec2_model(model_path: Path):
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

    # CTCは連続する同一ラベルの間に必ずblankフレームを1つ挟む必要があるため、
    # 最低でも「targets長 + 直前と同じラベルが連続する箇所の数」フレームが要る。
    # VAD検出区間(§4.4.5)が短すぎる/歌詞行が長すぎる場合にここを満たせないことがあり、
    # 満たせないままforced_alignを呼ぶと`targets length is too long for CTC`で例外になる
    # (実機で発生を確認)。1行分のミスマッチで解析全体を失敗させないよう、ここで検知して
    # 空の結果(信頼度0)を返す(呼び出し側main.pyでこの行だけconfidence=Noneとして扱う想定)。
    num_repeats = sum(1 for i in range(1, len(target_ids)) if target_ids[i] == target_ids[i - 1])
    min_required_frames = len(target_ids) + num_repeats
    if log_probs.shape[1] < min_required_frames:
        return [], 0.0

    targets = torch.tensor([target_ids], dtype=torch.int64)
    # CTCのblank ID: 訂正(2026-09-21、実config.json取得により判明): モデルの実際の学習時blank
    # (pad_token_id)は0であり、以前ここに書いていた「vocab_size-1が実際のblank」という説明は
    # 誤りだった(align_lyrics_lines_to_songのblank_id算出、_load_wav2vec2_model()内コメント参照)。
    # ただし本文中のwav2vec2_vocab.json(3000エントリ、id 0="<unk>")はpyopenjtalk/vocab不一致時の
    # フォールバックとして歌詞テキストのtargetsにも普通に出現しうるIDであり、torchaudioの
    # forced_alignは「targetsにblank IDを含んではいけない」という制約を持つため、blank=0のままだと
    # targetsに0が混入した瞬間に`targets Tensor shouldn't contain blank index`で例外になる
    # (実機で確認済み)。この関数(1区間ずつのforced_align、現在main.pyからは未使用)は
    # この制約を回避するため、意図的にモデルが実際には使わない空きクラス(vocab_size-1)を
    # blankとして扱う。この場合、alignment自体の精度は劣化しうるが、main.pyの現行パイプラインは
    # align_lyrics_lines_to_song(ctc-segmentation、blank=pad_token_idを正しく使う)を使うため
    # 実害は無い。
    blank_id = model.config.vocab_size - 1
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


class AlignedLine(TypedDict):
    text: str
    annotatedText: str
    start: float
    end: float
    confidence: float
    tokenTimings: List[AlignedReadingToken]


def _snap_boundaries_to_notes(
    boundaries: List[float],
    notes: Optional[List[NoteEvent]],
    tolerance_sec: float,
) -> List[float]:
    """内部境界(先頭・末尾の行境界を除く)を、近いノート開始時刻へスナップする(§4.4.7後処理)。

    歌詞は基本的に「新しい文字を発音する瞬間 = 新しい音符が始まる瞬間」と一致することが
    多い(1文字1音符が基本形)という前提を利用する。1つのノート開始点は1つの境界にのみ
    使う(同じ点へ複数境界が吸着すると境界の順序が壊れるため)。メリスマ(1文字が複数ノート
    にまたがる)の場合や近くにノートが無い場合は、最近傍ノートが遠すぎてtolerance外になり
    元のCTC中間点のまま残る、という形で自然にフォールバックする。
    """
    if not notes or len(boundaries) <= 2:
        return boundaries

    note_starts = sorted(n["start"] for n in notes)
    used_indices: set[int] = set()
    result = list(boundaries)
    for i in range(1, len(boundaries) - 1):
        best_idx: int | None = None
        best_dist = tolerance_sec
        for ni, ns in enumerate(note_starts):
            if ni in used_indices:
                continue
            dist = abs(ns - boundaries[i])
            if dist <= best_dist:
                best_idx = ni
                best_dist = dist
        if best_idx is not None:
            result[i] = note_starts[best_idx]
            used_indices.add(best_idx)

    # スナップにより境界の前後関係が崩れないようクランプする
    for i in range(1, len(result)):
        if result[i] < result[i - 1]:
            result[i] = result[i - 1]
    return result


def _boundaries_from_centers(
    centers: List[float],
    line_start: float,
    line_end: float,
    notes: Optional[List[NoteEvent]] = None,
    note_snap_tolerance_sec: float = NOTE_SNAP_TOLERANCE_SEC,
) -> List[float]:
    """各文字の代表時刻(centers)から、隣接文字との中点を境界とする区間の境界配列を作る。
    notesを渡した場合、境界をノート開始時刻へスナップする後処理を追加で行う。
    """
    if not centers:
        return [line_start, line_end]

    clamped: List[float] = []
    previous = line_start
    for raw in centers:
        c = max(previous, min(line_end, float(raw)))
        clamped.append(c)
        previous = c

    boundaries = [line_start]
    boundaries.extend((clamped[i - 1] + clamped[i]) / 2 for i in range(1, len(clamped)))
    boundaries.append(line_end)
    return _snap_boundaries_to_notes(boundaries, notes, note_snap_tolerance_sec)


def _build_aligned_reading_tokens(
    token_ids: List[int],
    timing_points: np.ndarray,
    line_start: float,
    line_end: float,
    vocab: Wav2Vec2Vocab,
    notes: Optional[List[NoteEvent]] = None,
    note_snap_tolerance_sec: float = NOTE_SNAP_TOLERANCE_SEC,
) -> List[AlignedReadingToken]:
    """CTCの各ラベル中心時刻から、隣接ラベルとの中点を境界とする読み区間を作る。
    notesを渡した場合、境界をノート開始時刻へスナップする後処理を追加で行う。
    """
    if not token_ids or len(timing_points) != len(token_ids):
        return []

    boundaries = _boundaries_from_centers(list(timing_points), line_start, line_end, notes, note_snap_tolerance_sec)
    return [
        {
            "reading": vocab.decode_single(token_id),
            "start": float(boundaries[i]),
            "end": float(max(boundaries[i], boundaries[i + 1])),
        }
        for i, token_id in enumerate(token_ids)
    ]


def _apply_auto_rests(
    starts: List[float],
    ends: List[float],
    centers: List[float],
    matched: List[bool],
    gap_threshold_sec: float,
    margin_sec: float,
) -> None:
    """文字間の認識時刻の間隔(centers)が閾値を超える箇所に、休符(無音の隙間)を自動挿入する。

    強制アライメント由来の中間点分割は常にトークンが隙間なく連続するため、実際に
    ブレス等の無音がある箇所も機械的に埋めてしまう。centersの間隔が広ければ実際に
    無音である可能性が高いという前提で、前後の文字をそれぞれmargin_secだけ残して
    詰める(starts/endsをin-placeで書き換える)。

    両側の文字が実際に自由デコードとマッチした場合のみ判定する。どちらかが認識ミスで
    前後から線形補間された文字の場合、その間隔は「実際の無音」ではなく単なる補間の
    副産物である可能性が高く、誤って休符を作ってしまうため対象から除く。
    """
    for i in range(1, len(centers)):
        if not (matched[i - 1] and matched[i]):
            continue
        gap = centers[i] - centers[i - 1]
        if gap <= gap_threshold_sec:
            continue
        candidate_end = centers[i - 1] + margin_sec
        candidate_start = centers[i] - margin_sec
        if candidate_end < ends[i - 1]:
            ends[i - 1] = candidate_end
        if candidate_start > starts[i]:
            starts[i] = candidate_start


def _build_reading_tokens_from_chars(
    readings: List[str],
    centers: List[float],
    line_start: float,
    line_end: float,
    notes: Optional[List[NoteEvent]] = None,
    note_snap_tolerance_sec: float = NOTE_SNAP_TOLERANCE_SEC,
    matched: Optional[List[bool]] = None,
    rest_gap_threshold_sec: float = REST_GAP_THRESHOLD_SEC,
    rest_margin_sec: float = REST_MARGIN_SEC,
) -> List[AlignedReadingToken]:
    """1文字ずつの読みと代表時刻(centers)から読み区間を作る(自由デコード方式用)。
    文字間の間隔が大きい箇所には自動で休符(隙間)を挟む(matched未指定時は全文字を対象とする)。
    """
    if not readings or len(readings) != len(centers):
        return []

    boundaries = _boundaries_from_centers(centers, line_start, line_end, notes, note_snap_tolerance_sec)
    starts = list(boundaries[:-1])
    ends = list(boundaries[1:])
    effective_matched = matched if matched is not None else [True] * len(centers)
    _apply_auto_rests(starts, ends, centers, effective_matched, rest_gap_threshold_sec, rest_margin_sec)

    return [
        {"reading": ch, "start": float(starts[i]), "end": float(max(starts[i], ends[i]))}
        for i, ch in enumerate(readings)
    ]


def _subword_to_reading(sub: str, cache: dict[str, str]) -> str:
    """デコード語彙の1単位(「季節」等、漢字混じりのことがある)をひらがな読みへ変換する。

    自由デコードの語彙は3000種のうち8割超が漢字を含むサブワード単位であり(reazon-research
    版wav2vec2は書き言葉の正書法をそのまま出力するモデルのため)、歌詞側のreading(ひらがな、
    text_to_hiragana_readingで生成)とは同じ文字列比較では一致しない。text_to_hiragana_reading
    と同じpyopenjtalk経由の変換をここでも通すことで、比較可能な表現へ揃える。
    文脈のない単語単体でのg2pは読み間違いもあり得るが(例:「節」単体は「ふし」、
    「季節」の中でなら「せつ」)、比較すらできない状態よりは改善する。
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


def _default_subword_to_reading() -> Callable[[str], str]:
    cache: dict[str, str] = {}
    return lambda sub: _subword_to_reading(sub, cache)


def _greedy_decode_chars(
    lpz: np.ndarray,
    vocab: Wav2Vec2Vocab,
    blank_id: int,
    frame_sec: float,
    to_reading: Optional[Callable[[str], str]] = None,
) -> Tuple[List[str], List[float], List[bool]]:
    """各フレームのargmaxからCTC標準の重複除去・blank除去を行い、ひらがな読みの1文字ずつに
    展開した(文字, その文字を含む単位が検出されたフレームの時刻, 時刻アンカーとして
    信頼できるか)のリストを返す(自由デコード、§4.4.7新方式)。

    強制アライメント(align_lyrics_lines_to_song)と違い、与えられたテキストを必ず
    どこかに配置する制約が無いため、モデル自身のblank確信度がそのまま無音判定に使われる。

    語彙の1単位が複数文字(例:「いない」「もう」)のことがあり、CTCは1フレームでまとめて
    そのまとまりを検出するため、単位内の全文字が同じフレーム時刻を持つ。この時刻はその単位
    全体が「検出された瞬間」であって各文字の発音開始ではないため、単位内でどの文字が
    その時刻に対応するかは実際には分からない。3文字分「い」「な」「い」が同時刻を持つと、
    後段の中点計算で文字幅が0になったり隣が肩代わりしたりする不具合が生じていた
    (2026-09-23実測、いないいないばあで確認)。ここでは単位内の最後の文字だけを
    信頼できる時刻アンカーとし、それより前の文字は「認識に失敗した」場合と同様に扱って
    前後のアンカーから補間させる(補間側の精度は_sequence_align_reading_to_hypothesisの
    ノートスナップ処理で追加補正する)。

    to_readingは語彙の1単位(漢字混じりのことがある)をひらがな読みへ変換する関数。
    省略時はpyopenjtalk経由の実変換(_subword_to_reading)を使う。テストでは実際の
    形態素解析に依存させないよう、決定的な差し替え関数を渡せる。
    """
    resolve_reading = to_reading if to_reading is not None else _default_subword_to_reading()
    argmax_ids = lpz.argmax(axis=1)
    chars: List[str] = []
    times: List[float] = []
    is_anchor: List[bool] = []
    prev_id: Optional[int] = None
    for i, token_id in enumerate(argmax_ids):
        tid = int(token_id)
        if tid == blank_id:
            prev_id = None
            continue
        if tid == prev_id:
            continue
        prev_id = tid
        t = i * frame_sec
        reading = resolve_reading(vocab.decode_single(tid))
        for k, ch in enumerate(reading):
            chars.append(ch)
            times.append(t)
            is_anchor.append(k == len(reading) - 1)
    return chars, times, is_anchor


def _insert_note_subanchors(matched_time: List[Optional[float]], notes: Optional[List[NoteEvent]]) -> None:
    """ASRと一致せず補間予定になっている連続区間へ、その区間内にある未使用のノート開始時刻を
    疑似アンカーとして均等に挿入する(in-place)。1音符1文字が基本という前提で、直線補間だけでは
    表現できない「伸ばす音」「連続する同じ発音」の不均等な間隔をノートの実測値で補う。

    区間内の文字数よりノート数が少ない場合は間引いて割り当て、余った文字は挿入後の
    アンカー同士の間でこれまで通り直線補間される(呼び出し側の補間ループに委ねる)。
    曲の先頭・末尾で片側にしかアンカーが無い区間はノート割り当てを保留する
    (音符の対応範囲が不明瞭になり誤爆しやすいため)。
    """
    if not notes:
        return
    note_starts = sorted(n["start"] for n in notes)
    used = [False] * len(note_starts)
    n = len(matched_time)
    i = 0
    while i < n:
        if matched_time[i] is not None:
            i += 1
            continue
        gap_start = i
        while i < n and matched_time[i] is None:
            i += 1
        gap_end = i  # exclusive
        if gap_start == 0 or gap_end == n:
            continue  # 曲頭・曲末は前後どちらかのアンカーが無く範囲が定まらない
        prev_t = matched_time[gap_start - 1]
        next_t = matched_time[gap_end]
        candidates = [
            ci for ci, ns in enumerate(note_starts) if not used[ci] and prev_t <= ns <= next_t  # type: ignore[operator]
        ]
        gap_len = gap_end - gap_start
        k = len(candidates)
        picked = min(k, gap_len)
        for j in range(picked):
            # 候補がgap内の文字数より多い場合、先頭から詰めて選ぶと区間の前半に偏るため、
            # 候補全体から均等な間隔で選び直す(区間をなるべく均等にカバーする)。
            ci = (j * (k - 1)) // (picked - 1) if picked > 1 else 0
            note_idx = candidates[ci]
            used[note_idx] = True
            char_pos = gap_start + (j * gap_len) // picked
            matched_time[char_pos] = note_starts[note_idx]


def _sequence_align_reading_to_hypothesis(
    reading: str,
    hyp_chars: List[str],
    hyp_times: List[float],
    hyp_anchor: Optional[List[bool]] = None,
    notes: Optional[List[NoteEvent]] = None,
) -> Tuple[List[float], List[bool]]:
    """歌詞読み全体(reading)と自由デコード仮説(hyp_chars)を編集距離DPで対応付け、
    reading各文字の時刻(一致箇所はhypの時刻、それ以外は前後の一致点から線形補間)を返す。

    hyp_anchorを渡した場合、hyp_chars[j]の内容が一致してもhyp_anchor[j]がFalseな箇所
    (複数文字単位の末尾以外)は時刻アンカーとして採用しない(_greedy_decode_chars参照)。

    2つ目の戻り値は各文字が実際にhypの信頼できるアンカーとマッチしたか(True)/補間か(False)
    のフラグで、行のconfidence算出に使う。歌唱に対する認識精度は完璧ではない(認識ミス・脱落
    がある)ため、一致しない箇所は前後の一致点から時刻を補間するという割り切りで対処する
    (要件定義書v3 §4.4.7の「完全自動を目指さず手修正前提」の方針と整合)。notesを渡した場合、
    補間区間には可能な限りノート開始時刻を優先的に割り当てる(_insert_note_subanchors)。
    """
    n, m = len(reading), len(hyp_chars)
    if n == 0:
        return [], []
    if m == 0:
        return [0.0] * n, [False] * n

    dp = np.zeros((n + 1, m + 1), dtype=np.int32)
    dp[:, 0] = np.arange(n + 1)
    dp[0, :] = np.arange(m + 1)
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            cost_sub = 0 if reading[i - 1] == hyp_chars[j - 1] else 1
            dp[i, j] = min(
                dp[i - 1, j - 1] + cost_sub,
                dp[i - 1, j] + 1,
                dp[i, j - 1] + 1,
            )

    matched_time: List[Optional[float]] = [None] * n
    i, j = n, m
    while i > 0 and j > 0:
        cost_sub = 0 if reading[i - 1] == hyp_chars[j - 1] else 1
        if dp[i, j] == dp[i - 1, j - 1] + cost_sub:
            is_anchor = hyp_anchor[j - 1] if hyp_anchor is not None else True
            if cost_sub == 0 and is_anchor:
                matched_time[i - 1] = hyp_times[j - 1]
            i -= 1
            j -= 1
        elif dp[i, j] == dp[i - 1, j] + 1:
            i -= 1
        else:
            j -= 1

    matched_flags = [t is not None for t in matched_time]

    _insert_note_subanchors(matched_time, notes)

    times: List[float] = [0.0] * n
    for idx, t in enumerate(matched_time):
        if t is not None:
            times[idx] = t

    idx = 0
    while idx < n:
        if matched_time[idx] is not None:
            idx += 1
            continue
        prev_idx = idx - 1
        while prev_idx >= 0 and matched_time[prev_idx] is None:
            prev_idx -= 1
        next_idx = idx + 1
        while next_idx < n and matched_time[next_idx] is None:
            next_idx += 1
        prev_t = times[prev_idx] if prev_idx >= 0 else 0.0
        next_t = times[next_idx] if next_idx < n else prev_t
        prev_pos = prev_idx if prev_idx >= 0 else -1
        next_pos = next_idx if next_idx < n else n
        span = next_pos - prev_pos
        frac = (idx - prev_pos) / span if span > 0 else 0.0
        times[idx] = prev_t + (next_t - prev_t) * frac
        idx += 1

    return times, matched_flags


def _compute_full_log_probs(model, audio_16k_mono: np.ndarray, chunk_duration_sec: float = 20.0) -> np.ndarray:
    """曲全体のvocals音声をwav2vec2に通し、時間方向に連結したlog_probs行列(フレーム数, vocab_size)を返す。

    wav2vec2の自己注意は計算量がフレーム数の2乗に比例するため、数分の曲全体を一度に
    通すとCPUでは非現実的な時間・メモリを要する。そのため一定長のチャンクに区切って
    個別に推論し、結果を時間方向に単純連結する(重ね合わせやクロスフェードはしない)。
    チャンク境界をまたぐ文字の認識精度がわずかに落ちうるが、歌詞タイミング付けは
    完全自動を目標とせず手修正前提(要件定義書v3 §4.4.7)のため許容する。
    """
    chunk_samples = int(chunk_duration_sec * WAV2VEC2_SAMPLE_RATE)
    chunks_log_probs = []
    with torch.no_grad():
        for start in range(0, len(audio_16k_mono), chunk_samples):
            chunk = audio_16k_mono[start : start + chunk_samples]
            if len(chunk) == 0:
                continue
            normalized = _normalize_audio(chunk)
            logits = model(torch.from_numpy(normalized).unsqueeze(0)).logits
            chunks_log_probs.append(torch.log_softmax(logits, dim=-1)[0])
    if not chunks_log_probs:
        return np.zeros((0, model.config.vocab_size), dtype=np.float32)
    return torch.cat(chunks_log_probs, dim=0).numpy()


def align_lyrics_lines_to_song(
    lyrics_lines: List[str],
    vocals_audio_16k_mono: np.ndarray,
    model_path: Path,
    vocab: "Wav2Vec2Vocab | None" = None,
    notes: Optional[List[NoteEvent]] = None,
) -> List[AlignedLine]:
    """歌詞行のリスト全体を、曲全体のvocals音声に一括でアライメントする(要件定義書v3 §4.4.7)。

    VAD区間ごとにmin(歌詞行数, 検出区間数)で対応付けていた旧方式は、VADが想定と違う
    個数にフレーズを区切ると、そこから後ろの行が全部ズレるという問題があった(実機で
    「音程は正しいのに歌詞が付いていない箇所がある」という形で発現)。ctc-segmentation
    (ESPnetチーム実装、Apache-2.0)を使い、歌詞行を時系列順の1本の系列として曲全体に
    対して一括アライメントする方式に置き換える。歌詞行は曲中で必ず時系列順に出現する
    という前提のみに依存し、行の個数の対応付けミスが起きようがない。間奏・アドリブ等の
    「歌詞に無い区間」も、blankへの遷移コストが低いためDPが自然に読み飛ばす。

    戻り値は`lyrics_lines`と同じ長さ・同じ順序(1行1エントリ、対応付けの欠落は起きない)。
    空文字列の行(空行区切り)はaudioとの対応が無いため、前後の行の境界に押し付けられた
    ゼロ幅に近い区間になる(ctc_segmentationの空utteranceに対する自然な挙動、特別扱い不要)。
    """
    import ctc_segmentation as ctc_seg

    if vocab is None:
        vocab = Wav2Vec2Vocab()
    if not lyrics_lines:
        return []

    model = _load_wav2vec2_model(model_path)
    # 実config.json(reazon-research/japanese-wav2vec2-base-rs35kh)のpad_token_id=0が実際の
    # 学習時blank(2026-09-21実機デバッグで確認、align_tokens_to_audioの同名コメント参照)。
    # torchaudio.functional.forced_alignと違い、ctc_segmentationライブラリは「targetsにblank ID
    # を含んではいけない」という制約を持たない(targetsにid0が混入するケース—pyopenjtalk/vocab
    # 不一致時の<unk>フォールバック—で実際に例外が発生しないことを実機で確認済み)ため、
    # ここでは素直に実際のblankをそのまま使う。
    blank_id = model.config.pad_token_id

    lpz = _compute_full_log_probs(model, vocals_audio_16k_mono)

    readings = [text_to_hiragana_reading(line) for line in lyrics_lines]
    token_lists = [np.array(vocab.encode(reading), dtype=np.int64) for reading in readings]

    config = ctc_seg.CtcSegmentationParameters()
    config.index_duration = WAV2VEC2_STRIDE_SAMPLES / WAV2VEC2_SAMPLE_RATE
    config.blank = blank_id
    # 既定値(8000フレーム=160秒相当)のままだと、間奏やAメロ前の長いイントロを挟む曲で
    # 歌詞が曲冒頭のごく短い区間に圧縮されてしまう不具合があった(実機で確認)。
    # ctc-segmentationは元々「発話間の無音区間が短い」オーディオブック用途を想定した既定値のため、
    # 曲全体のフレーム数をそのまま初期ウィンドウ幅にして、どんな長さの間奏を挟んでも
    # 最初から曲全体を見渡せるようにする(公式ドキュメントも「行の間隔が離れているなら
    # 増やすこと」と明記: https://espnet.github.io/espnet/_modules/espnet2/bin/asr_align.html)。
    config.min_window_size = max(config.min_window_size, lpz.shape[0])
    # ctc-segmentationの既定(False)は「発話間のblank(無音)区間を通過するコストがゼロでない」
    # ため、DPが「後半の長いインスト区間を実コストを払って通過する」より「前半の短い区間に
    # 全歌詞を詰め込む」方を安く見積もってしまう問題があった。Trueにして、歌詞行間の
    # blank通過を無料にする(ctc-segmentation本来の間奏対応の使い方)。
    config.blank_transition_cost_zero = True
    # char_listはデバッグ用状態表示にのみ使われアライメント計算自体には影響しない
    # (ctc_segmentation.ctc_segmentation実装で確認済み)。vocab.json未収録の特殊トークン
    # id(vocab_size-1のblankを含む)にはWav2Vec2Vocab.decode_singleが"<unk>"を返す。
    config.char_list = [vocab.decode_single(i) for i in range(model.config.vocab_size)]

    ground_truth_mat, utt_begin_indices = ctc_seg.prepare_token_list(config, token_lists)
    timings, char_probs, _state_list = ctc_seg.ctc_segmentation(config, lpz, ground_truth_mat)
    segments = ctc_seg.determine_utterance_segments(config, utt_begin_indices, char_probs, timings, lyrics_lines)

    result: List[AlignedLine] = []
    for line_index, (line_text, (start, end, avg_log_prob)) in enumerate(zip(lyrics_lines, segments)):
        # avg_log_probはdetermine_utterance_segments内部でmin_prob=-1e10を「区間なし」の
        # 番兵値として使うため、その場合はexpせず信頼度0にする(exp(-1e10)は数学的には0だが
        # 意図を明示するため分岐する)。
        confidence = float(np.exp(avg_log_prob)) if avg_log_prob > -1e9 else 0.0
        ids = token_lists[line_index].tolist()
        timing_start = utt_begin_indices[line_index] + 1
        # この行の区間と重ならないノートは無関係(別の行・間奏のノートへ誤ってスナップしない)
        line_notes = [n for n in (notes or []) if n["end"] >= start and n["start"] <= end]
        token_timings = _build_aligned_reading_tokens(
            ids,
            timings[timing_start : timing_start + len(ids)],
            float(start),
            float(end),
            vocab,
            notes=line_notes,
        )
        result.append(
            {
                "text": line_text,
                "annotatedText": auto_annotate_ruby(line_text),
                "start": float(start),
                "end": float(end),
                "confidence": confidence,
                "tokenTimings": token_timings,
            }
        )
    return result


def align_lyrics_lines_via_free_decode(
    lyrics_lines: List[str],
    vocals_audio_16k_mono: np.ndarray,
    model_path: Path,
    vocab: "Wav2Vec2Vocab | None" = None,
    notes: Optional[List[NoteEvent]] = None,
) -> List[AlignedLine]:
    """歌詞行のリスト全体を、自由デコード+テキストアライメント方式でタイミング付けする
    (要件定義書v3 §4.4.7、align_lyrics_lines_to_songのctc-segmentation強制アライメント
    方式からの置き換え、2026-09-22実測検証に基づく判断)。

    強制アライメント方式は「与えられた歌詞全部をこの区間のどこかに配置しなければならない」
    という制約を持つため、モデルが実際には無音/伴奏残響と判断している箇所にも文字を
    割り当ててしまい、行の開始位置が実際の発音より系統的に早くなる問題があった
    (実測: 手動で完璧にタイミング合わせした正解データと比較して平均0.5秒程度、
    ctc_segmentationライブラリ内蔵の0.5秒安全マージンを除去しても解消せず、
    むしろ悪化するケースがあったため、マージンの問題ではなくモデルが実際に無音区間に
    誤って高い確信度を出していることを実験で確認した)。

    自由デコード(貪欲CTCデコード、"聞こえた通り"を出力させる)はモデル自身のblank確信度が
    そのまま使われるため無音を無音のまま扱え、実測で誤差0.1秒未満まで改善することを
    複数箇所で確認した。歌唱に対する認識精度自体は完璧ではない(認識ミス・脱落がある)ため、
    デコード結果と既知の歌詞を編集距離ベースのシーケンスアライメントですり合わせ、
    一致しない箇所は前後の一致点から線形補間する。

    align_lyrics_lines_to_song(ctc-segmentation版)は、wav2vec2モデル読み込み・blank ID・
    CTC長さ制約まわりの回帰テストとして引き続き価値があるため削除せず残している。
    """
    if vocab is None:
        vocab = Wav2Vec2Vocab()
    if not lyrics_lines:
        return []

    model = _load_wav2vec2_model(model_path)
    blank_id = model.config.pad_token_id
    frame_sec = WAV2VEC2_STRIDE_SAMPLES / WAV2VEC2_SAMPLE_RATE

    lpz = _compute_full_log_probs(model, vocals_audio_16k_mono)
    hyp_chars, hyp_times, hyp_anchor = _greedy_decode_chars(lpz, vocab, blank_id, frame_sec)

    readings = [text_to_hiragana_reading(line) for line in lyrics_lines]
    full_reading = "".join(readings)
    times, matched_flags = _sequence_align_reading_to_hypothesis(
        full_reading, hyp_chars, hyp_times, hyp_anchor, notes
    )

    duration_sec = len(vocals_audio_16k_mono) / WAV2VEC2_SAMPLE_RATE

    result: List[AlignedLine] = []
    offset = 0
    for line_text, reading in zip(lyrics_lines, readings):
        line_len = len(reading)
        annotated = auto_annotate_ruby(line_text)
        if line_len == 0:
            fallback_t = times[offset] if offset < len(times) else 0.0
            result.append(
                {
                    "text": line_text,
                    "annotatedText": annotated,
                    "start": float(fallback_t),
                    "end": float(fallback_t),
                    "confidence": 0.0,
                    "tokenTimings": [],
                }
            )
            continue

        line_centers = times[offset : offset + line_len]
        line_matched = matched_flags[offset : offset + line_len]
        next_offset = offset + line_len

        # 行の開始はその行最初の文字の認識時刻をそのまま使う(前の行との中間を取ると
        # 実測でむしろ精度が落ちることを確認済み。認識モデルが検出した瞬間そのものの方が
        # 信頼できるため)。終了は次の行の最初の文字との中間点(無音側のマージンを持たせる)。
        line_start = line_centers[0]
        next_start = times[next_offset] if next_offset < len(times) else duration_sec
        line_end = max(line_start, (line_centers[-1] + next_start) / 2)

        line_notes = [n for n in (notes or []) if n["end"] >= line_start and n["start"] <= line_end]
        token_timings = _build_reading_tokens_from_chars(
            list(reading), line_centers, line_start, line_end, notes=line_notes, matched=line_matched
        )

        confidence = sum(line_matched) / line_len

        result.append(
            {
                "text": line_text,
                "annotatedText": annotated,
                "start": float(line_start),
                "end": float(line_end),
                "confidence": float(confidence),
                "tokenTimings": token_timings,
            }
        )
        offset = next_offset

    return result
