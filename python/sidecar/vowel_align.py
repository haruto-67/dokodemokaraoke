"""歌詞のタイミング付け(要件定義書v3 §4.4.7): 発音成分(母音5種+ん+無音)のDP。

2026-10-20に、wav2vec2 CTCの自由デコード+編集距離による方式から置き換えた(Nestio
「どこカラ 発音成分アライメント案」。正解2曲で行の開始の誤差は平均0.014〜0.042秒)。日本語のみ。

仕組み:
- ボーカル音声からフレーム(20ms)ごとに母音クラス a/i/u/e/o/N の確率と無音確率を出す
  - 無音: RMVPEのF0の有無+RMS音量で判定する(分類器は使わない)
  - 母音: MFCCに対するロジスティック回帰。ラベルは曲ごとに自己学習する。初回はwav2vec2の
    CTC出力をblank除外で割り直した母音確率だけでDPを解き、DPの配置結果から母音ラベルを作って
    分類器を学習→再度DP、を繰り返す。CTCの出力は1フレームだけ尖り、伸ばした母音の区間は
    blank確率がほぼ1になるため、時刻決めには使わず初回ラベルの供給元としてだけ使う。
    分類器の特徴はMFCCを主にし、wav2vec2の中間層を後ろへずらして軽く混ぜる(中間層だけだと、
    前後の文脈を混ぜるため母音の切り替わりを0.3秒ほど先取りする。聞き分け自体はMFCCより強い)
- 歌詞はpyopenjtalk(ルビ優先、lyrics_reading.text_to_hiragana_reading)のモーラ読みを
  同じクラスに落とす。「ん」「ー」「っ」は前の音にくっつく(長さ0で読み飛ばす)ことも許す
- 各モーラは「子音(省略可)→母音」の状態で表し、歌詞の順序を守ったまま曲全体を1回のViterbiで配置する
- 行の間(曲頭・間奏)には「歌詞でない声」の状態を置き、行の途中の無音は長いほどコストを課す。
  無いと、曲頭や間奏にある声を行の端のモーラが吸い込み、そのモーラだけ数十秒飛んでいた
- コスト = 発音の不一致(-log確率)
          - モーラ開始が切れ目の手がかり(発音の立ち上がり・音量の谷・音程の変わり目・ノート開始)に乗るボーナス
          + 母音を保ったまま大きな音程の跳躍・強い発音の立ち上がりを越えるコスト
  1モーラが複数ノートにまたがることは許している(小さな音程の変化は越えてもコストが無い)

パラメータの調整・正解データとの比較は python/experiments/(vowel_dp_align.py、eval_alignment.py)で行う。
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Callable, List, Optional, TypedDict

import numpy as np

SR = 16000
HOP = 320  # wav2vec2の出力1フレーム = 20ms
FRAME_SEC = HOP / SR
CLASSES = ["a", "i", "u", "e", "o", "N"]

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
    mfcc_n: int = 20
    mfcc_nfft: int = 1024  # 64ms。低い声で倍音を分解できるよう、20ms刻みより広い窓で見る
    # wav2vec2の中間層の特徴も分類器に加える。母音の聞き分けはMFCCより強い(正解ラベルで学習させた時の
    # フレーム正解率: ショート2で61%→74%)が、前後の文脈を混ぜるため母音の切り替わりを先取りする。
    # そのぶん後ろへずらし、MFCCより軽く重み付けして混ぜる(自己学習後の正解率 73%→86%、モーラの開始の誤差は同等)
    hidden_layer: int = 8  # 12層中
    hidden_dims: int = 32  # PCAで落とす次元
    hidden_weight: float = 0.75
    hidden_delay_frames: int = 6  # 120ms
    clf_c: float = 0.01  # ロジスティック回帰の正則化(小さいほど強い)。自己学習のラベルは誤りを含むため強めにする
    iterations: int = 5
    label_skip_head: float = 0.3  # ラベル化でモーラの母音の先頭から除く割合(子音からの遷移部分)
    # 無音
    silence_db: float = -40.0  # 最大音量からの相対dB。これより小さく、F0も無いと無音
    voiced_min_db: float = -40.0  # F0があってもこれより小さい音量なら有声とみなさない(間奏中の残響・漏れ込み)
    filler_cost: float = 1.5  # 行の間(曲頭・間奏を含む)の「歌詞でない声」の状態の1フレームごとのコスト
    filler_entry_cost: float = 5.0  # その状態に入るコスト(短い行頭・行末の音を吸い込ませないため)
    # モーラ開始のボーナス
    # 発音の立ち上がり(アタック)を主、音量の谷・音程の変わり目を従にする。音程の変わり目は、しゃくり上げ等で
    # 文字の途中にも多く出る(ショート2で1秒に約11個)ため、それだけで区切ると1つ前の候補へずれていた。
    # アタックを加えて正解2曲のモーラの開始の誤差: 0.03秒以内 44%→52%・42%→55%、中央値 0.035→0.028・0.033→0.028秒
    cue_bonus: float = 1.0  # 切れ目の手がかり(音量の谷・音程の変わり目)に乗った時に下げるコスト
    cue_sigma_sec: float = 0.02
    attack_bonus: float = 3.0  # アタックに乗った時に下げるコスト(強さ1あたり)
    attack_sigma_sec: float = 0.02
    attack_shift_sec: float = 0.02  # 信号のピークは手修正の開始より約20ms早いため、後ろへずらす
    attack_min: float = 0.2  # 曲の上位1%を1とした強さで、これより弱いピークは使わない(行の境目で前の行の音を奪っていた)
    attack_hold: float = 1.0  # 母音を保ったまま強いアタックを越えるコスト(強さ1あたり)。大きくすると歌い回しの揺れで切る
    note_bonus: float = 2.0  # ノート開始に乗った時に下げるコスト(手がかりの補助。単独では粗い)
    note_sigma_sec: float = 0.04
    beat_bonus: float = 0.0  # 拍の格子(8分音符等)に乗った時に下げるコスト。格子が渡された時だけ効く
    beat_sigma_sec: float = 0.02
    dip_window_sec: float = 0.1
    dip_min_db: float = 2.0
    dip_full_db: float = 6.0
    pitch_window_sec: float = 0.05
    pitch_min_semitone: float = 0.7
    pitch_full_semitone: float = 1.5
    # 音程の跳躍(しゃくり上げ等で一方向に動き続ける区間)で、新しい高さに着いた所に乗った時に下げるコスト。
    # 正解では3半音以上の跳躍の60%で、着いた所の±60ms以内にモーラの開始があった(上がり始めは35%)
    glide_bonus: float = 3.0
    glide_sigma_sec: float = 0.02
    glide_min_semitone: float = 1.5
    glide_full_semitone: float = 4.0  # この段差で強さ1
    glide_min_velocity: float = 8.0  # 半音/秒。これより速く一方向に動いている所を跳躍とみなす(ビブラートの往復は段差が小さい)
    # 母音を保ったまま大きな音程の跳躍を越えるコスト
    hold_penalty: float = 8.0
    hold_min_semitone: float = 1.5
    hold_full_semitone: float = 3.0
    hold_min_db: float = -15.0  # 跳躍の後の声量がこれより小さい(語尾の減衰)時は対象外
    # DPの状態
    gap_entry_cost: float = 1.5  # 行の途中で無音(息継ぎ)を挟むコスト。行の間は0
    gap_frame_cost: float = 0.1  # 行の途中の無音を1フレーム伸ばすごとのコスト(1行の中に長い空白を作らせない)
    unvoiced_in_mora: float = 0.15  # 母音の状態での無声フレーム(息・かすれ)の許容度
    cons_base: float = 0.2  # 子音の状態の放出確率(有声フレーム)
    cons_unvoiced: float = 0.4  # 子音の状態で無声フレームに上乗せする確率
    cons_loop_cost: float = 0.8  # 子音を1フレーム伸ばすごとのコスト(長い息継ぎを子音にしないため)
    min_vowel_frames: int = 4  # 母音部分の最小フレーム数(80ms)。1フレームだけのモーラを作らせない
    prob_floor: float = 1e-3


# ---------------------------------------------------------------- 歌詞 → モーラ


@dataclass
class Mora:
    """タイミング付けの単位。日本語はモーラ、英語は音節。"""

    text: str  # 日本語はひらがな(拗音は2文字)、英語は音節の音素(ARPAbet、例: "S T R AO NG")
    kind: str  # "V"(母音あり) / "N"(ん) / "Q"(っ) / "R"(ー)
    vowels: tuple  # 一致とみなす母音クラス
    line: int
    onset: str = ""  # 頭の子音: ""(無し) / "voiced" / "unvoiced"
    word: Optional[int] = None  # 英単語の音節は同じ単語で同じ番号(結果は単語ごとにまとめる)
    word_text: str = ""  # 英単語の表記


# 英語の母音(ARPAbet)→ 一致とみなす母音クラス。日本語の5母音に無い音は、近い母音を複数許す
# (曖昧母音 AH は「ア・ウ・オ」のどれにも聞こえる)。二重母音は両方の母音を許す
_ARPABET_VOWELS = {
    "AA": ("a", "o"),
    "AE": ("a", "e"),
    "AH": ("a", "u", "o"),
    "AO": ("o", "a"),
    "AW": ("a", "u"),
    "AY": ("a", "i"),
    "EH": ("e",),
    "ER": ("a", "u", "o"),
    "EY": ("e", "i"),
    "IH": ("i", "e"),
    "IY": ("i",),
    "OW": ("o", "u"),
    "OY": ("o", "i"),
    "UH": ("u", "o"),
    "UW": ("u",),
}


def split_morae(reading: str) -> List[str]:
    morae: List[str] = []
    for ch in reading:
        if ch in _SMALL and morae:
            morae[-1] += ch
        elif ch in _VOWEL_OF or ch in "んっー":
            morae.append(ch)
        # 空白・記号などはモーラにしない
    return morae


def _japanese_morae(text: str, li: int) -> List[Mora]:
    from lyrics_reading import text_to_hiragana_reading

    out: List[Mora] = []
    prev_vowel: Optional[str] = None
    for m in split_morae(text_to_hiragana_reading(text)):
        last = m[-1]
        if last == "ん":
            mora = Mora(m, "N", ("N",), li)
        elif last == "っ":
            mora = Mora(m, "Q", (), li)
        elif last == "ー":
            mora = Mora(m, "R", (prev_vowel,) if prev_vowel else tuple(CLASSES[:5]), li)
        else:
            v = _VOWEL_OF[last]
            onset = "" if m[0] in "あいうえお" else "unvoiced" if m[0] in _UNVOICED_ONSET else "voiced"
            # 「おう」「えい」は歌では「おー」「えー」と伸ばすことが多いため両方を許す
            if m == "う" and prev_vowel == "o":
                mora = Mora(m, "V", ("u", "o"), li, onset)
            elif m == "い" and prev_vowel == "e":
                mora = Mora(m, "V", ("i", "e"), li, onset)
            else:
                mora = Mora(m, "V", (v,), li, onset)
        out.append(mora)
        if mora.kind == "V":
            prev_vowel = _VOWEL_OF[last]
        elif mora.kind in ("N", "Q"):
            prev_vowel = None
    return out


def _english_morae(word: str, li: int, word_id: int) -> List[Mora]:
    """英単語を音節に分け、音節ごとに1単位にする。末子音に鼻音(m/n/ng)があれば「ん」も許す。"""
    from english_g2p import NASALS, UNVOICED, word_syllables

    out = []
    for syl in word_syllables(word):
        vowels = _ARPABET_VOWELS[syl.nucleus]
        if any(c in NASALS for c in syl.coda):
            vowels = vowels + ("N",)
        onset = "" if not syl.onset else "unvoiced" if syl.onset[0] in UNVOICED else "voiced"
        out.append(Mora(syl.text, "V", vowels, li, onset, word_id, word))
    return out


def lyrics_to_morae(lines: List[str]) -> List[Mora]:
    """歌詞行を、日本語はモーラ・英単語は音節の単位にする。"""
    from english_g2p import WORD_RE

    out: List[Mora] = []
    word_id = 0
    for li, line in enumerate(lines):
        pos = 0
        for m in WORD_RE.finditer(line):
            out += _japanese_morae(line[pos : m.start()], li)
            out += _english_morae(m.group(), li, word_id)
            word_id += 1
            pos = m.end()
        out += _japanese_morae(line[pos:], li)
    return out


def has_consonant(m: Mora) -> bool:
    return m.kind == "V" and m.onset != ""


def starts_at_vowel(m: Mora) -> bool:
    """子音で始まるモーラは、母音の始まりを開始とする。手修正後の正解では無声の子音(k/s/t/h/p)の
    「つ」「し」がこの位置に置かれていた。有声の子音(m/n/r/g/z/d/b等)は以前は子音の始まり(音量の谷)を
    開始にしていたが、正解は新しい音の高さに着いた所・アタックの所に置かれ、子音の始まりより平均10ms
    以上遅かった(花の「な」で、谷の89.30秒に対し正解は89.40秒)。母音の始まりに揃えると、有声の子音の
    モーラの開始の誤差が0.03秒以内 55%→68%(ショート2)になった。"""
    return m.onset != ""


# ---------------------------------------------------------------- 音響特徴


def wav2vec2_outputs(audio: np.ndarray, model_path: Path, layer: int):
    """wav2vec2のCTCのlog確率と指定した中間層の特徴(どちらも20msフレーム)、blank IDを返す。20秒チャンクで推論して連結。"""
    import torch

    from lyrics_reading import load_wav2vec2_model, normalize_audio

    model = load_wav2vec2_model(model_path)
    chunk = 20 * SR
    lps, hids = [], []
    with torch.no_grad():
        for s in range(0, len(audio), chunk):
            x = audio[s : s + chunk]
            if len(x) < HOP * 2:
                continue
            out = model(torch.from_numpy(normalize_audio(x)).unsqueeze(0), output_hidden_states=True)
            lps.append(torch.log_softmax(out.logits, dim=-1)[0].numpy())
            hids.append(out.hidden_states[layer][0].numpy())
    return np.concatenate(lps), np.concatenate(hids), model.config.pad_token_id


def ctc_vowel_probs(log_probs: np.ndarray, blank_id: int) -> np.ndarray:
    """blankを除いて割り直したCTC確率を、各トークン読みの最後のかなの母音へ集約する(初回DP用)。"""
    from lyrics_reading import Wav2Vec2Vocab, subword_to_reading

    vocab = Wav2Vec2Vocab()
    cache: dict = {}
    m = np.zeros((log_probs.shape[1], len(CLASSES)))
    for tid in range(log_probs.shape[1]):
        reading = subword_to_reading(vocab.decode_single(tid), cache)
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


def relative_db(audio: np.ndarray) -> np.ndarray:
    """最大音量からの相対dB(10ms刻み。RMVPEのF0と同じ刻み)。"""
    import librosa

    rms = librosa.feature.rms(y=audio, frame_length=640, hop_length=160, center=True)[0]
    return 20 * np.log10(np.maximum(rms, 1e-9) / max(rms.max(), 1e-9))


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
    fdb = _to_frames(db, n_frames)
    voiced = (_to_frames((f0 > 0).astype(float), n_frames) > 0) & (fdb > params.voiced_min_db)
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
    return _to_frames(_spread(cue, params.cue_sigma_sec * fps), n_frames)


def pitch_glides(f0: np.ndarray, params: Params) -> List[tuple]:
    """音程が一方向に動き続ける区間(跳躍・しゃくり)を探し、[(始まり, 着いた所, 段差の半音)](10ms刻みの添字)を返す。
    ビブラートは往復が短く段差が小さいため glide_min_semitone で落ちる。"""
    st = np.where(f0 > 0, 12 * np.log2(np.maximum(f0, 1) / 440) + 69, np.nan)
    out: List[tuple] = []
    voiced = ~np.isnan(st)
    i, n = 0, len(st)
    while i < n:
        if not voiced[i]:
            i += 1
            continue
        # 有声の区間(30ms以下の途切れはつなぐ)
        a, last, j = i, i, i
        while j < n and (voiced[j] or j - last <= 3):
            if voiced[j]:
                last = j
            j += 1
        b, i = last + 1, last + 1
        if b - a < 8:
            continue
        x = st[a:b].copy()
        idx = np.arange(len(x))
        ok = ~np.isnan(x)
        x[~ok] = np.interp(idx[~ok], idx[ok], x[ok])
        x = np.convolve(np.pad(x, 1, mode="edge"), np.ones(3) / 3, "valid")
        v = np.gradient(x) * 100
        sgn = np.where(v > params.glide_min_velocity, 1, np.where(v < -params.glide_min_velocity, -1, 0))
        k = 0
        while k < len(x):
            if sgn[k] == 0:
                k += 1
                continue
            e = k
            while e + 1 < len(x) and sgn[e + 1] == sgn[k]:
                e += 1
            step = x[min(e + 1, len(x) - 1)] - x[max(k - 1, 0)]
            if abs(step) >= params.glide_min_semitone:
                out.append((a + k, a + e + 1, float(step)))
            k = e + 1
    return out


def glide_cue(f0: np.ndarray, n_frames: int, params: Params) -> np.ndarray:
    """跳躍で新しい高さに着いた所(0〜1。段差が大きいほど強い)を20msフレームへ。"""
    cue = np.zeros(len(f0))
    for _, arrive, step in pitch_glides(f0, params):
        t = min(arrive, len(cue) - 1)
        cue[t] = max(cue[t], min(1.0, abs(step) / params.glide_full_semitone))
    return _to_frames(_spread(cue, params.glide_sigma_sec * 100), n_frames)


def attack_strength(audio: np.ndarray) -> np.ndarray:
    """発音の立ち上がりの強さ(10ms刻み。RMVPEのF0と同じ刻み)。対数メルスペクトルが20ms前より
    強くなった量の、帯域の平均(スペクトルフラックス)。子音の破裂・摩擦や、同じ母音の歌い直しで大きくなる。"""
    import librosa

    s = librosa.feature.melspectrogram(y=audio, sr=SR, n_fft=1024, hop_length=160, n_mels=64, fmax=8000)
    log_s = np.log(s + 1e-8 * max(s.max(), 1e-12))
    flux = np.zeros(log_s.shape[1])
    flux[2:] = np.maximum(log_s[:, 2:] - log_s[:, :-2], 0).mean(0)
    return flux


def attack_peaks(attack: np.ndarray, params: Params) -> np.ndarray:
    """アタックの局所最大を、曲の上位1%を1とした強さ(0〜1)で返す(10ms刻み。ピーク以外は0)。
    信号のピークは手修正の開始より早いため、attack_shift_sec だけ後ろへずらす。"""
    x = np.clip(attack / max(np.percentile(attack, 99), 1e-12), 0, 1)
    w = 5
    peaks = np.zeros(len(x))
    for i in range(len(x)):
        lo, hi = max(0, i - w), min(len(x), i + w + 1)
        if x[i] >= params.attack_min and x[i] >= x[lo:hi].max():
            peaks[i] = x[i]
    shift = int(round(params.attack_shift_sec * 100))
    return np.roll(peaks, shift) if shift else peaks


def attack_cue(attack: np.ndarray, n_frames: int, params: Params) -> np.ndarray:
    """アタックのピークをぼかして20msフレームへ。"""
    return _to_frames(_spread(attack_peaks(attack, params), params.attack_sigma_sec * 100), n_frames)


def attack_marks(attack: np.ndarray, params: Params) -> List[dict]:
    """編集画面のタイムラインに出すアタックの位置と強さ(0〜1)。"""
    peaks = attack_peaks(attack, params)
    return [{"time": round(i / 100, 3), "strength": round(float(peaks[i]), 2)} for i in np.nonzero(peaks)[0]]


def _spread(cue: np.ndarray, sig: float) -> np.ndarray:
    """各点の値をガウスでぼかす(重なる所は最大を取る)。"""
    r = int(3 * sig)
    spread = np.zeros_like(cue)
    for i in np.nonzero(cue)[0]:
        for d in range(-r, r + 1):
            if 0 <= i + d < len(cue):
                spread[i + d] = max(spread[i + d], cue[i] * np.exp(-0.5 * (d / sig) ** 2))
    return spread


def note_bonus(n_frames: int, notes: list, params: Params) -> np.ndarray:
    t = np.arange(n_frames) * FRAME_SEC
    if not notes or params.note_bonus == 0:
        return np.zeros(n_frames)
    onsets = np.array(sorted(n["start"] for n in notes))
    pos = np.clip(np.searchsorted(onsets, t), 1, len(onsets) - 1)
    d = np.minimum(np.abs(t - onsets[pos - 1]), np.abs(t - onsets[pos]))
    return params.note_bonus * np.exp(-0.5 * (d / params.note_sigma_sec) ** 2)


def beat_bonus(n_frames: int, beat_times: Optional[np.ndarray], params: Params) -> np.ndarray:
    """拍の格子の各時刻に近いフレームほど大きいボーナス(モーラの開始を拍に乗せやすくする)。"""
    if beat_times is None or len(beat_times) < 2 or params.beat_bonus == 0:
        return np.zeros(n_frames)
    t = np.arange(n_frames) * FRAME_SEC
    grid = np.sort(np.asarray(beat_times, dtype=np.float64))
    pos = np.clip(np.searchsorted(grid, t), 1, len(grid) - 1)
    d = np.minimum(np.abs(t - grid[pos - 1]), np.abs(t - grid[pos]))
    return params.beat_bonus * np.exp(-0.5 * (d / params.beat_sigma_sec) ** 2)


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
    - 子音のあるモーラは子音を必ず通し、開始は母音の始まりとする(starts_at_vowel)
    - 母音は最低Lフレーム続ける。同じ母音が続く「らあ」で「ら」を1フレームにして済ませていたため
    遷移: 自己ループ / G_j→C_j,V_j / C_j→V_j / V_j→G_{j+1},C_{j+1},V_{j+1} /
    「ん」「ー」「っ」のモーラkは読み飛ばし可(V_{k-1}→G_{k+1},C_{k+1},V_{k+1})。
    モーラの開始にはbonus[t]を与え、母音の中で次のフレームへ進む時はhold[t]を課す。
    戻り値は各モーラの(開始, 母音の開始, 終了)フレーム。読み飛ばしたモーラはNone。"""
    J = len(morae)
    L = max(1, params.min_vowel_frames)
    B = 2 + L  # 1モーラあたりの状態数
    # 行の間(曲頭・曲末を含む)の G_j には、歌詞でない声(前奏の声・間奏の漏れ込みなど)を受ける状態 F_j を添える。
    # これが無いと、そうした声を近くのモーラが吸い込み、そのモーラが行の外へ大きく飛ぶ
    between = [j for j in range(J + 1) if j == 0 or j == J or morae[j].line != morae[j - 1].line]
    F = {j: B * J + 1 + k for k, j in enumerate(between)}
    S = B * J + 1 + len(between)
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
        if 0 < j < J and morae[j].line == morae[j - 1].line:
            emit[:, G(j)] += params.gap_frame_cost
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
    emit[:, list(F.values())] = params.filler_cost

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
        if j in F:
            fe = params.filler_entry_cost
            preds[F[j]] = [(F[j], 0.0, False), (G(j), fe, False)] + [(v, fe, False) for v in prev_vs]
            preds[G(j)].append((F[j], 0.0, False))
        if j == J:
            break
        starts = [(G(j), 0.0, True)] + [(v, 0.0, True) for v in prev_vs] + ([(F[j], 0.0, True)] if j in F else [])
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
    score[F[0]] = params.filler_entry_cost + emit[0, F[0]]
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

    final = [G(J), F[J], V(J - 1)] if J else [G(J), F[J]]
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


