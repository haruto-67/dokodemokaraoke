"""【調整用】母音の聞き取り(フレームごとの母音分類)の正解率を、手修正済みの正解プロジェクトで測る。

正解のモーラ区間(先頭3割は子音・遷移として除く)の有声フレームに、そのモーラの母音を正解ラベルとして付け、
各分類器のフレームごとの最尤クラスと比べる。

- ctc: wav2vec2のCTC出力を母音へ集約したもの(初回DPの入力)
- self: 曲ごとの自己学習(DPの配置をラベルにしたMFCCのロジスティック回帰。アプリの現行)
- oracle: 正解ラベルで学習した場合(曲を前半・後半に分けて交差検証)。その特徴で届く上限の目安

使い方: python3 vowel_accuracy.py <展開済み正解プロジェクト> <vowel_dp_align.pyの--cache> [--lines=N]
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "python" / "sidecar"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from eval_alignment import gt_lines  # noqa: E402
from vowel_align import _VOWEL_OF, CLASSES, FRAME_SEC, Features, Params, align, silence_prob  # noqa: E402


def gt_frame_labels(gt: list, n: int, sil: np.ndarray) -> np.ndarray:
    y = np.full(n, -1)
    morae = [m for g in gt for m in g["morae"]]
    for i, m in enumerate(morae):
        end = morae[i + 1]["start"] if i + 1 < len(morae) else m["start"] + 0.3
        end = min(end, m.get("end", end))
        last = m["reading"].strip()[-1]
        cls = "N" if last == "ん" else _VOWEL_OF.get(last)
        if cls is None:
            continue
        s, e = int(m["start"] / FRAME_SEC), int(end / FRAME_SEC)
        for t in range(s + int((e - s) * 0.3), min(e, n)):
            if sil[t] < 0.3:
                y[t] = CLASSES.index(cls)
    return y


def accuracy(p: np.ndarray, y: np.ndarray) -> str:
    m = y >= 0
    pred = p[m].argmax(1)
    acc = (pred == y[m]).mean()
    per = " ".join(f"{c}{(pred[y[m] == k] == k).mean():.2f}" for k, c in enumerate(CLASSES) if (y[m] == k).any())
    return f"{acc:.3f} ({per})"


def oracle(x: np.ndarray, y: np.ndarray, c: float = 1.0) -> np.ndarray:
    """前半で学習→後半を予測、後半で学習→前半を予測。"""
    from sklearn.linear_model import LogisticRegression

    out = np.zeros((len(x), len(CLASSES)))
    labeled = np.nonzero(y >= 0)[0]
    mid = labeled[len(labeled) // 2]
    for tr, te in [(np.arange(len(x)) < mid, np.arange(len(x)) >= mid), (np.arange(len(x)) >= mid, np.arange(len(x)) < mid)]:
        m = tr & (y >= 0)
        clf = LogisticRegression(C=c, max_iter=3000, class_weight="balanced").fit(x[m], y[m])
        out[np.ix_(te, clf.classes_)] = clf.predict_proba(x[te])
    return out


def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    n_lines = next((int(a.split("=", 1)[1]) for a in sys.argv if a.startswith("--lines=")), None)
    project_dir, cache = Path(args[0]), Path(args[1])
    project = json.loads((project_dir / "project.json").read_text())
    gt = gt_lines(project)[:n_lines]
    z = np.load(cache)
    feats = Features(ctc_vp=z["ctc_vp"], f0=z["f0"], db=z["db"], frame_feats=z["frame_feats"], attack=z["attack"])
    params = Params()
    n = len(feats.ctc_vp)
    sil = silence_prob(feats.f0, feats.db, n, params)
    y = gt_frame_labels(gt, n, sil)
    print(f"正解ラベル付きフレーム: {(y >= 0).sum()}")

    lines = [l["text"] for l in project["lyrics"]]
    result = align(lines, feats, project["analysis"]["notes"], params)
    print("ctc        ", accuracy(feats.ctc_vp, y))
    print("self(現行) ", accuracy(result.vowel_p, y))
    print("oracle(現行の特徴)", accuracy(oracle(feats.frame_feats, y), y))


if __name__ == "__main__":
    main()
