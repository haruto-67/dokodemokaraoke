"""どこカラv3 Pythonサイドカーのエントリポイント。

Electronのメインプロセスと stdin/stdout 経由でJSON-RPC風メッセージ
(1行1メッセージ)をやり取りする。プロトコルの定義は
`src/shared/pythonSidecarProtocol.ts` を正とする。

現在実装済みのSTEP(要件定義書v3 §4.4):
- STEP2 ボーカル/伴奏分離(Mel-Band RoFormer) -- separation.py
- STEP3 F0抽出(RMVPE) -- rmvpe_model.py
- STEP4 ノート化(Basic Pitch連携) -- f0_notes.py

STEP1(音源取得の正規化)・STEP5〜7(歌詞アライメント)は
未実装。`analyze` はそれらが揃うまで、分離結果・F0・ノート列のみを返す。

標準ライブラリ以外の重い依存(torch等)は `separation`/`rmvpe_model` モジュール内
でのみimportする(起動・疎通確認だけならtorch無しでも動くようにするため)。
"""

import json
import struct
import sys
from pathlib import Path

RMVPE_SAMPLE_RATE = 16000
RMVPE_FPS = 100.0


def send(message: dict) -> None:
    sys.stdout.write(json.dumps(message, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _send_progress(req_id: str, step_id: str, label: str, progress: float, status: str, detail: str | None = None) -> None:
    payload = {
        "id": step_id,
        "label": label,
        "progress": progress,
        "status": status,
    }
    if detail is not None:
        payload["detail"] = detail
    send({"type": "progress", "id": req_id, "progress": payload})


def _write_f0_bin(f0_hz: "object", path: Path) -> None:
    """F0配列(Float32)を生バイト列で書き出す(project.jsonのpitch.bin等と同じ素朴な形式)。"""
    path.write_bytes(struct.pack(f"<{len(f0_hz)}f", *[float(v) for v in f0_hz]))


def handle_analyze(req: dict) -> None:
    req_id = req["id"]
    params = req.get("params", {})

    try:
        source_audio_path = Path(params["sourceAudioPath"])
        work_dir = Path(params["workDir"])
    except KeyError as exc:
        send({"type": "error", "id": req_id, "message": f"analyzeパラメータが不足しています: {exc}"})
        return

    import librosa
    import soundfile as sf

    import paths
    import separation
    from rmvpe_model import RMVPE
    from f0_notes import notes_from_f0

    vocal_label = "ボーカル/伴奏分離(Mel-Band RoFormer)"
    pitch_label = "F0抽出・ノート化(RMVPE+Basic Pitch)"

    _send_progress(req_id, "vocalIsolation", vocal_label, 0.0, "running")
    try:
        vocals_path, instrumental_path = separation.separate_vocals(
            source_audio_path,
            work_dir,
            paths.models_dir(),
            on_progress=lambda fraction: _send_progress(req_id, "vocalIsolation", vocal_label, fraction, "running"),
        )
    except Exception as exc:  # noqa: BLE001 -- 失敗理由をerrorメッセージとして呼び出し側に伝える境界
        send({"type": "error", "id": req_id, "message": f"ボーカル分離に失敗しました: {exc}"})
        return
    _send_progress(req_id, "vocalIsolation", vocal_label, 1.0, "done")

    # STEP3: F0抽出(RMVPE)。vocals.wavは44.1kHzステレオ想定のため、
    # RMVPEが前提とする16kHzモノラルへ変換してから渡す。
    _send_progress(req_id, "pitch", pitch_label, 0.0, "running")
    try:
        vocals_audio, vocals_sr = sf.read(vocals_path)
        if vocals_audio.ndim > 1:
            vocals_audio = librosa.to_mono(vocals_audio.T)
        if vocals_sr != RMVPE_SAMPLE_RATE:
            vocals_audio = librosa.resample(vocals_audio, orig_sr=vocals_sr, target_sr=RMVPE_SAMPLE_RATE)
        duration_sec = len(vocals_audio) / RMVPE_SAMPLE_RATE

        rmvpe = RMVPE(str(paths.model_path("rmvpe.pt")), device="cpu")
        f0_hz = rmvpe.infer_from_audio(vocals_audio.astype("float32"))

        notes, f0_86fps = notes_from_f0(f0_hz, source_fps=RMVPE_FPS, duration_sec=duration_sec)

        f0_path = work_dir / "f0.bin"
        _write_f0_bin(f0_86fps, f0_path)
    except Exception as exc:  # noqa: BLE001 -- 同上
        send({"type": "error", "id": req_id, "message": f"F0抽出・ノート化に失敗しました: {exc}"})
        return
    _send_progress(req_id, "pitch", pitch_label, 1.0, "done")

    # STEP5以降(歌詞アライメント)は後続タスクで実装する。
    # 現時点ではSTEP2〜4の生成物のみを返す。
    send(
        {
            "type": "done",
            "id": req_id,
            "result": {
                "vocalsPath": str(vocals_path),
                "instrumentalPath": str(instrumental_path),
                "f0Path": str(f0_path),
                "notes": notes,
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