def _standardize(x: np.ndarray) -> np.ndarray:
    return (x - x.mean(0)) / (x.std(0) + 1e-6)


def classifier_features(mfcc: np.ndarray, hidden: np.ndarray, params: Params) -> np.ndarray:
    """母音分類器の入力: 正規化したMFCC+Δと、wav2vec2中間層をPCAで落として後ろへずらし、重みを掛けたもの。"""
    from sklearn.decomposition import PCA

    n = len(mfcc)
    h = _standardize(hidden[:n])
    z = PCA(n_components=min(params.hidden_dims, h.shape[1], n), random_state=0).fit_transform(h)
    z = z / (z.std(0) + 1e-6)
    d = params.hidden_delay_frames
    if d > 0:
        z = np.concatenate([np.repeat(z[:1], d, axis=0), z[:-d]])
    return np.concatenate([_standardize(mfcc), params.hidden_weight * z], axis=1)


# ---------------------------------------------------------------- 実行


class AlignedReadingToken(TypedDict):
    reading: str
    start: float
    end: float


class AlignedLine(TypedDict):
    """main.pyがアプリへ返す1行分の結果(src/shared/pythonSidecarProtocol.tsのAnalyzeSidecarLine)。"""

    text: str
    annotatedText: str
    start: float
    end: float
    confidence: float
    tokenTimings: List[AlignedReadingToken]


