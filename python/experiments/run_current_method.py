"""【実験】比較用に、現行方式(自由デコード+編集距離、lyrics_align.align_lyrics_lines_via_free_decode)を
展開済みプロジェクトのvocal.wavとanalysis.notesで実行し、結果をJSONに書き出す。

使い方: resources/python-runtime/bin/python3 python/experiments/run_current_method.py <展開済みプロジェクト> <出力.json>
"""

import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "python" / "sidecar"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from lyrics_align import align_lyrics_lines_via_free_decode  # noqa: E402
from vowel_dp_align import MODEL_PATH, load_vocal_16k  # noqa: E402


def main() -> None:
    project_dir, out_json = Path(sys.argv[1]), Path(sys.argv[2])
    project = json.loads((project_dir / "project.json").read_text())
    lines = [l["text"] for l in project["lyrics"]]
    result = align_lyrics_lines_via_free_decode(
        lines, load_vocal_16k(project_dir), MODEL_PATH, notes=project["analysis"]["notes"]
    )
    # 評価スクリプトが読む共通形式(行ごとのstartと、モーラ単位のreading/start)にそろえる
    out = [
        {
            "text": l["text"],
            "start": l["start"],
            "end": l["end"],
            "morae": [{"reading": t["reading"], "start": t["start"], "end": t["end"]} for t in l["tokenTimings"]],
        }
        for l in result
    ]
    out_json.write_text(json.dumps({"lyrics": out}, ensure_ascii=False))


if __name__ == "__main__":
    main()
