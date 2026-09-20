"""Silero VADによるフレーズ区間検出(要件定義書v3 §4.4.5 STEP5)。

同梱の`silero_vad.jit`(TorchScript, MIT)を直接呼び出す薄い実装。公式の
`silero-vad` pipパッケージが提供する`get_speech_timestamps`ユーティリティは
使わず(オフライン同梱の.jitファイル単体で完結させるため)、同じ考え方
(512サンプル/16kHzチャンクごとの発話確率→閾値+ハングオーバーでセグメント化)
を自前で実装する。
"""

from __future__ import annotations

from pathlib import Path
from typing import List, TypedDict

import numpy as np
import torch

SAMPLE_RATE = 16000
WINDOW_SAMPLES = 512  # Silero VADが16kHzで受け付ける固定チャンクサイズ
CHUNK_SEC = WINDOW_SAMPLES / SAMPLE_RATE


class PhraseSegment(TypedDict):
    start: float
    end: float


def _chunk_probabilities(audio_16k_mono: np.ndarray, model: torch.jit.ScriptModule) -> np.ndarray:
    n_chunks = len(audio_16k_mono) // WINDOW_SAMPLES
    probs = np.zeros(n_chunks, dtype=np.float32)
    with torch.no_grad():
        for i in range(n_chunks):
            chunk = torch.from_numpy(audio_16k_mono[i * WINDOW_SAMPLES : (i + 1) * WINDOW_SAMPLES]).float()
            probs[i] = model(chunk, SAMPLE_RATE).item()
    return probs


def segments_from_probabilities(
    probs: np.ndarray,
    total_duration_sec: float,
    threshold: float = 0.5,
    min_speech_duration_sec: float = 0.25,
    min_silence_duration_sec: float = 0.3,
    speech_pad_sec: float = 0.1,
) -> List[PhraseSegment]:
    """チャンクごとの発話確率配列から、ハングオーバー処理込みでセグメントを合成する。

    純粋な数値処理のみ(モデル呼び出しを含まない)なので、実モデル無しでテストできる。
    """
    is_speech = probs >= threshold
    min_silence_chunks = max(1, round(min_silence_duration_sec / CHUNK_SEC))
    min_speech_chunks = max(1, round(min_speech_duration_sec / CHUNK_SEC))

    raw_segments: list[tuple[int, int]] = []
    start_idx: int | None = None
    silence_run = 0
    for i, speech in enumerate(is_speech):
        if speech:
            if start_idx is None:
                start_idx = i
            silence_run = 0
        elif start_idx is not None:
            silence_run += 1
            if silence_run >= min_silence_chunks:
                raw_segments.append((start_idx, i - silence_run + 1))
                start_idx = None
                silence_run = 0
    if start_idx is not None:
        raw_segments.append((start_idx, len(is_speech) - silence_run))

    result: List[PhraseSegment] = []
    for s, e in raw_segments:
        if e - s < min_speech_chunks:
            continue
        start_sec = max(0.0, s * CHUNK_SEC - speech_pad_sec)
        end_sec = min(total_duration_sec, e * CHUNK_SEC + speech_pad_sec)
        if end_sec > start_sec:
            result.append({"start": start_sec, "end": end_sec})
    return result


def detect_phrases(
    audio_16k_mono: np.ndarray,
    model_path: Path,
    threshold: float = 0.5,
    min_speech_duration_sec: float = 0.25,
    min_silence_duration_sec: float = 0.3,
    speech_pad_sec: float = 0.1,
) -> List[PhraseSegment]:
    model = torch.jit.load(str(model_path))
    model.eval()
    probs = _chunk_probabilities(audio_16k_mono, model)
    total_duration_sec = len(audio_16k_mono) / SAMPLE_RATE
    return segments_from_probabilities(
        probs,
        total_duration_sec,
        threshold=threshold,
        min_speech_duration_sec=min_speech_duration_sec,
        min_silence_duration_sec=min_silence_duration_sec,
        speech_pad_sec=speech_pad_sec,
    )
