"""【調整用】英語が主の曲の歌詞タイミング付け(sidecar/phoneme_align.py)を、展開済みプロジェクトに対して実行する。
結果は eval_alignment.py で正解データと比べる。

使い方(リポジトリ直下で、同梱Pythonから):
  resources/python-runtime/bin/python3 python/experiments/phoneme_ctc_align.py <展開済みプロジェクト> <出力.json> [--cache 特徴.npz]
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "python" / "sidecar"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from phoneme_align import MODEL_FILENAME, align, load_phoneme_model, phoneme_log_probs  # noqa: E402
from vowel_align import attack_strength  # noqa: E402
from vowel_dp_align import RMVPE_PATH, load_vocal_16k  # noqa: E402

MODEL_PATH = REPO / "resources" / "models" / MODEL_FILENAME


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("project_dir", type=Path)
    ap.add_argument("out_json", type=Path)
    ap.add_argument("--cache", type=Path, help="音素のlog確率とF0のキャッシュ(.npz)")
    args = ap.parse_args()

    if args.cache and args.cache.exists():
        z = np.load(args.cache)
        log_probs, f0 = z["log_probs"], z["f0"]
        attack = z["attack"] if "attack" in z else attack_strength(load_vocal_16k(args.project_dir))
        _, vocab = load_phoneme_model(MODEL_PATH)
    else:
        from rmvpe_model import RMVPE

        audio = load_vocal_16k(args.project_dir)
        f0 = RMVPE(str(RMVPE_PATH), device="cpu").infer_from_audio(audio)
        log_probs, vocab = phoneme_log_probs(audio, MODEL_PATH)
        attack = attack_strength(audio)
        if args.cache:
            np.savez(args.cache, log_probs=log_probs, f0=f0, attack=attack)
    project = json.loads((args.project_dir / "project.json").read_text())
    lines = [l["text"] for l in project["lyrics"]]
    aligned, heard = align(lines, log_probs, vocab, f0, attack)
    out = {
        "lyrics": [{"text": l["text"], "start": l["start"], "end": l["end"], "morae": l["tokenTimings"]} for l in aligned],
        "heard_sounds": heard,
    }
    args.out_json.write_text(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
