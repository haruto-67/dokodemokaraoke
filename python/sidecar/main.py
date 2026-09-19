"""どこカラv3 Pythonサイドカーのエントリポイント。

Electronのメインプロセスと stdin/stdout 経由でJSON-RPC風メッセージ
(1行1メッセージ)をやり取りする。プロトコルの定義は
`src/shared/pythonSidecarProtocol.ts` を正とする。

現時点では通信の枠組み(このファイル)のみが完成しており、実際の解析処理
(ボーカル分離・F0抽出・ノート化・歌詞アライメント等、要件定義書v3 §4.4の
各STEP)は未実装。`analyze` は後続タスクで各STEPの実装に置き換わるまでの
スタブとして、受け取ったパラメータをそのまま返すだけの動作をする。

標準ライブラリのみに依存する(torch等の重い依存を読み込まなくても
起動・疎通確認ができるようにするため)。
"""

import json
import sys


def send(message: dict) -> None:
    sys.stdout.write(json.dumps(message, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def handle_analyze(req: dict) -> None:
    req_id = req["id"]
    params = req.get("params", {})

    # 実際のSTEP(音源取得/分離/F0抽出/ノート化/VAD/モーラ読み変換/
    # フォースドアライメント)が実装されるまでの仮の進捗通知。
    send(
        {
            "type": "progress",
            "id": req_id,
            "progress": {
                "id": "pitch",
                "label": "(スタブ) 解析パイプライン未実装",
                "progress": 1.0,
                "status": "skipped",
                "detail": "python/sidecar/ の各STEP実装待ち",
            },
        }
    )
    send(
        {
            "type": "done",
            "id": req_id,
            "result": {"stub": True, "receivedParams": params},
        }
    )


def handle_cancel(req: dict) -> None:
    # analyzeが同期処理のスタブである間は、キャンセル対象が実際に走っていない。
    # 各STEPが非同期化された時点で、target_idに対応する処理の中断を実装する。
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
