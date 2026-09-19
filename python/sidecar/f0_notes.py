"""RMVPEのF0からノート化を行う(要件定義書v3 §4.4.3 STEP3 / §4.4.4 STEP4)。

方針(採用理由は[[どこカラv3の技術選定]]参照): Basic Pitch自身のCNNは使わず、
`basic_pitch.note_creation`のオンセット検出・エネルギー閾値によるノート区切り・
pitch bend推定だけを流用する。そのため、RMVPEが出す単一F0(モノフォニック)を
Basic Pitchが期待する{note, onset, contour}activation行列の形に自前で合成する
(＝各フレームで検出ピッチに対応するビンだけを立てた疑似activation)。

Basic Pitchの座標系(ANNOTATIONS_FPS=86.13→整数除算で86fps、audio_sample_rate=22050,
FFT_HOP=256)とRMVPEの座標系(100fps, 10msホップ)は異なるため、まずRMVPEの出力を
Basic Pitchの86fpsタイムラインへサンプル&ホールドでリサンプルしてから合成する。
"""

from __future__ import annotations

from typing import List, Tuple, TypedDict

import numpy as np
from basic_pitch.constants import (
    ANNOTATIONS_BASE_FREQUENCY,
    ANNOTATIONS_FPS,
    ANNOTATIONS_N_SEMITONES,
    CONTOURS_BINS_PER_SEMITONE,
    NOTES_BINS_PER_SEMITONE,
)

ONSET_THRESHOLD = 0.5
FRAME_THRESHOLD = 0.3
MIN_NOTE_LEN_FRAMES = 11

N_CONTOUR_BINS = ANNOTATIONS_N_SEMITONES * CONTOURS_BINS_PER_SEMITONE
N_NOTE_BINS = ANNOTATIONS_N_SEMITONES * NOTES_BINS_PER_SEMITONE


class NoteEvent(TypedDict):
    start: float
    end: float
    pitchMidi: int
    amplitude: float


def resample_f0(f0_hz: np.ndarray, source_fps: float, duration_sec: float) -> np.ndarray:
    """RMVPEのF0配列(source_fps)をBasic PitchのANNOTATIONS_FPS(86fps)へ
    サンプル&ホールドでリサンプルする。線形補間だと無声(0Hz)区間の前後で
    実在しないピッチが"それらしく"生成されてしまうため、最近傍を使う。
    """
    n_frames = max(1, int(round(duration_sec * ANNOTATIONS_FPS)))
    if len(f0_hz) == 0:
        return np.zeros(n_frames, dtype=np.float32)
    target_times = np.arange(n_frames) / ANNOTATIONS_FPS
    source_idx = np.clip(np.round(target_times * source_fps).astype(int), 0, len(f0_hz) - 1)
    return f0_hz[source_idx].astype(np.float32)


def _freq_to_bin(freq_hz: np.ndarray, bins_per_semitone: int) -> np.ndarray:
    return 12 * bins_per_semitone * np.log2(freq_hz / ANNOTATIONS_BASE_FREQUENCY)


def f0_to_basic_pitch_activation(f0_hz_86fps: np.ndarray) -> dict:
    """86fpsのF0配列から{note, onset, contour}のactivation行列を合成する。

    - contour: 検出ビンとその隣接ビンに線形按分の重みを置く(`get_pitch_bends`が
      ノート区間の重心からベンドを推定するため、単一ビンだけだとベンドが常に0になる)。
    - note(frame): 検出ビンに1.0を立てる。
    - onset: 無声→有声、またはピッチが検出範囲外→範囲内に変わった最初のフレームに1.0を立てる。
    """
    n_frames = len(f0_hz_86fps)
    contour = np.zeros((n_frames, N_CONTOUR_BINS), dtype=np.float32)
    frame = np.zeros((n_frames, N_NOTE_BINS), dtype=np.float32)
    onset = np.zeros((n_frames, N_NOTE_BINS), dtype=np.float32)

    voiced = f0_hz_86fps > 0
    contour_bin_f = np.zeros(n_frames)
    note_bin_i = np.zeros(n_frames, dtype=int)
    if np.any(voiced):
        contour_bin_f[voiced] = _freq_to_bin(f0_hz_86fps[voiced], CONTOURS_BINS_PER_SEMITONE)
        note_bin_f = _freq_to_bin(f0_hz_86fps[voiced], NOTES_BINS_PER_SEMITONE)
        note_bin_i[voiced] = np.clip(np.round(note_bin_f).astype(int), 0, N_NOTE_BINS - 1)

    in_range = voiced & (contour_bin_f >= 0) & (contour_bin_f < N_CONTOUR_BINS - 1)

    prev_voiced = False
    for t in range(n_frames):
        if not in_range[t]:
            prev_voiced = False
            continue
        lo = int(np.floor(contour_bin_f[t]))
        frac = float(contour_bin_f[t] - lo)
        contour[t, lo] = max(contour[t, lo], 1.0 - frac)
        contour[t, lo + 1] = max(contour[t, lo + 1], frac)
        frame[t, note_bin_i[t]] = 1.0
        if not prev_voiced:
            onset[t, note_bin_i[t]] = 1.0
        prev_voiced = True

    return {"note": frame, "onset": onset, "contour": contour}


def notes_from_f0(f0_hz_source_fps: np.ndarray, source_fps: float, duration_sec: float) -> Tuple[List[NoteEvent], np.ndarray]:
    """RMVPEのF0配列からノート列を作る。

    戻り値:
      notes: [{"start": 秒, "end": 秒, "pitchMidi": int, "amplitude": 0..1}, ...] (開始時刻順)
      f0_86fps: Basic Pitchのタイムベース(86fps)にリサンプルしたF0配列(保存・可視化用)
    """
    from basic_pitch.note_creation import model_output_to_notes

    f0_86fps = resample_f0(f0_hz_source_fps, source_fps, duration_sec)
    activation = f0_to_basic_pitch_activation(f0_86fps)
    _midi, note_events_raw = model_output_to_notes(
        activation,
        onset_thresh=ONSET_THRESHOLD,
        frame_thresh=FRAME_THRESHOLD,
        min_note_len=MIN_NOTE_LEN_FRAMES,
        infer_onsets=False,  # onsetは既にf0_to_basic_pitch_activationで自前検出済み
        melodia_trick=True,
    )
    notes: List[NoteEvent] = [
        {"start": float(start), "end": float(end), "pitchMidi": int(pitch), "amplitude": float(amp)}
        for start, end, pitch, amp, _bends in note_events_raw
    ]
    notes.sort(key=lambda n: n["start"])
    return notes, f0_86fps