class HeardSound(TypedDict):
    """聞き取った音の区間(編集画面のタイムラインに表示する)。labelは a/i/u/e/o/N(ん)/unvoiced(無声: 子音か息)。"""

    start: float
    end: float
    label: str


@dataclass
class Features:
    """音響特徴。どれも曲全体分。調整用スクリプト(experiments/)がキャッシュできるよう、ここに集める。"""

    ctc_vp: np.ndarray  # 初回DP用の母音確率(20msフレーム × CLASSES)
    f0: np.ndarray  # RMVPEのF0(Hz、無声は0。10ms刻み)
    db: np.ndarray  # 最大音量からの相対dB(10ms刻み)
    frame_feats: np.ndarray  # 母音分類器の入力(20msフレーム。classifier_features)
    attack: np.ndarray  # 発音の立ち上がりの強さ(10ms刻み。attack_strength)


def compute_features(audio: np.ndarray, f0_100fps: np.ndarray, model_path: Path, params: Params) -> Features:
    """audioは16kHzモノラルのボーカル。f0はRMVPEで同じaudioから求めた10ms刻みのF0。"""
    log_probs, hidden, blank_id = wav2vec2_outputs(audio, model_path, params.hidden_layer)
    n = len(log_probs)
    db = relative_db(audio)
    m = min(len(f0_100fps), len(db))
    return Features(
        ctc_vp=ctc_vowel_probs(log_probs, blank_id),
        f0=np.asarray(f0_100fps[:m], dtype=np.float64),
        db=db[:m],
        frame_feats=classifier_features(mfcc_features(audio, n, params.mfcc_n, params.mfcc_nfft), hidden, params),
        attack=attack_strength(audio),
    )


