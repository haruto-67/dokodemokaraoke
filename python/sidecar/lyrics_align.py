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
    # CTCのblank ID: 訂正(実機で発覚したバグ)。以前はmodel.config.pad_token_idを参照していたが、
    # _load_wav2vec2_model()はvocab_sizeだけを指定してWav2Vec2Configを新規構築しているため、
    # pad_token_idは元モデルの実値ではなく単なるHF既定値の0を返していただけだった。
    # 実際には本文中のwav2vec2_vocab.json(3000エントリ、id 0="<unk>")は"い"等の普通の文字を
    # 含む頻出IDであり、blank=0のままだとtargetsに0が含まれるケースが頻発し、
    # torchaudioのforced_alignが`targets Tensor shouldn't contain blank index`で例外を投げていた。
    # モデル本体の出力次元(vocab_size=3003)はvocab.jsonの3000エントリより3つ多く、
    # 元トークナイザーが追加した特殊トークン(<s>/</s>/<pad>)の分だと考えられる。<pad>は
    # 一般的な変換規約通り最後のクラスに割り当てられているとみなし、vocab_size-1をblankとする。
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
    start: float
    end: float
    confidence: float


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
    blank_id = model.config.vocab_size - 1  # align_tokens_to_audioと同じ根拠(コメント参照)

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
    for line_text, (start, end, avg_log_prob) in zip(lyrics_lines, segments):
        # avg_log_probはdetermine_utterance_segments内部でmin_prob=-1e10を「区間なし」の
        # 番兵値として使うため、その場合はexpせず信頼度0にする(exp(-1e10)は数学的には0だが
        # 意図を明示するため分岐する)。
        confidence = float(np.exp(avg_log_prob)) if avg_log_prob > -1e9 else 0.0
        result.append({"text": line_text, "start": float(start), "end": float(end), "confidence": confidence})
    return result
