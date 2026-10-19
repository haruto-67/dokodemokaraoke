"""【実験】発音成分(母音5種+ん+無音)のDPによる歌詞タイミング付け。

Nestioナレッジ「どこカラ 発音成分アライメント案」の最小構成の検証用。解析パイプライン
(python/sidecar/main.py)・アプリ本体には組み込んでいない。日本語のみ。

仕組み:
- ボーカル音声からフレーム(20ms)ごとに母音クラス a/i/u/e/o/N の確率と無音確率を出す
  - 無音: RMVPEのF0の有無+RMS音量で判定する(分類器は使わない)
  - 母音: wav2vec2(同梱のreazon-research版)の中間層の特徴に対する分類器。
    ラベルは曲ごとに自己学習する。初回はCTC出力をblank除外で割り直した母音確率(A案)
    だけでDPを解き、DPの配置結果から母音ラベルを作って分類器を学習→再度DP、を繰り返す。
    CTCの出力は1フレームだけ尖り、伸ばした母音の区間はblank確率がほぼ1になるため、
    時刻決めには使わず初回ラベルの供給元としてだけ使う。母音の長さは中間層の分類器から取る
- 歌詞はpyopenjtalk(ルビ優先、lyrics_align.text_to_hiragana_reading)のモーラ読みを
  同じクラスに落とす。「ん」「ー」「っ」は前の音にくっつく(長さ0で読み飛ばす)ことも許す
- コスト = 発音の不一致(-log確率) - ノート開始(analysis.notes)との一致ボーナス
- 歌詞の順序を守ったまま曲全体を1回のViterbiで配置する。1モーラが複数ノートに
  またがることは、モーラ内でノート開始を通過してもコストがかからない形で許している

使い方(リポジトリ直下で、同梱Pythonから):
  resources/python-runtime/bin/python3 python/experiments/vowel_dp_align.py <展開済みプロジェクト> <出力.json>
<展開済みプロジェクト>は .dokokara(zip)を展開したディレクトリ(project.json と audio/vocal.wav を含む)。
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional

import numpy as np

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "python" / "sidecar"))

SR = 16000
HOP = 320  # wav2vec2の出力1フレーム = 20ms
FRAME_SEC = HOP / SR
CLASSES = ["a", "i", "u", "e", "o", "N"]
MODEL_PATH = REPO / "resources" / "models" / "japanese-wav2vec2-base-rs35kh.safetensors"
RMVPE_PATH = REPO / "resources" / "models" / "rmvpe.pt"

_VOWEL_OF = {}
for _chars, _v in [
    ("あかさたなはまやらわがざだばぱぁゃゎ", "a"),
    ("いきしちにひみりぎじぢびぴぃ", "i"),
    ("うくすつぬふむゆるぐずづぶぷぅゅゔ", "u"),
    ("えけせてねへめれげぜでべぺぇ", "e"),
    ("おこそとのほもよろをごぞどぼぽぉょ", "o"),
]:
    for _c in _chars:
        _VOWEL_OF[_c] = _v
_SMALL = set("ぁぃぅぇぉゃゅょゎ")


@dataclass
class Params:
    hidden_layer: int = 8  # 12層中の中間層。後段ほどCTCの文字予測に特化する
    pca_dims: int = 48
    iterations: int = 5
    note_bonus: float = 3.0  # モーラ開始がノート開始と一致した時に下げるコスト
    note_sigma_sec: float = 0.04
    gap_entry_cost: float = 1.5  # 行の途中で無音(息継ぎ)を挟むコスト。行の間は0
    unvoiced_in_mora: float = 0.15  # モーラ中の無声フレーム(子音・息)の許容度
    prob_floor: float = 1e-3
    silence_db: float = -40.0  # 最大音量からの相対dB。これより小さく、F0も無いと無音
    label_skip_head: float = 0.3  # ラベル化でモーラ先頭から除く割合(子音・遷移部分)


# ---------------------------------------------------------------- 歌詞 → モーラ


@dataclass
class Mora:
    text: str  # ひらがな(拗音は2文字)
    kind: str  # "V"(母音あり) / "N"(ん) / "Q"(っ) / "R"(ー)
    vowels: tuple  # 一致とみなす母音クラス
    line: int


def split_morae(reading: str) -> List[str]:
    morae: List[str] = []
    for ch in reading:
        if ch in _SMALL and morae:
            morae[-1] += ch
        elif ch in _VOWEL_OF or ch in "んっー":
            morae.append(ch)
        # 空白・記号などはモーラにしない
    return morae


def lyrics_to_morae(lines: List[str]) -> List[Mora]:
    from lyrics_align import text_to_hiragana_reading

    out: List[Mora] = []
    for li, line in enumerate(lines):
        prev_vowel: Optional[str] = None
        for m in split_morae(text_to_hiragana_reading(line)):
            last = m[-1]
            if last == "ん":
                mora = Mora(m, "N", ("N",), li)
            elif last == "っ":
                mora = Mora(m, "Q", (), li)
            elif last == "ー":
                mora = Mora(m, "R", (prev_vowel,) if prev_vowel else tuple(CLASSES[:5]), li)
            else:
                v = _VOWEL_OF[last]
                # 「おう」「えい」は歌では「おー」「えー」と伸ばすことが多いため両方を許す
                if m == "う" and prev_vowel == "o":
                    mora = Mora(m, "V", ("u", "o"), li)
                elif m == "い" and prev_vowel == "e":
                    mora = Mora(m, "V", ("i", "e"), li)
                else:
                    mora = Mora(m, "V", (v,), li)
            out.append(mora)
            if mora.kind == "V":
                prev_vowel = _VOWEL_OF[last]
            elif mora.kind in ("N", "Q"):
                prev_vowel = None
    return out


# ---------------------------------------------------------------- 音響特徴


def load_vocal_16k(project_dir: Path) -> np.ndarray:
    import librosa
    import soundfile as sf

    audio, sr = sf.read(project_dir / "audio" / "vocal.wav")
    if audio.ndim > 1:
        audio = librosa.to_mono(audio.T)
    return librosa.resample(audio, orig_sr=sr, target_sr=SR).astype(np.float32)


def wav2vec2_features(audio: np.ndarray, layer: int):
    """(CTCのlog確率, 指定中間層の特徴)を20msフレームで返す。20秒チャンクで推論して連結。"""
    import torch

    from lyrics_align import _load_wav2vec2_model, _normalize_audio

    model = _load_wav2vec2_model(MODEL_PATH)
    chunk = 20 * SR
    lps, hids = [], []
    with torch.no_grad():
        for s in range(0, len(audio), chunk):
            x = audio[s : s + chunk]
            if len(x) < HOP * 2:
                continue
            out = model(torch.from_numpy(_normalize_audio(x)).unsqueeze(0), output_hidden_states=True)
            lps.append(torch.log_softmax(out.logits, dim=-1)[0].numpy())
            hids.append(out.hidden_states[layer][0].numpy())
    return np.concatenate(lps), np.concatenate(hids), model.config.pad_token_id


def ctc_vowel_probs(log_probs: np.ndarray, blank_id: int) -> np.ndarray:
    """A案: blankを除いて割り直したCTC確率を、各トークン読みの最後のかなの母音へ集約する。"""
    from lyrics_align import Wav2Vec2Vocab, _subword_to_reading

    vocab = Wav2Vec2Vocab()
    cache: dict = {}
    m = np.zeros((log_probs.shape[1], len(CLASSES)))
    for tid in range(log_probs.shape[1]):
        reading = _subword_to_reading(vocab.decode_single(tid), cache)
        # 末尾の「ー」「っ」は直前の母音を代表させる
        tail = reading.rstrip("ーっ")
        if not tail:
            continue
        last = tail[-1]
        if last == "ん":
            m[tid, CLASSES.index("N")] = 1
        elif last in _VOWEL_OF:
            m[tid, CLASSES.index(_VOWEL_OF[last])] = 1
    p = np.exp(log_probs.astype(np.float64))
    p[:, blank_id] = 0
    p /= np.maximum(p.sum(1, keepdims=True), 1e-30)
    vp = p @ m
    return vp / np.maximum(vp.sum(1, keepdims=True), 1e-30)


def silence_prob(audio: np.ndarray, n_frames: int, params: Params) -> np.ndarray:
    """F0(RMVPE)と音量から各フレームの無音確率を出す。
    F0あり→ほぼ有声。F0なしでも音量が大きければ無声子音や息の可能性があるため中間値にする。"""
    import librosa

    from rmvpe_model import RMVPE

    f0 = RMVPE(str(RMVPE_PATH), device="cpu").infer_from_audio(audio)  # 100fps
    idx = np.minimum((np.arange(n_frames) * FRAME_SEC * 100).astype(int), len(f0) - 1)
    voiced = f0[idx] > 0
    rms = librosa.feature.rms(y=audio, frame_length=HOP * 2, hop_length=HOP, center=True)[0]
    rms = np.pad(rms, (0, max(0, n_frames - len(rms))), mode="edge")[:n_frames]
    db = 20 * np.log10(np.maximum(rms, 1e-9) / max(rms.max(), 1e-9))
    quiet = 1 / (1 + np.exp(-(params.silence_db - db) / 3.0))
    return np.where(voiced, 0.02, 0.1 + 0.88 * quiet)


# ---------------------------------------------------------------- DP


def note_bonus(n_frames: int, notes: list, params: Params) -> np.ndarray:
    t = np.arange(n_frames) * FRAME_SEC
    if not notes:
        return np.zeros(n_frames)
    onsets = np.array(sorted(n["start"] for n in notes))
    pos = np.clip(np.searchsorted(onsets, t), 1, len(onsets) - 1)
    d = np.minimum(np.abs(t - onsets[pos - 1]), np.abs(t - onsets[pos]))
    return params.note_bonus * np.exp(-0.5 * (d / params.note_sigma_sec) ** 2)


def viterbi(morae: List[Mora], vowel_p: np.ndarray, sil: np.ndarray, bonus: np.ndarray, params: Params):
    """状態は [G0, M0, G1, M1, ..., M_{J-1}, G_J](Gj=モーラjの前の無音、Mj=モーラj)。
    遷移: 自己ループ / G_j→M_j / M_j→G_{j+1} / M_j→M_{j+1} /
    「ん」「ー」「っ」のモーラkは読み飛ばし可(M_{k-1}→M_{k+1}, M_{k-1}→G_{k+1})。
    戻り値は各モーラの(開始フレーム, 終了フレーム)。読み飛ばしたモーラはNone。"""
    J = len(morae)
    S = 2 * J + 1
    T = len(sil)
    floor = params.prob_floor

    # フレームごとの各状態の放出コスト
    emit = np.empty((T, S))
    emit[:, 0::2] = -np.log(np.maximum(sil, floor))[:, None]
    for j, m in enumerate(morae):
        if m.kind == "Q":
            p = 0.3 + 0.7 * sil
        else:
            pv = vowel_p[:, [CLASSES.index(v) for v in m.vowels]].max(1)
            p = (1 - sil) * pv + sil * params.unvoiced_in_mora
        emit[:, 2 * j + 1] = -np.log(np.maximum(p, floor))

    # 状態に入る時の追加コスト(自己ループには掛けない)
    is_m = np.zeros(S, bool)
    is_m[1::2] = True
    gap_entry = np.zeros(S)
    for j in range(1, J):
        if morae[j].line == morae[j - 1].line:
            gap_entry[2 * j] = params.gap_entry_cost
    skippable = np.array([m.kind in ("N", "Q", "R") for m in morae])
    # 状態kへ「k-3 / k-4 から」の読み飛ばし遷移を許すか
    skip_to_g = np.zeros(S, bool)
    skip_to_m = np.zeros(S, bool)
    for j in range(1, J + 1):
        if j - 1 >= 1 and skippable[j - 1]:
            skip_to_g[2 * j] = True
            if j < J:
                skip_to_m[2 * j + 1] = True

    INF = 1e18
    score = np.full(S, INF)
    score[0] = emit[0, 0]
    score[1] = emit[0, 1] - bonus[0]
    back = np.zeros((T, S), np.int8)  # 遷移元の状態番号の差(0=自己ループ)
    shift_cost_m = np.zeros(S)

    def shifted(arr, k):
        out = np.full(S, INF)
        out[k:] = arr[:-k]
        return out

    for t in range(1, T):
        entry = gap_entry + np.where(is_m, -bonus[t], 0.0)
        cands = [score]  # 差0
        # 差1: G_j→M_j, M_j→G_{j+1}
        cands.append(shifted(score, 1) + entry)
        # 差2: M_{j-1}→M_j(Gからの差2は G_{j-1}→G_j で不可)
        c2 = shifted(score, 2) + entry
        c2[~is_m] = INF
        cands.append(c2)
        c3 = shifted(score, 3) + entry
        c3[~skip_to_g] = INF
        cands.append(c3)
        c4 = shifted(score, 4) + entry
        c4[~skip_to_m] = INF
        cands.append(c4)
        stack = np.stack(cands)
        best = stack.argmin(0)
        score = stack[best, np.arange(S)] + emit[t]
        back[t] = best

    final = [S - 1, S - 2] if J > 0 else [S - 1]
    state = min(final, key=lambda k: score[k])
    path = np.empty(T, int)
    for t in range(T - 1, -1, -1):
        path[t] = state
        state -= back[t, state]

    segs: List[Optional[tuple]] = [None] * J
    for j in range(J):
        frames = np.nonzero(path == 2 * j + 1)[0]
        if len(frames):
            segs[j] = (int(frames[0]), int(frames[-1]) + 1)
    return segs, float(score[min(final, key=lambda k: score[k])])


# ---------------------------------------------------------------- 自己学習


def labels_from_alignment(morae: List[Mora], segs, sil: np.ndarray, params: Params, n_frames: int) -> np.ndarray:
    """DPの配置から学習ラベルを作る。母音が1つに決まるモーラの、先頭(子音・遷移)を除いた
    有声フレームだけを使う。無音区間はラベルにしない(無音はF0+音量で別に判定するため)。"""
    y = np.full(n_frames, -1)
    for m, seg in zip(morae, segs):
        if seg is None or len(m.vowels) != 1:
            continue
        s, e = seg
        s = s + int((e - s) * params.label_skip_head)
        for t in range(s, e):
            if sil[t] < 0.5:
                y[t] = CLASSES.index(m.vowels[0])
    return y


def train_and_predict(feats: np.ndarray, y: np.ndarray, params: Params) -> np.ndarray:
    from sklearn.linear_model import LogisticRegression

    mask = y >= 0
    present = sorted(set(y[mask].tolist()))
    out = np.full((len(feats), len(CLASSES)), params.prob_floor)
    if len(present) < 2:
        return out / out.sum(1, keepdims=True)
    clf = LogisticRegression(C=0.1, max_iter=2000, class_weight="balanced")
    clf.fit(feats[mask], y[mask])
    out[:, present] = clf.predict_proba(feats)
    return out / out.sum(1, keepdims=True)


def build_features(hidden: np.ndarray, ctc_vp: np.ndarray, params: Params) -> np.ndarray:
    from sklearn.decomposition import PCA

    h = (hidden - hidden.mean(0)) / (hidden.std(0) + 1e-6)
    z = PCA(n_components=min(params.pca_dims, h.shape[1], len(h)), random_state=0).fit_transform(h)
    z /= z.std(0) + 1e-6
    return np.concatenate([z, np.log(ctc_vp + 1e-4)], axis=1)


# ---------------------------------------------------------------- 実行


def segs_to_result(lines: List[str], morae: List[Mora], segs, n_frames: int) -> list:
    starts: List[Optional[float]] = [None if s is None else s[0] * FRAME_SEC for s in segs]
    ends: List[Optional[float]] = [None if s is None else s[1] * FRAME_SEC for s in segs]
    # 読み飛ばした(前の音にくっついた)モーラは、前のモーラの後半を分け合う形で時刻を与える
    for j, s in enumerate(starts):
        if s is None:
            ps = starts[j - 1] if j > 0 and starts[j - 1] is not None else 0.0
            pe = ends[j - 1] if j > 0 and ends[j - 1] is not None else ps
            starts[j] = ps + (pe - ps) / 2
            ends[j] = pe
            if j > 0:
                ends[j - 1] = starts[j]
    result = []
    for li, text in enumerate(lines):
        idx = [j for j, m in enumerate(morae) if m.line == li]
        result.append(
            {
                "text": text,
                "start": starts[idx[0]] if idx else None,
                "end": ends[idx[-1]] if idx else None,
                "morae": [
                    {"reading": morae[j].text, "start": starts[j], "end": ends[j], "attached": segs[j] is None}
                    for j in idx
                ],
            }
        )
    return result


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("project_dir", type=Path)
    ap.add_argument("out_json", type=Path)
    ap.add_argument("--cache", type=Path, help="音響特徴のキャッシュ(.npz)。パラメータ調整時の再計算を省く")
    ap.add_argument("--iterations", type=int)
    ap.add_argument("--layer", type=int)
    ap.add_argument("--no-notes", action="store_true", help="ノート開始ボーナスを無効にする(切り分け用)")
    args = ap.parse_args()

    params = Params()
    if args.iterations is not None:
        params.iterations = args.iterations
    if args.layer is not None:
        params.hidden_layer = args.layer

    project = json.loads((args.project_dir / "project.json").read_text())
    lines = [l["text"] for l in project["lyrics"]]
    notes = [] if args.no_notes else project["analysis"]["notes"]

    cache_ok = args.cache and args.cache.exists()
    if cache_ok:
        z = np.load(args.cache)
        cache_ok = int(z["layer"]) == params.hidden_layer
    if cache_ok:
        ctc_vp, hidden, sil = z["ctc_vp"], z["hidden"], z["sil"]
    else:
        audio = load_vocal_16k(args.project_dir)
        log_probs, hidden, blank_id = wav2vec2_features(audio, params.hidden_layer)
        ctc_vp = ctc_vowel_probs(log_probs, blank_id)
        sil = silence_prob(audio, len(ctc_vp), params)
        if args.cache:
            np.savez(args.cache, ctc_vp=ctc_vp, hidden=hidden, sil=sil, layer=params.hidden_layer)

    morae = lyrics_to_morae(lines)
    n = len(sil)
    bonus = note_bonus(n, notes, params)
    feats = build_features(hidden, ctc_vp, params)

    history = []
    vowel_p = ctc_vp
    segs, cost = viterbi(morae, vowel_p, sil, bonus, params)
    history.append({"iteration": 0, "source": "ctc", "cost": cost, "result": segs_to_result(lines, morae, segs, n)})
    for it in range(1, params.iterations + 1):
        y = labels_from_alignment(morae, segs, sil, params, n)
        vowel_p = train_and_predict(feats, y, params)
        new_segs, cost = viterbi(morae, vowel_p, sil, bonus, params)
        moved = sum(1 for a, b in zip(segs, new_segs) if (a and a[0]) != (b and b[0]))
        segs = new_segs
        history.append(
            {
                "iteration": it,
                "source": "classifier",
                "cost": cost,
                "labels": int((y >= 0).sum()),
                "moved_morae": moved,
                "result": segs_to_result(lines, morae, segs, n),
            }
        )
        print(f"iter {it}: labels={int((y >= 0).sum())} moved={moved} cost={cost:.1f}", file=sys.stderr)

    out = {
        "params": params.__dict__,
        "lyrics": history[-1]["result"],
        "history": history,
        "frame_vowel_probs": np.round(vowel_p, 3).tolist(),
        "frame_silence": np.round(sil, 3).tolist(),
    }
    args.out_json.write_text(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