@dataclass
class Alignment:
    morae: List[Mora]
    segs: list  # モーラごとの(開始, 母音の開始, 終了)フレーム。読み飛ばしたモーラはNone
    vowel_p: np.ndarray  # 最後の反復の母音確率(20msフレーム × CLASSES)
    sil: np.ndarray  # 無音確率(20msフレーム)
    history: list  # 反復ごとの(反復, 合計コスト, 動いたモーラ数)


def align(
    lyrics_lines: List[str],
    feats: Features,
    notes: list,
    params: Optional[Params] = None,
    on_progress: Optional[Callable[[float], None]] = None,
    beat_times: Optional[np.ndarray] = None,
) -> Alignment:
    """歌詞行の全モーラを曲全体へ配置する。初回はCTCの母音確率でDPを解き、その配置を
    ラベルにした母音分類器で解き直すことをparams.iterations回繰り返す。"""
    params = params or Params()
    morae = lyrics_to_morae(lyrics_lines)
    n = len(feats.ctc_vp)
    sil = silence_prob(feats.f0, feats.db, n, params)
    attack = attack_cue(feats.attack, n, params)
    glide = glide_cue(feats.f0, n, params)
    bonus = (
        note_bonus(n, notes, params)
        + params.cue_bonus * boundary_cue(feats.f0, feats.db, n, params)
        + params.attack_bonus * attack
        + params.glide_bonus * glide
        + beat_bonus(n, beat_times, params)
    )
    hold = hold_cost(feats.f0, feats.db, n, params) + params.attack_hold * attack

    vowel_p = feats.ctc_vp
    segs, cost = viterbi(morae, vowel_p, sil, bonus, hold, params)
    history = [(0, cost, None)]
    for it in range(1, params.iterations + 1):
        if on_progress:
            on_progress(it / (params.iterations + 1))
        y = labels_from_alignment(morae, segs, sil, params, n)
        vowel_p = train_and_predict(feats.frame_feats, y, params)
        new_segs, cost = viterbi(morae, vowel_p, sil, bonus, hold, params)
        moved = sum(1 for a, b in zip(segs, new_segs) if (a and a[0]) != (b and b[0]))
        segs = new_segs
        history.append((it, cost, moved))
    return Alignment(morae, segs, vowel_p, sil, history)


