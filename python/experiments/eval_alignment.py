"""【実験】歌詞タイミングの結果JSONを、手編集済みの正解プロジェクトと比べて誤差を出す。

結果JSONは {"lyrics": [{"text", "start", "morae": [{"reading", "start"}, ...]}, ...]} の形
(vowel_dp_align.py / run_current_method.py の出力)。行単位・モーラ単位の開始時刻の誤差
(予測-正解。負なら早すぎ)の平均絶対値・最大・平均(符号付き)を出す。

使い方: python3 eval_alignment.py <展開済み正解プロジェクト> 名前1=<結果1.json> [名前2=<結果2.json> ...] [--detail]
"""

import difflib
import json
import sys
from pathlib import Path

_SAME_SOUND = str.maketrans({"は": "わ", "へ": "え", "を": "お"})
_KANA_EXTRA = set("んっー")


def _norm(reading: str) -> str:
    return reading.strip().translate(_SAME_SOUND)


def _is_mora(reading: str) -> bool:
    r = reading.strip()
    return bool(r) and all("ぁ" <= c <= "ゖ" or c in _KANA_EXTRA for c in r)


def gt_lines(project: dict) -> list:
    out = []
    for line in project["lyrics"]:
        morae = []
        for t in line["tokens"]:
            reading = (t["ruby"] if t["ruby"] is not None else t["text"]).strip()
            if _is_mora(reading):
                morae.append({"reading": reading, "start": t["start"]})
        out.append({"text": line["text"], "start": line["start"], "morae": morae})
    return out


def pair_morae(gt: list, pred: list) -> list:
    """同じ行の正解モーラと予測モーラを対応付ける。数が同じなら順番どおり、
    違えば読みの一致で対応付ける(一致しない区間は長さが同じ時だけ順番どおり)。"""
    pred = [p for p in pred if _is_mora(p["reading"])]
    if len(gt) == len(pred):
        return list(zip(gt, pred))
    a = [_norm(g["reading"]) for g in gt]
    b = [_norm(p["reading"]) for p in pred]
    pairs = []
    for op, i1, i2, j1, j2 in difflib.SequenceMatcher(None, a, b, autojunk=False).get_opcodes():
        if op == "equal" or (op == "replace" and i2 - i1 == j2 - j1):
            pairs.extend(zip(gt[i1:i2], pred[j1:j2]))
    return pairs


def stats(errs: list) -> dict:
    if not errs:
        return {"n": 0}
    abs_e = [abs(e) for e in errs]
    return {
        "n": len(errs),
        "mean_abs": sum(abs_e) / len(errs),
        "max_abs": max(abs_e),
        "mean_signed": sum(errs) / len(errs),
    }


def evaluate(gt: list, pred_lines: list) -> dict:
    line_errs, mora_rows = [], []
    for li, (g, p) in enumerate(zip(gt, pred_lines)):
        line_errs.append(p["start"] - g["start"])
        for gm, pm in pair_morae(g["morae"], p["morae"]):
            mora_rows.append(
                {"line": li, "reading": gm["reading"], "gt": gm["start"], "pred": pm["start"], "err": pm["start"] - gm["start"]}
            )
    return {
        "line": stats(line_errs),
        "line_errs": line_errs,
        "mora": stats([r["err"] for r in mora_rows]),
        "mora_rows": mora_rows,
        "gt_morae": sum(len(g["morae"]) for g in gt),
    }


def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    detail = "--detail" in sys.argv
    project = json.loads((Path(args[0]) / "project.json").read_text())
    gt = gt_lines(project)
    results = {}
    for spec in args[1:]:
        name, path = spec.split("=", 1)
        results[name] = evaluate(gt, json.loads(Path(path).read_text())["lyrics"])

    fmt = lambda s: f"{s['mean_abs']:.3f} / {s['max_abs']:.3f} / {s['mean_signed']:+.3f}" if s["n"] else "-"
    print("| 方式 | 行 平均絶対/最大/平均(符号) [秒] | モーラ 平均絶対/最大/平均(符号) [秒] | 対応付けたモーラ数 |")
    print("|---|---|---|---|")
    for name, r in results.items():
        print(f"| {name} | {fmt(r['line'])} | {fmt(r['mora'])} | {r['mora']['n']}/{r['gt_morae']} |")
    if detail:
        names = list(results)
        print()
        print("| 行 | 読み | 正解 | " + " | ".join(names) + " |")
        print("|---|---|---|" + "---|" * len(names))
        rows = {n: {(r["line"], round(r["gt"], 4)): r for r in results[n]["mora_rows"]} for n in names}
        for g_li, g in enumerate(gt):
            for gm in g["morae"]:
                key = (g_li, round(gm["start"], 4))
                cells = []
                for n in names:
                    r = rows[n].get(key)
                    cells.append(f"{r['err']:+.2f}" if r else "-")
                print(f"| {g_li + 1} | {gm['reading']} | {gm['start']:.2f} | " + " | ".join(cells) + " |")


if __name__ == "__main__":
    main()
