"""どこカラv3 Pythonサイドカーのエントリポイント。

Electronのメインプロセスと stdin/stdout 経由でJSON-RPC風メッセージ
(1行1メッセージ)をやり取りする。プロトコルの定義は
`src/shared/pythonSidecarProtocol.ts` を正とする。

現在実装済みのSTEP(要件定義書v3 §4.4):
- STEP2 ボーカル/伴奏分離(Mel-Band RoFormer) -- separation.py
- STEP3 F0抽出(RMVPE) -- rmvpe_model.py
- STEP4 ノート化(Basic Pitch連携) -- f0_notes.py
- STEP5/6/7 歌詞行リストの一括タイミング付け(モーラ読み変換+自由デコード) -- lyrics_align.py

STEP1(音源取得の正規化)はこのサイドカーではなく呼び出し側(src/main/analysisManager.ts、
同梱ffmpegでWAVへ変換)で行う。source_audio_pathは常に正規化済みWAVである前提でよい。

歌詞タイミング付けは、`align_lyrics_lines_via_free_decode`(自由デコード+テキストの
編集距離アライメント)を使う。以前のctc-segmentationによる強制アライメント
(`align_lyrics_lines_to_song`、関数はテスト用に残置)は、与えられた歌詞全部をどこかに
配置しなければならない制約のため、実際には無音/伴奏残響の区間にも文字を割り当ててしまい、
行の開始位置が実際の発音より系統的に早くなる問題があった(2026-09-22実測、手動で
完璧にタイミング合わせした正解データとの比較で平均0.5秒程度)。自由デコードはモデル自身の
blank確信度をそのまま無音判定に使えるため、実測で誤差0.1秒未満まで改善することを確認した。
さらに以前のSilero VAD先行検出+min(N,M)対応付け方式(区間数がズレると後続行が丸ごと
ズレる問題があった)も、この自由デコード方式では歌詞行が時系列順に出現するという前提だけに
依存するため発生しない。vad.pyはこの用途では使わなくなったが、ファイル自体は削除せず残している
(テスト済みで他用途に転用しうるため)。詳細は[[どこカラv3の技術選定]]参照。

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
    # sys.stdout(現在の値)ではなくsys.__stdout__(インタプリタ起動時の本来の標準出力)に
    # 書く。separation.pyがdemix_trackの生テキスト出力を横取りするためcontextlib.
    # redirect_stdout()で一時的にsys.stdoutを差し替えており、その最中にon_progress
    # コールバック経由でこのsend()が呼ばれると、JSON-RPCメッセージ自体が横取り用
    # ストリームに飲み込まれてElectron側に一切届かなくなる不具合が実機で発生していた
    # (解析の進捗が0%のまま動かなく見える原因)。sys.__stdout__は再代入の影響を受けない。
    sys.__stdout__.write(json.dumps(message, ensure_ascii=False) + "\n")
    sys.__stdout__.flush()


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
        lyrics_lines = params.get("lyricsLines", [])
    except KeyError as exc:
        send({"type": "error", "id": req_id, "message": f"analyzeパラメータが不足しています: {exc}"})
        return

    import librosa
    import soundfile as sf

    import paths
    import separation
    import vad
    from rmvpe_model import RMVPE
    from f0_notes import notes_from_f0
    from lyrics_align import align_lyrics_lines_via_free_decode

    vocal_label = "ボーカル/伴奏分離(Mel-Band RoFormer)"
    pitch_label = "F0抽出・ノート化(RMVPE+Basic Pitch)"
    phrase_label = "フレーズ区間検出(Silero VAD)"
    align_label = "歌詞のタイミング付け(モーラ読み+ctc-segmentation)"

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

    # STEP5: フレーズ区間検出(Silero VAD)。STEP3で作った16kHzモノラルのvocals_audioを再利用する。
    # 歌詞タイミング付け自体(STEP6/7)はもうこのphrase_segmentsを使わない(後述)が、
    # 編集画面のフレーズ境界ガイド線・スナップ対象(editorScreen.tsのSNAP_PRIORITY.
    # phraseBoundary)としては引き続き有用なため、検出自体は残す判断とした。
    _send_progress(req_id, "phrase", phrase_label, 0.0, "running")
    try:
        phrase_segments = vad.detect_phrases(vocals_audio.astype("float32"), paths.model_path("silero_vad.jit"))
    except Exception as exc:  # noqa: BLE001 -- 同上
        send({"type": "error", "id": req_id, "message": f"フレーズ区間検出に失敗しました: {exc}"})
        return
    _send_progress(req_id, "phrase", phrase_label, 1.0, "done")

    # STEP6/7: 歌詞行リスト全体を、曲全体のvocals音声に一括アライメントする(ctc-segmentation)。
    # 旧実装(VAD検出区間とmin(歌詞行数,検出区間数)で1対1対応付け)は、VADが想定と違う個数に
    # フレーズを区切ると、そこから後ろの行が丸ごとズレる問題があった。歌詞行は曲中で必ず
    # 時系列順に出現するという前提だけに依存する一括アライメント方式に置き換えることで、
    # 区間数のズレという概念自体を無くす。詳細は[[どこカラv3の技術選定]]参照。
    _send_progress(req_id, "assign", align_label, 0.0, "running")
    try:
        aligned_lines = align_lyrics_lines_via_free_decode(
            lyrics_lines,
            vocals_audio.astype("float32"),
            paths.model_path("japanese-wav2vec2-base-rs35kh.safetensors"),
            notes=notes,
        )
    except Exception as exc:  # noqa: BLE001 -- 失敗理由をerrorメッセージとして呼び出し側に伝える境界
        send({"type": "error", "id": req_id, "message": f"歌詞のタイミング付けに失敗しました: {exc}"})
        return
    _send_progress(req_id, "assign", align_label, 1.0, "done")

    send(
        {
            "type": "done",
            "id": req_id,
            "result": {
                "vocalsPath": str(vocals_path),
                "instrumentalPath": str(instrumental_path),
                "f0Path": str(f0_path),
                "notes": notes,
                "phraseSegments": phrase_segments,
                "lyrics": aligned_lines,
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