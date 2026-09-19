"""どこカラv3 Pythonサイドカーのエントリポイント。

Electronのメインプロセスと stdin/stdout 経由でJSON-RPC風メッセージ
(1行1メッセージ)をやり取りする。プロトコルの定義は
`src/shared/pythonSidecarProtocol.ts` を正とする。

現在実装済みのSTEP(要件定義書v3 §4.4):
- STEP2 ボーカル/伴奏分離(Mel-Band RoFormer) -- separation.py

STEP1(音源取得の正規化)・STEP3〜7(F0抽出・ノート化・歌詞アライメント)は
未実装。`analyze` はそれらが揃うまで、分離結果(vocals/instrumentalのパス)
のみを返す。

標準ライブラリ以外の重い依存(torch等)は `separation` モジュール内でのみ
importする(起動・疎通確認だけならtorch無しでも動くようにするため)。
"""

import json
import sys
from pathlib import Path


def send(message: dict) -> None:
    sys.stdout.write(json.dumps(message, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _send_progress(req_id: str, progress: float, status: str, detail: str | None = None) -> None:
    payload = {
        "id": "vocalIsolation",
        "label": "ボーカル/伴奏分離(Mel-Band RoFormer)",
        "progress": progress,
        "status": status,
    }
    if detail is not None:
        payload["detail"] = detail
    send({"type": "progress", "id": req_id, "progress": payload})


def handle_analyze(req: dict) -> None:
    req_id = req["id"]
    params = req.get("params", {})

    try:
        source_audio_path = Path(params["sourceAudioPath"])
        work_dir = Path(params["workDir"])
    except KeyError as exc:
        send({"type": "error", "id": req_id, "message": f"analyzeパラメータが不足しています: {exc}"})
        return

    import paths
    import separation

    _send_progress(req_id, 0.0, "running")
    try:
        vocals_path, instrumental_path = separation.separate_vocals(
            source_audio_path,
            work_dir,
            paths.models_dir(),
            on_progress=lambda fraction: _send_progress(req_id, fraction, "running"),
        )
    except Exception as exc:  # noqa: BLE001 -- 失敗理由をerrorメッセージとして呼び出し側に伝える境界
        send({"type": "error", "id": req_id, "message": f"ボーカル分離に失敗しました: {exc}"})
        return

    _send_progress(req_id, 1.0, "done")

    # STEP3以降(F0抽出/ノート化/歌詞アライメント)は後続タスクで実装する。
    # 現時点ではSTEP2の生成物のパスのみを返す。
    send(
        {
            "type": "done",
            "id": req_id,
            "result": {
                "vocalsPath": str(vocals_path),
                "instrumentalPath": str(instrumental_path),
            },
        }
    )


def handle_cancel(req: dict) -> None:
    # STEP2はチャンク単位のループ(demix_track)を同期的に実行しており、
    # まだ途中終了に対応していない。ここでの受信ログのみ残す。
    target_id = req.get("params", {}).get("targetId")
    sys.stderr.write(f"[sidecar] cancel要求を受信 (targetId={target_id}, 現状は無視)\n")


def main() -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            sys.stderr.write(f"[sidecar] JSONとして解釈できない行を無視: {line}\n")
            continue

        method = req.get("method")
        if method == "analyze":
            handle_analyze(req)
        elif method == "cancel":
            handle_cancel(req)
        else:
            send({"type": "error", "id": req.get("id", "unknown"), "message": f"未対応のmethod: {method}"})


if __name__ == "__main__":
    main()
