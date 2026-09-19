"""ボーカル/伴奏分離(要件定義書v3 §4.4.2 STEP2)。

melband-roformer-infer(MIT, https://github.com/openmirlab/melband-roformer-infer)の
Mel-Band RoFormerアーキテクチャ実装を使い、同梱チェックポイント
(resources/models/melband-roformer-kim-vocals/MelBandRoformer.ckpt)のみで
完全オフライン推論する。パッケージが公開している高レベルAPI
(`MelBandRoformerSession`)は現時点のPyPI版(0.1.5)には未収録のため、
同バージョンで使える低レベルAPI(`ensure_model_assets` /
`get_model_from_config` / `demix_track`)を直接呼び出す。

`demix_track`(実際のチャンク分割+オーバーラップ加算ループ)は進捗を
`sys.stdout`への`\\r`書き込みでしか報告しない。サイドカーのstdoutは
JSON-RPC風プロトコル(1行1メッセージ)専用のため、このテキストをそのまま
垂れ流すとプロトコルが壊れる。そこで実行中だけstdoutを差し替えて横取りし、
"Estimated total/remaining processing time" の行から進捗率を計算して
コールバックに変換する(推論アルゴリズム自体は改変せず、upstreamの実装を
そのまま使う)。
"""

from __future__ import annotations

import contextlib
import io
import re
from pathlib import Path
from typing import Callable, Optional

import numpy as np
import soundfile as sf
import torch
import yaml
from ml_collections import ConfigDict

DEFAULT_MODEL = "melband-roformer-kim-vocals"

_TOTAL_TIME_RE = re.compile(r"Estimated total processing time for this track:\s*([\d.]+)\s*seconds")
_REMAINING_RE = re.compile(r"Estimated time remaining:\s*([\d.]+)\s*seconds")

ProgressCallback = Callable[[float], None]


class _ProgressInterceptStream(io.TextIOBase):
    """demix_trackの標準出力書き込みを横取りし、進捗率(0..1)に変換するストリーム。

    パースできない行は黙って捨てる(進捗表示はベストエフォートであり、
    upstreamの出力文言が変わっても分離処理自体は失敗させないため)。
    """

    def __init__(self, on_progress: Optional[ProgressCallback]) -> None:
        super().__init__()
        self._on_progress = on_progress
        self._total_seconds: Optional[float] = None

    def write(self, text: str) -> int:  # type: ignore[override]
        if self._on_progress is None:
            return len(text)
        for chunk in text.replace("\r", "\n").split("\n"):
            total_match = _TOTAL_TIME_RE.search(chunk)
            if total_match:
                self._total_seconds = float(total_match.group(1))
                continue
            remaining_match = _REMAINING_RE.search(chunk)
            if remaining_match and self._total_seconds:
                remaining = float(remaining_match.group(1))
                fraction = 1 - (remaining / self._total_seconds)
                self._on_progress(max(0.0, min(1.0, fraction)))
        return len(text)

    def flush(self) -> None:  # type: ignore[override]
        pass


def separate_vocals(
    source_wav_path: Path,
    output_dir: Path,
    models_dir: Path,
    on_progress: Optional[ProgressCallback] = None,
) -> tuple[Path, Path]:
    """1本の音源をvocals/instrumentalに分離し、生成したwavのパスを返す。

    Mac(arm64)専用アプリのためCUDA/MPSどちらも前提にせずCPUで実行する
    (melband-roformer-inferはMPSを未サポートのため、明示的にcpuを指定する。
    §9バックログのCore ML化はここに手を入れる)。
    """
    from mel_band_roformer import ensure_model_assets, get_model_from_config
    from mel_band_roformer.utils import demix_track

    ckpt_path, config_path = ensure_model_assets(DEFAULT_MODEL, models_dir=models_dir, download_missing=False)

    with config_path.open() as handle:
        config = ConfigDict(yaml.safe_load(handle))

    model = get_model_from_config("mel_band_roformer", config)
    state = torch.load(ckpt_path, map_location="cpu")
    model.load_state_dict(state)
    model = model.eval()

    mix, sample_rate = sf.read(source_wav_path)
    original_mono = mix.ndim == 1
    stereo_mix = mix if not original_mono else np.stack([mix, mix], axis=-1)
    mixture = torch.tensor(stereo_mix.T, dtype=torch.float32)

    stream = _ProgressInterceptStream(on_progress)
    with contextlib.redirect_stdout(stream):
        result, _first_chunk_time = demix_track(config, model, mixture, "cpu")
    # チャンク数が少ない(曲が短い)場合、demix_track内で"remaining"行が一度も
    # 出力されずon_progressが未呼び出しのまま終わることがある。完了は必ず通知する。
    if on_progress is not None:
        on_progress(1.0)

    vocals = result["vocals"].T
    if original_mono:
        vocals = vocals[:, 0]
        original_mix_for_residual = mix
    else:
        original_mix_for_residual = stereo_mix
    instrumental = original_mix_for_residual - vocals

    output_dir.mkdir(parents=True, exist_ok=True)
    vocals_path = output_dir / "vocals.wav"
    instrumental_path = output_dir / "instrumental.wav"
    sf.write(vocals_path, vocals, sample_rate)
    sf.write(instrumental_path, instrumental, sample_rate)

    return vocals_path, instrumental_path
