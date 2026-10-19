"""【実験】発音成分(母音5種+ん+無音)のDPによる歌詞タイミング付け。

Nestioナレッジ「どこカラ 発音成分アライメント案」の検証用。解析パイプライン
(python/sidecar/main.py)・アプリ本体には組み込んでいない。日本語のみ。

仕組み:
- ボーカル音声からフレーム(20ms)ごとに母音クラス a/i/u/e/o/N の確率と無音確率を出す
  - 無音: RMVPEのF0の有無+RMS音量で判定する(分類器は使わない)
  - 母音: MFCCに対するロジスティック回帰。ラベルは曲ごとに自己学習する。初回はwav2vec2の
    CTC出力をblank除外で割り直した母音確率だけでDPを解き、DPの配置結果から母音ラベルを作って
    分類器を学習→再度DP、を繰り返す。CTCの出力は1フレームだけ尖り、伸ばした母音の区間は
    blank確率がほぼ1になるため、時刻決めには使わず初回ラベルの供給元としてだけ使う。
    分類器の特徴をwav2vec2の中間層にすると、前後の文脈を混ぜるため母音の切り替わりを
    0.3秒ほど先取りしたため、時間方向に広がらないMFCCを使う
- 歌詞はpyopenjtalk(ルビ優先、lyrics_align.text_to_hiragana_reading)のモーラ読みを
  同じクラスに落とす。「ん」「ー」「っ」は前の音にくっつく(長さ0で読み飛ばす)ことも許す
- 各モーラは「子音(省略可)→母音」の状態で表し、歌詞の順序を守ったまま曲全体を1回のViterbiで配置する
- コスト = 発音の不一致(-log確率)
          - モーラ開始が切れ目の手がかり(音量の谷・音程の変わり目・ノート開始)に乗るボーナス
          + 母音を保ったまま大きな音程の跳躍を越えるコスト
  1モーラが複数ノートにまたがることは許している(小さな音程の変化は越えてもコストが無い)

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
_UNVOICED_ONSET = set("かきくけこさしすせそたちつてとはひふへほぱぴぷぺぽ")


@dataclass
class Params:
    # 母音分類器
    features: str = "mfcc"  # 分類器に使う特徴(mfcc / hidden / conv / ctc をカンマ区切り)。比較用に残している
    hidden_layer: int = 8  # features に hidden を使う時の層(12層中)
    pca_dims: int = 48
    mfcc_n: int = 20
    mfcc_nfft: int = 1024  # 64ms。低い声で倍音を分解できるよう、20ms刻みより広い窓で見る
    clf_c: float = 0.01  # ロジスティック回帰の正則化(小さいほど強い)。自己学習のラベルは誤りを含むため強めにする
    iterations: int = 5
    label_skip_head: float = 0.3  # ラベル化でモーラの母音の先頭から除く割合(子音からの遷移部分)
    # 無音
    silence_db: float = -40.0  # 最大音量からの相対dB。これより小さく、F0も無いと無音
    # モーラ開始のボーナス
    cue_bonus: float = 3.0  # 切れ目の手がかり(音量の谷・音程の変わり目)に乗った時に下げるコスト
    cue_sigma_sec: float = 0.02
    note_bonus: float = 2.0  # ノート開始に乗った時に下げるコスト(手がかりの補助。単独では粗い)
    note_sigma_sec: float = 0.04
    dip_window_sec: float = 0.1
    dip_min_db: float = 2.0
    dip_full_db: float = 6.0
    pitch_window_sec: float = 0.05
    pitch_min_semitone: float = 0.7
    pitch_full_semitone: float = 1.5
    # 母音を保ったまま大きな音程の跳躍を越えるコスト
    hold_penalty: float = 8.0
    hold_min_semitone: float = 1.5
    hold_full_semitone: float = 3.0
    hold_min_db: float = -15.0  # 跳躍の後の声量がこれより小さい(語尾の減衰)時は対象外
    # DPの状態
    gap_entry_cost: float = 1.5  # 行の途中で無音(息継ぎ)を挟むコスト。行の間は0
    unvoiced_in_mora: float = 0.15  # 母音の状態での無声フレーム(息・かすれ)の許容度
    cons_base: float = 0.2  # 子音の状態の放出確率(有声フレーム)
    cons_unvoiced: float = 0.4  # 子音の状態で無声フレームに上乗せする確率
    cons_loop_cost: float = 0.8  # 子音を1フレーム伸ばすごとのコスト(長い息継ぎを子音にしないため)
    min_vowel_frames: int = 4  # 母音部分の最小フレーム数(80ms)。1フレームだけのモーラを作らせない
    prob_floor: float = 1e-3


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


def has_consonant(m: Mora) -> bool:
    return m.kind == "V" and m.text[0] not in "あいうえお"


def starts_at_vowel(m: Mora) -> bool:
    """無声の子音(k/s/t/h/p)で始まるモーラは、母音の始まり(声が出始める所)を開始とする。
    手修正後の正解では「つ」「し」がこの位置に置かれていた。有声の子音(m/n/r/g/z/d/b等)は
    子音そのものが聞こえるため、子音の始まり(音量の谷)を開始とする。"""
    return m.text[0] in _UNVOICED_ONSET


# ---------------------------------------------------------------- 音響特徴


def load_vocal_16k(project_dir: Path) -> np.ndarray:
    import librosa
    import soundfile as sf

    audio, sr = sf.read(project_dir / "audio" / "vocal.wav")
    if audio.ndim > 1:
        audio = librosa.to_mono(audio.T)
    return librosa.resample(audio, orig_sr=sr, target_sr=SR).astype(np.float32)


def wav2vec2_features(audio: np.ndarray, layer: int):
    """(CTCのlog確率, 指定中間層の特徴, 畳み込み特徴)を20msフレームで返す。20秒チャンクで推論して連結。
    畳み込み特徴はtransformerに入る前の局所特徴(1フレームが見る範囲は約25ms)で、前後の文脈を混ぜない。"""
    import torch

    from lyrics_align import _load_wav2vec2_model, _normalize_audio

    model = _load_wav2vec2_model(MODEL_PATH)
    chunk = 20 * SR
    lps, hids, convs = [], [], []
    with torch.no_grad():
        for s in range(0, len(audio), chunk):
            x = audio[s : s + chunk]
            if len(x) < HOP * 2:
                continue
            out = model.wav2vec2(torch.from_numpy(_normalize_audio(x)).unsqueeze(0), output_hidden_states=True)
            logits = model.lm_head(out.last_hidden_state)
            lps.append(torch.log_softmax(logits, dim=-1)[0].numpy())
            hids.append(out.hidden_states[layer][0].numpy())
            convs.append(out.extract_features[0].numpy())
    return np.concatenate(lps), np.concatenate(hids), np.concatenate(convs), model.config.pad_token_id


def ctc_vowel_probs(log_probs: np.ndarray, blank_id: int) -> np.ndarray:
    """blankを除いて割り直したCTC確率を、各トークン読みの最後のかなの母音へ集約する(初回DP用)。"""
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


def f0_and_db(audio: np.ndarray):
    """RMVPEのF0(Hz、無声は0)と、最大音量からの相対dBを、どちらも10ms刻みで返す。"""
    import librosa

    from rmvpe_model import RMVPE

    f0 = RMVPE(str(RMVPE_PATH), device="cpu").infer_from_audio(audio)  # 100fps
    rms = librosa.feature.rms(y=audio, frame_length=640, hop_length=160, center=True)[0]
    n = min(len(f0), len(rms))
    db = 20 * np.log10(np.maximum(rms[:n], 1e-9) / max(rms.max(), 1e-9))
    return f0[:n].astype(np.float64), db


def mfcc_features(audio: np.ndarray, n_frames: int, n_mfcc: int, n_fft: int) -> np.ndarray:
    """MFCC+Δを20msフレームで返す。"""
    import librosa

    m = librosa.feature.mfcc(y=audio, sr=SR, n_mfcc=n_mfcc, n_fft=n_fft, hop_length=HOP, center=True)
    m = np.concatenate([m, librosa.feature.delta(m, width=5)]).T
    return np.pad(m, ((0, max(0, n_frames - len(m))), (0, 0)), mode="edge")[:n_frames]


def _to_frames(x10: np.ndarray, n_frames: int, reduce=np.max) -> np.ndarray:
    """10ms刻みの値を20msフレームへまとめる。"""
    x = np.pad(x10, (0, max(0, 2 * n_frames - len(x10))), mode="edge")[: 2 * n_frames]
    return reduce(x.reshape(n_frames, 2), axis=1)


def silence_prob(f0: np.ndarray, db: np.ndarray, n_frames: int, params: Params) -> np.ndarray:
    """F0(RMVPE)と音量から各フレームの無音確率を出す。
    F0あり→ほぼ有声。F0なしでも音量がある区間は、無声子音とも息継ぎとも決められないため
    中間値(0.5)にする(以前は0.1にしていたため、息継ぎの区間にモーラが入り込んでいた)。"""
    voiced = _to_frames((f0 > 0).astype(float), n_frames) > 0
    fdb = _to_frames(db, n_frames)
    quiet = 1 / (1 + np.exp(-(params.silence_db - fdb) / 3.0))
    return np.where(voiced, 0.02, 0.5 + 0.48 * quiet)


def pitch_jump(f0: np.ndarray, params: Params) -> np.ndarray:
    """前後pitch_window_secの中央値の差(半音)を10ms刻みで返す。無声が多い所は0。"""
    fps = 100
    st = np.where(f0 > 0, 12 * np.log2(np.maximum(f0, 1) / 440) + 69, np.nan)
    k = int(params.pitch_window_sec * fps)
    diff = np.zeros(len(st))
    for i in range(k, len(st) - k):
        a, b = st[i - k : i], st[i : i + k]
        if np.isnan(a).sum() > k // 2 or np.isnan(b).sum() > k // 2:
            continue
        diff[i] = abs(np.nanmedian(b) - np.nanmedian(a))
    return diff


def hold_cost(f0: np.ndarray, db: np.ndarray, n_frames: int, params: Params) -> np.ndarray:
    """母音を保ったままそのフレームを越えるコスト。大きな音程の跳躍をまたいで同じモーラを
    伸ばすこと(メリスマ)はJ-POPでは少数派のため、跳躍の大きさに応じて損にする。
    「ら」(13.41秒、約8半音の跳躍)で、前の「て」が跳躍を越えて伸びていたため追加。"""
    j = pitch_jump(f0, params)
    c = np.clip((j - params.hold_min_semitone) / params.hold_full_semitone, 0, 1)
    # 語尾で声が減衰する時の音程の下がりは新しいモーラではないため、跳躍の後も声量が
    # 保たれている所だけを対象にする(「せ」の語尾の下がりで切っていたため)
    k = int(params.pitch_window_sec * 100)
    after = np.array([np.median(db[i : i + k]) if i + k <= len(db) else -99 for i in range(len(db))])
    c = np.where(after[: len(c)] > params.hold_min_db, c, 0.0)
    return params.hold_penalty * _to_frames(c, n_frames)


def boundary_cue(f0: np.ndarray, db: np.ndarray, n_frames: int, params: Params) -> np.ndarray:
    """モーラの切れ目らしさ(0〜1)をフレームごとに出す。手修正後の正解と照らすと、
    子音で始まるモーラの開始は音量の谷(子音の閉鎖)に、母音だけのモーラや谷の浅いモーラは
    音程の変わり目にほぼ乗っていたため、この2つを手がかりにする。
    analysis.notesも元はF0から作られているが、まとめる過程で開始時刻が丸まり、
    同じ高さが続く音は1本にまとまるため、元のF0と音量を主に使う(ノートは補助)。"""
    fps = 100
    cue = np.zeros(len(db))
    # 音量の谷: 前後の最大から何dB落ちているか(局所最小だけ)
    w = int(params.dip_window_sec * fps)
    for i in range(len(db)):
        lo, hi = max(0, i - w), min(len(db), i + w + 1)
        if db[i] > db[lo:hi].min():
            continue
        depth = min(db[lo : i + 1].max(), db[i:hi].max()) - db[i]
        cue[i] = max(cue[i], np.clip((depth - params.dip_min_db) / params.dip_full_db, 0, 1))
    # 音程の変わり目: 局所最大だけ
    diff = pitch_jump(f0, params)
    for i in range(1, len(diff) - 1):
        if diff[i] >= params.pitch_min_semitone and diff[i] >= diff[i - 1] and diff[i] >= diff[i + 1]:
            cue[i] = max(cue[i], min(1.0, diff[i] / params.pitch_full_semitone))
    # 発音の立ち上がり(無音→有声)も切れ目
    voiced = f0 > 0
    for i in range(1, len(voiced)):
        if voiced[i] and not voiced[i - 1]:
            cue[i] = max(cue[i], 0.5)
    # 少しぼかしてから20msフレームへ
    sig = params.cue_sigma_sec * fps
    r = int(3 * sig)
    spread = np.zeros_like(cue)
    for i in np.nonzero(cue)[0]:
        for d in range(-r, r + 1):
            if 0 <= i + d < len(cue):
                spread[i + d] = max(spread[i + d], cue[i] * np.exp(-0.5 * (d / sig) ** 2))
    return _to_frames(spread, n_frames)


def note_bonus(n_frames: int, notes: list, params: Params) -> np.ndarray:
    t = np.arange(n_frames) * FRAME_SEC
    if not notes or params.note_bonus == 0:
        return np.zeros(n_frames)
    onsets = np.array(sorted(n["start"] for n in notes))
    pos = np.clip(np.searchsorted(onsets, t), 1, len(onsets) - 1)
    d = np.minimum(np.abs(t - onsets[pos - 1]), np.abs(t - onsets[pos]))
    return params.note_bonus * np.exp(-0.5 * (d / params.note_sigma_sec) ** 2)


# ---------------------------------------------------------------- DP


def viterbi(
    morae: List[Mora],
    vowel_p: np.ndarray,
    sil: np.ndarray,
    bonus: np.ndarray,
    hold: np.ndarray,
    params: Params,
):
    """状態はモーラjごとに G_j(前の無音) / C_j(子音) / V_j,1..V_j,L(母音)、最後に G_J。
    - 子音の状態は母音を問わず、無声のフレームを好む。母音だけのモーラと「ん」「ー」「っ」には無い。
      以前はモーラを1状態にしていたため、子音(無声・音量の谷)にも母音の一致を求めることになり、
      子音の部分が無音扱いされて区切りがずれていた(「ま」→「た」のように同じ母音が続く所で顕著)
    - 無声子音のモーラは子音を必ず通し、開始は母音の始まりとする(starts_at_vowel)
    - 母音は最低Lフレーム続ける。同じ母音が続く「らあ」で「ら」を1フレームにして済ませていたため
    遷移: 自己ループ / G_j→C_j,V_j / C_j→V_j / V_j→G_{j+1},C_{j+1},V_{j+1} /
    「ん」「ー」「っ」のモーラkは読み飛ばし可(V_{k-1}→G_{k+1},C_{k+1},V_{k+1})。
    モーラの開始にはbonus[t]を与え、母音の中で次のフレームへ進む時はhold[t]を課す。
    戻り値は各モーラの(開始, 母音の開始, 終了)フレーム。読み飛ばしたモーラはNone。"""
    J = len(morae)
    L = max(1, params.min_vowel_frames)
    B = 2 + L  # 1モーラあたりの状態数
    S = B * J + 1
    T = len(sil)
    floor = params.prob_floor
    G = lambda j: B * j
    C = lambda j: B * j + 1
    V1 = lambda j: B * j + 2
    V = lambda j: B * j + 1 + L  # 母音の最後の状態(自己ループと次への遷移はここから)
    INF = 1e18

    emit = np.full((T, S), INF)
    for j in range(J + 1):
        emit[:, G(j)] = -np.log(np.maximum(sil, floor))
    cons = params.cons_base + params.cons_unvoiced * np.minimum(1.0, 2 * sil)
    for j, m in enumerate(morae):
        if m.kind == "Q":
            p = 0.3 + 0.7 * sil
        else:
            pv = vowel_p[:, [CLASSES.index(v) for v in m.vowels]].max(1)
            p = (1 - sil) * pv + sil * params.unvoiced_in_mora
        emit[:, V1(j) : V(j) + 1] = -np.log(np.maximum(p, floor))[:, None]
        if has_consonant(m):
            emit[:, C(j)] = -np.log(cons) + params.cons_loop_cost

    skippable = [m.kind in ("N", "Q", "R") for m in morae]
    # 遷移元の一覧: (遷移元, 固定コスト, モーラ開始か)
    preds: List[list] = [[] for _ in range(S)]
    for j in range(J + 1):
        prev_vs = []
        if j >= 1:
            prev_vs.append(V(j - 1))
        if j >= 2 and skippable[j - 1]:
            prev_vs.append(V(j - 2))
        same_line = 0 < j < J and morae[j].line == morae[j - 1].line
        preds[G(j)] = [(G(j), 0.0, False)] + [(v, params.gap_entry_cost if same_line else 0.0, False) for v in prev_vs]
        if j == J:
            break
        starts = [(G(j), 0.0, True)] + [(v, 0.0, True) for v in prev_vs]
        for i in range(1, L):
            preds[V1(j) + i] = [(V1(j) + i - 1, 0.0, False)]
        if L > 1:
            preds[V(j)] = [(V(j), 0.0, False), (V(j) - 1, 0.0, False)]
        loop = [(V1(j), 0.0, False)] if L == 1 else []
        if has_consonant(morae[j]):
            uv = starts_at_vowel(morae[j])
            preds[C(j)] = [(C(j), 0.0, False)] + [(f, c, not uv) for f, c, _ in starts]
            preds[V1(j)] = [(C(j), 0.0, uv)] + ([] if uv else starts) + loop
        else:
            preds[V1(j)] = starts + loop
    K = max(len(p) for p in preds)
    src = np.zeros((S, K), int)
    fixed = np.full((S, K), INF)
    is_start = np.zeros((S, K), bool)
    is_hold = np.zeros((S, K), bool)  # 同じモーラの母音の中で次のフレームへ進む遷移
    v_owner = {st: j for j in range(J) for st in range(V1(j), V(j) + 1)}
    for k, plist in enumerate(preds):
        for i, (f, c, st) in enumerate(plist):
            src[k, i], fixed[k, i], is_start[k, i] = f, c, st
            is_hold[k, i] = k in v_owner and v_owner.get(f) == v_owner[k]

    score = np.full(S, INF)
    score[G(0)] = emit[0, G(0)]
    if J:
        if has_consonant(morae[0]):
            score[C(0)] = emit[0, C(0)] - bonus[0]
        if not (has_consonant(morae[0]) and starts_at_vowel(morae[0])):
            score[V1(0)] = emit[0, V1(0)] - bonus[0]
    back = np.zeros((T, S), np.int8)
    for t in range(1, T):
        cand = score[src] + fixed - np.where(is_start, bonus[t], 0.0) + np.where(is_hold, hold[t], 0.0)
        best = cand.argmin(1)
        score = cand[np.arange(S), best] + emit[t]
        back[t] = best

    final = [G(J), V(J - 1)] if J else [G(J)]
    state = min(final, key=lambda k: score[k])
    total = float(score[state])
    path = np.empty(T, int)
    for t in range(T - 1, -1, -1):
        path[t] = state
        state = src[state, back[t, state]]

    segs: List[Optional[tuple]] = [None] * J
    for j in range(J):
        cf = np.nonzero(path == C(j))[0]
        vf = np.nonzero((path >= V1(j)) & (path <= V(j)))[0]
        if len(vf):
            start = int(cf[0]) if len(cf) and not starts_at_vowel(morae[j]) else int(vf[0])
            segs[j] = (start, int(vf[0]), int(vf[-1]) + 1)
    return segs, total


# ---------------------------------------------------------------- 自己学習


def labels_from_alignment(morae: List[Mora], segs, sil: np.ndarray, params: Params, n_frames: int) -> np.ndarray:
    """DPの配置から学習ラベルを作る。母音が1つに決まるモーラの、母音の先頭(子音からの遷移)を除いた
    有声フレームだけを使う。無音区間はラベルにしない(無音はF0+音量で別に判定するため)。"""
    y = np.full(n_frames, -1)
    for m, seg in zip(morae, segs):
        if seg is None or len(m.vowels) != 1:
            continue
        _, s, e = seg
        for t in range(s + int((e - s) * params.label_skip_head), e):
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
    clf = LogisticRegression(C=params.clf_c, max_iter=2000, class_weight="balanced")
    clf.fit(feats[mask], y[mask])
    out[:, present] = clf.predict_proba(feats)
    return out / out.sum(1, keepdims=True)


def build_features(hidden: np.ndarray, conv: np.ndarray, ctc_vp: np.ndarray, mfcc: np.ndarray, params: Params) -> np.ndarray:
    from sklearn.decomposition import PCA

    def pca(x: np.ndarray) -> np.ndarray:
        h = (x - x.mean(0)) / (x.std(0) + 1e-6)
        z = PCA(n_components=min(params.pca_dims, h.shape[1], len(h)), random_state=0).fit_transform(h)
        return z / (z.std(0) + 1e-6)

    parts = []
    use = params.features.split(",")
    if "mfcc" in use:
        parts.append((mfcc - mfcc.mean(0)) / (mfcc.std(0) + 1e-6))
    if "hidden" in use:
        parts.append(pca(hidden))
    if "conv" in use:
        parts.append(pca(conv))
    if "ctc" in use:
        parts.append(np.log(ctc_vp + 1e-4))
    return np.concatenate(parts, axis=1)


# ---------------------------------------------------------------- 実行


def segs_to_result(lines: List[str], morae: List[Mora], segs) -> list:
    starts: List[Optional[float]] = [None if s is None else s[0] * FRAME_SEC for s in segs]
    ends: List[Optional[float]] = [None if s is None else s[2] * FRAME_SEC for s in segs]
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
    ap.add_argument("--set", action="append", default=[], metavar="名前=値", help="Paramsの値を上書きする(切り分け用)")
    args = ap.parse_args()

    params = Params()
    for kv in args.set:
        k, v = kv.split("=", 1)
        setattr(params, k, type(getattr(params, k))(v))

    project = json.loads((args.project_dir / "project.json").read_text())
    lines = [l["text"] for l in project["lyrics"]]
    notes = project["analysis"]["notes"]

    cache_ok = args.cache and args.cache.exists()
    if cache_ok:
        z = np.load(args.cache)
        cache_ok = int(z["layer"]) == params.hidden_layer
    if cache_ok:
        ctc_vp, hidden, conv, f0, db, audio = z["ctc_vp"], z["hidden"], z["conv"], z["f0"], z["db"], z["audio"]
    else:
        audio = load_vocal_16k(args.project_dir)
        log_probs, hidden, conv, blank_id = wav2vec2_features(audio, params.hidden_layer)
        ctc_vp = ctc_vowel_probs(log_probs, blank_id)
        f0, db = f0_and_db(audio)
        if args.cache:
            np.savez(args.cache, ctc_vp=ctc_vp, hidden=hidden, conv=conv, f0=f0, db=db, audio=audio, layer=params.hidden_layer)

    morae = lyrics_to_morae(lines)
    n = len(ctc_vp)
    sil = silence_prob(f0, db, n, params)
    bonus = note_bonus(n, notes, params) + params.cue_bonus * boundary_cue(f0, db, n, params)
    hold = hold_cost(f0, db, n, params)
    feats = build_features(hidden, conv, ctc_vp, mfcc_features(audio, n, params.mfcc_n, params.mfcc_nfft), params)

    history = []
    vowel_p = ctc_vp
    segs, cost = viterbi(morae, vowel_p, sil, bonus, hold, params)
    history.append({"iteration": 0, "source": "ctc", "cost": cost, "result": segs_to_result(lines, morae, segs)})
    for it in range(1, params.iterations + 1):
        y = labels_from_alignment(morae, segs, sil, params, n)
        vowel_p = train_and_predict(feats, y, params)
        new_segs, cost = viterbi(morae, vowel_p, sil, bonus, hold, params)
        moved = sum(1 for a, b in zip(segs, new_segs) if (a and a[0]) != (b and b[0]))
        segs = new_segs
        history.append(
            {
                "iteration": it,
                "source": "classifier",
                "cost": cost,
                "labels": int((y >= 0).sum()),
                "moved_morae": moved,
                "result": segs_to_result(lines, morae, segs),
            }
        )
        print(f"iter {it}: labels={int((y >= 0).sum())} moved={moved} cost={cost:.1f}", file=sys.stderr)

    out = {
        "params": params.__dict__,
        "lyrics": history[-1]["result"],
        "history": history,
        "frame_vowel_probs": np.round(vowel_p, 3).tolist(),
        "frame_silence": np.round(sil, 3).tolist(),
        "frame_bonus": np.round(bonus, 3).tolist(),
    }
    args.out_json.write_text(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