def _mora_times(morae: List[Mora], segs) -> tuple:
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
    return starts, ends


def _line_confidence(morae: List[Mora], segs, idx: List[int], vowel_p: np.ndarray) -> float:
    """行の各モーラの母音部分で、歌詞の母音の確率がどれだけ高いかの平均(0..1)。
    低い行は配置に自信が無い(編集画面で目立たせる)。"""
    scores = []
    for j in idx:
        m, seg = morae[j], segs[j]
        if seg is None or not m.vowels:
            continue
        _, s, e = seg
        cols = [CLASSES.index(v) for v in m.vowels]
        scores.append(float(vowel_p[s:e, cols].max(1).mean()))
    return float(np.mean(scores)) if scores else 0.0


def _token_timings(morae: List[Mora], idx: List[int], starts, ends) -> List[AlignedReadingToken]:
    """行のモーラごとの時刻。英単語の音節は単語ごとに1つにまとめる(画面では英単語が1文字の扱いのため)。"""
    out: List[AlignedReadingToken] = []
    for j in idx:
        m = morae[j]
        if m.word is not None and j > idx[0] and morae[j - 1].word == m.word:
            out[-1]["end"] = float(ends[j])
            continue
        reading = m.word_text if m.word is not None else m.text
        out.append({"reading": reading, "start": float(starts[j]), "end": float(ends[j])})
    return out


