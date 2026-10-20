"""【調整用】歌詞タイミング付け(sidecar/vowel_align.py)を、展開済みプロジェクトに対して実行する。

アプリの解析と同じ処理を、パラメータを変えながら手元で試すためのスクリプト。結果は
eval_alignment.py で正解データと比べる。

使い方(リポジトリ直下で、同梱Pythonから):
  resources/python-runtime/bin/python3 python/experiments/vowel_dp_align.py <展開済みプロジェクト> <出力.json> \\
      [--cache 特徴.npz] [--set 名前=値 ...]
<展開済みプロジェクト>は .dokokara(zip)を展開したディレクトリ(project.json と audio/vocal.wav を含む)。
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "python" / "sidecar"))

from vowel_align import SR, Features, Params, align, compute_features, heard_sounds, to_aligned_lines  # noqa: E402

MODEL_PATH = REPO / "resources" / "models" / "japanese-wav2vec2-base-rs35kh.safetensors"
RMVPE_PATH = REPO / "resources" / "models" / "rmvpe.pt"


def load_vocal_16k(project_dir: Path) -> np.ndarray:
    import librosa
    import soundfile as sf

    audio, sr = sf.read(project_dir / "audio" / "vocal.wav")
    if audio.ndim > 1:
        audio = librosa.to_mono(audio.T)
    return librosa.resample(audio, orig_sr=sr, target_sr=SR).astype(np.float32)


def load_features(project_dir: Path, cache: Path | None, params: Params) -> Features:
    if cache and cache.exists():
        z = np.load(cache)
        return Features(ctc_vp=z["ctc_vp"], f0=z["f0"], db=z["db"], frame_feats=z["frame_feats"])
    from rmvpe_model import RMVPE

    audio = load_vocal_16k(project_dir)
    f0 = RMVPE(str(RMVPE_PATH), device="cpu").infer_from_audio(audio)
    feats = compute_features(audio, f0, MODEL_PATH, params)
    if cache:
        np.savez(cache, ctc_vp=feats.ctc_vp, f0=feats.f0, db=feats.db, frame_feats=feats.frame_feats)
    return feats


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("project_dir", type=Path)
    ap.add_argument("out_json", type=Path)
    ap.add_argument("--cache", type=Path, help="音響特徴のキャッシュ(.npz)。MFCCの設定を変える時は作り直す")
    ap.add_argument("--beat", metavar="BPM,最初の拍,分割", help="拍の格子(例: 188,0.045,2 は188BPMの8分音符)")
    ap.add_argument("--set", action="append", default=[], metavar="名前=値", help="Paramsの値を上書きする(切り分け用)")
    args = ap.parse_args()

    params = Params()
    for kv in args.set:
        k, v = kv.split("=", 1)
        setattr(params, k, type(getattr(params, k))(v))

    project = json.loads((args.project_dir / "project.json").read_text())
    lines = [l["text"] for l in project["lyrics"]]
    feats = load_features(args.project_dir, args.cache, params)
    beat_times = None
    if args.beat:
        bpm, first, div = (float(x) for x in args.beat.split(","))
        step = 60 / bpm / div
        dur = len(feats.ctc_vp) * 0.02
        beat_times = first + step * np.arange(-int(first / step), int((dur - first) / step) + 1)
    result = align(lines, feats, project["analysis"]["notes"], params, beat_times=beat_times)
    for it, cost, moved in result.history:
        print(f"iter {it}: cost={cost:.1f} moved={moved}", file=sys.stderr)

    aligned = to_aligned_lines(lines, result)
    out = {
        "params": params.__dict__,
        # eval_alignment.py が読む形(行ごとのstartと、モーラ単位のreading/start)
        "lyrics": [
            {"text": l["text"], "start": l["start"], "end": l["end"], "confidence": l["confidence"], "morae": l["tokenTimings"]}
            for l in aligned
        ],
        "heard_sounds": heard_sounds(result.vowel_p, result.sil),
    }
    args.out_json.write_text(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