def to_aligned_lines(lyrics_lines: List[str], result: Alignment) -> List[AlignedLine]:
    from lyrics_reading import auto_annotate_ruby

    morae, segs = result.morae, result.segs
    starts, ends = _mora_times(morae, segs)
    lines: List[AlignedLine] = []
    prev_end = 0.0
    for li, text in enumerate(lyrics_lines):
        idx = [j for j, m in enumerate(morae) if m.line == li]
        # 読みが空の行(記号だけ等)は直前の行の終わりに長さ0で置く
        start = starts[idx[0]] if idx else prev_end
        end = ends[idx[-1]] if idx else prev_end
        lines.append(
            {
                "text": text,
                "annotatedText": auto_annotate_ruby(text),
                "start": float(start),
                "end": float(end),
                "confidence": _line_confidence(morae, segs, idx, result.vowel_p),
                "tokenTimings": _token_timings(morae, idx, starts, ends),
            }
        )
        prev_end = end
    return lines


def heard_sounds(vowel_p: np.ndarray, sil: np.ndarray, min_frames: int = 3) -> List[HeardSound]:
    """フレームごとに聞き取った音(母音の最尤クラス / 無声 / 無音)を区間にまとめる。無音の区間は返さない。
    無声は、F0が無いが音量はある所(子音か息。silence_probが0.5前後)。min_framesより短い区間は直前の区間へまとめる。"""
    labels = np.where(sil < 0.3, np.argmax(vowel_p, axis=1), np.where(sil < 0.75, len(CLASSES), -1))
    names = CLASSES + ["unvoiced"]
    runs: List[list] = []  # [ラベル, 開始フレーム, 終了フレーム]
    for t, lab in enumerate(labels):
        if runs and runs[-1][0] == lab and runs[-1][2] == t:
            runs[-1][2] = t + 1
        else:
            runs.append([int(lab), t, t + 1])
    merged: List[list] = []
    for run in runs:
        if merged and run[2] - run[1] < min_frames and merged[-1][2] == run[1] and run[0] != -1 and merged[-1][0] != -1:
            merged[-1][2] = run[2]
        elif merged and merged[-1][0] == run[0] and merged[-1][2] == run[1]:
            merged[-1][2] = run[2]
        else:
            merged.append(run)
    return [
        {"start": round(a * FRAME_SEC, 3), "end": round(b * FRAME_SEC, 3), "label": names[lab]}
        for lab, a, b in merged
        if lab != -1
    ]


def align_lyrics_lines(
    lyrics_lines: List[str],
    vocals_16k_mono: np.ndarray,
    f0_100fps: np.ndarray,
    notes: list,
    model_path: Path,
    on_progress: Optional[Callable[[float], None]] = None,
) -> tuple:
    """main.pyから呼ぶ入口。(行ごとの結果, 聞き取った音の区間, アタックの位置)を返す。"""
    if not lyrics_lines:
        return [], [], []
    params = Params()
    feats = compute_features(vocals_16k_mono, f0_100fps, model_path, params)
    result = align(lyrics_lines, feats, notes, params, on_progress)
    return (
        to_aligned_lines(lyrics_lines, result),
        heard_sounds(result.vowel_p, result.sil),
        attack_marks(feats.attack, params),
    )
