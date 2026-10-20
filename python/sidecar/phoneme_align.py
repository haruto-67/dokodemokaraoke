"""英語が主の曲の歌詞タイミング付け: 多言語の音素認識モデルの出力に、歌詞の発音記号の並びを強制アライメントする。

日本語の曲は vowel_align.py(日本語wav2vec2+母音DP)のほうが正確なため、そちらを使う
(正解2曲で行の開始の誤差 0.031・0.020秒、この方式では 0.085・0.035秒)。英語は母音5種への
置き換えでは決め手にならず(曖昧母音・二重母音が多い)、子音を含めた発音記号で当てはめる必要があった
(英語の正解1曲で、母音DPでは行の開始が平均3.6秒ずれ、この方式では最初の8行が0.25秒以内)。

- 音素認識モデル: facebook/wav2vec2-xlsr-53-espeak-cv-ft(Apache-2.0)を半精度にしたもの。
  出力はespeakの発音記号(IPA)。設定と語彙はsafetensorsのメタデータに入れてある
- 歌詞の発音: 英単語は english_g2p(CMU発音辞書+推定)のARPAbetをIPAへ、日本語はかな読みをIPAへ変換する
- 曲全体を1回のCTCのViterbiで配置する。単位(英語は単語、日本語はモーラ)の開始 = 最初の音素が出るフレーム
- CTCの出るフレームは発音の立ち上がりから前後に数十msばらつく(英語の正解1曲の最初の7行で、単語の開始の誤差の
  中央値0.060秒)ため、近くのアタックへ寄せる(snap_to_attacks。0.03秒以内 10%→59%、拍に寄せた後 73%→76%)
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Callable, List, Optional, Tuple

import numpy as np

from vowel_align import FRAME_SEC, HOP, SR, AlignedLine, AlignedReadingToken, HeardSound, Params, attack_peaks, lyrics_to_morae

MODEL_FILENAME = "wav2vec2-xlsr-53-espeak-cv-ft.f16.safetensors"
# アプリには同梱せず、初めて英語の曲を解析する時にダウンロードする(paths.ensure_downloaded_model)。
# python/models.json の同じモデルの項目と一致させる(phoneme_align_test で確かめる)
MODEL_URL = "https://github.com/haruto-67/dokodemokaraoke/releases/download/model-weights-v1/" + MODEL_FILENAME
MODEL_SHA256 = "4599fc82129a5467b04735507651b939043a9a2ac02a1a8b109eb83d42e9f277"
MODEL_SIZE = 631737096

# 単位の開始を寄せるアタックの範囲(秒)・最小の強さ・近さの重み(ガウスの幅、秒)
SNAP_WINDOW_SEC = 0.1
SNAP_MIN_STRENGTH = 0.2
SNAP_SIGMA_SEC = 0.05
MIN_UNIT_SEC = 0.04

# ARPAbet → espeak IPA(モデルの語彙にある記号)。曖昧母音・r音化母音は強勢の有無で分ける
_ARPA_IPA = {
    "AA": "ɑː", "AE": "æ", "AH0": "ə", "AH": "ʌ", "AO": "ɔː", "AW": "aʊ", "AY": "aɪ", "EH": "ɛ", "ER0": "ɚ",
    "ER": "ɜː", "EY": "eɪ", "IH": "ɪ", "IY": "iː", "OW": "oʊ", "OY": "ɔɪ", "UH": "ʊ", "UW": "uː",
    "B": "b", "CH": "tʃ", "D": "d", "DH": "ð", "F": "f", "G": "ɡ", "HH": "h", "JH": "dʒ", "K": "k", "L": "l",
    "M": "m", "N": "n", "NG": "ŋ", "P": "p", "R": "ɹ", "S": "s", "SH": "ʃ", "T": "t", "TH": "θ", "V": "v",
    "W": "w", "Y": "j", "Z": "z", "ZH": "ʒ",
}  # fmt: skip

# かな → IPA
_KANA_ROWS = [
    ("あいうえお", ""), ("かきくけこ", "k"), ("がぎぐげご", "ɡ"), ("さしすせそ", "s"), ("ざじずぜぞ", "z"),
    ("たちつてと", "t"), ("だぢづでど", "d"), ("なにぬねの", "n"), ("はひふへほ", "h"), ("ばびぶべぼ", "b"),
    ("ぱぴぷぺぽ", "p"), ("まみむめも", "m"), ("らりるれろ", "ɾ"),
]  # fmt: skip
_KANA = {ch: ([c] if c else []) + [v] for row, c in _KANA_ROWS for ch, v in zip(row, "aiueo")}
_KANA.update({"や": ["j", "a"], "ゆ": ["j", "u"], "よ": ["j", "o"], "わ": ["w", "a"], "を": ["o"], "ゔ": ["b", "u"]})
_KANA.update({"し": ["ɕ", "i"], "ち": ["tɕ", "i"], "つ": ["ts", "u"], "ふ": ["ɸ", "u"], "じ": ["dʑ", "i"],
              "ぢ": ["dʑ", "i"], "づ": ["z", "u"], "ひ": ["ç", "i"]})  # fmt: skip
_SMALL_VOWEL = {"ゃ": "a", "ゅ": "u", "ょ": "o", "ぁ": "a", "ぃ": "i", "ぅ": "u", "ぇ": "e", "ぉ": "o", "ゎ": "a"}


def arpabet_to_ipa(phone: str) -> str:
    base = phone.rstrip("012")
    if phone.endswith("0") and base + "0" in _ARPA_IPA:
        return _ARPA_IPA[base + "0"]
    return _ARPA_IPA[base]


def mora_to_ipa(mora: str, prev_vowel: Optional[str]) -> List[str]:
    """かな1モーラ(拗音は2文字)の発音記号。「っ」は音が無いため空、「ー」は直前の母音。"""
    if mora == "ん":
        return ["ɴ"]
    if mora == "っ":
        return []
    if mora == "ー":
        return [prev_vowel] if prev_vowel else []
    head = _KANA.get(mora[0], [])
    if len(mora) == 2 and mora[1] in _SMALL_VOWEL:
        cons = head[:-1]
        glide = ["j"] if mora[1] in "ゃゅょ" and cons and cons[0] not in ("ɕ", "tɕ", "dʑ") else []
        return cons + glide + [_SMALL_VOWEL[mora[1]]]
    return list(head)


def lyrics_units(lines: List[str]) -> List[Tuple[int, str, List[str]]]:
    """歌詞を [(行, 表記, 発音記号の列)] の単位にする。英語は単語、日本語はモーラ
    (画面の文字の単位と同じ。英単語は1文字の扱い)。"""
    from english_g2p import word_phonemes

    units: List[Tuple[int, str, List[str]]] = []
    prev_vowel: Optional[str] = None
    morae = lyrics_to_morae(lines)
    for j, m in enumerate(morae):
        if m.word is not None:
            if j > 0 and morae[j - 1].word == m.word:
                continue
            units.append((m.line, m.word_text, [arpabet_to_ipa(p) for p in word_phonemes(m.word_text)]))
            prev_vowel = None
        else:
            ipa = mora_to_ipa(m.text, prev_vowel)
            if ipa and ipa[-1] in "aiueo":
                prev_vowel = ipa[-1]
            units.append((m.line, m.text, ipa))
    return units


def english_ratio(lines: List[str]) -> float:
    """歌詞の音の単位(日本語はモーラ、英語は音節)のうち英語の割合。"""
    morae = lyrics_to_morae(lines)
    return sum(m.word is not None for m in morae) / len(morae) if morae else 0.0


# ---------------------------------------------------------------- モデル


def load_phoneme_model(model_path: Path):
    from safetensors import safe_open
    from safetensors.torch import load_file
    from transformers import Wav2Vec2Config, Wav2Vec2ForCTC

    with safe_open(str(model_path), framework="pt") as f:
        meta = f.metadata()
    model = Wav2Vec2ForCTC(Wav2Vec2Config(**json.loads(meta["config"])))
    model.load_state_dict({k: v.float() for k, v in load_file(str(model_path)).items()}, strict=False)
    model.eval()
    return model, json.loads(meta["vocab"])


def phoneme_log_probs(audio: np.ndarray, model_path: Path) -> Tuple[np.ndarray, dict]:
    """音素ごとのCTCのlog確率(20msフレーム)と語彙。20秒チャンクで推論して連結。"""
    import torch

    model, vocab = load_phoneme_model(model_path)
    chunk = 20 * SR
    out = []
    with torch.no_grad():
        for s in range(0, len(audio), chunk):
            x = audio[s : s + chunk]
            if len(x) < HOP * 2:
                continue
            x = (x - x.mean()) / (x.std() + 1e-7)
            logits = model(torch.from_numpy(x.astype(np.float32)).unsqueeze(0)).logits
            out.append(torch.log_softmax(logits, dim=-1)[0].numpy())
    return np.concatenate(out), vocab


# ---------------------------------------------------------------- 配置


def forced_align(log_probs: np.ndarray, tokens: np.ndarray, blank: int) -> Tuple[np.ndarray, np.ndarray]:
    """CTCのViterbi。各トークンが出る最初と最後のフレームを返す。"""
    L = len(tokens)
    S = 2 * L + 1
    lab = np.full(S, blank)
    lab[1::2] = tokens
    NEG = -1e30
    score = np.full(S, NEG)
    score[0] = log_probs[0, blank]
    if L:
        score[1] = log_probs[0, lab[1]]
    can_skip = np.zeros(S, bool)
    can_skip[3::2] = lab[3::2] != lab[1:-2:2]
    T = len(log_probs)
    back = np.zeros((T, S), np.int8)
    for t in range(1, T):
        step = np.concatenate([[NEG], score[:-1]])
        skip = np.where(can_skip, np.concatenate([[NEG, NEG], score[:-2]]), NEG)
        cand = np.stack([score, step, skip])
        b = cand.argmax(0)
        score = cand[b, np.arange(S)] + log_probs[t, lab]
        back[t] = b
    s = S - 1 if L == 0 or score[S - 1] >= score[S - 2] else S - 2
    first = np.full(L, -1)
    last = np.full(L, -1)
    for t in range(T - 1, -1, -1):
        if s % 2 == 1:
            k = s // 2
            first[k] = t
            if last[k] < 0:
                last[k] = t
        s -= back[t, s]
    return first, last


def snap_to_attacks(
    starts: np.ndarray, ends: np.ndarray, attack: np.ndarray, params: Params, line_first: Optional[np.ndarray] = None
) -> np.ndarray:
    """各単位の開始(秒)を、±SNAP_WINDOW_SEC以内で強さ×近さが最大のアタックへ寄せる。
    順序が崩れる位置(前の単位の開始・自分の終わりからMIN_UNIT_SEC以内)には寄せない。
    line_firstがTrueの単位(行の最初)は後ろへだけ寄せる(行の前の息継ぎ・伴奏の漏れ込みのアタックを拾うため)。"""
    peaks = attack_peaks(attack, params)
    idx = np.nonzero(peaks >= SNAP_MIN_STRENGTH)[0]
    times, strength = idx / 100, peaks[idx]
    out = starts.astype(np.float64).copy()
    for i, s in enumerate(starts):
        lo = (out[i - 1] if i > 0 else -np.inf) + MIN_UNIT_SEC
        if line_first is not None and line_first[i]:
            lo = max(lo, s)
        hi = ends[i] - MIN_UNIT_SEC
        near = (np.abs(times - s) <= SNAP_WINDOW_SEC) & (times >= lo) & (times <= hi)
        if not near.any():
            continue
        score = strength[near] * np.exp(-0.5 * ((times[near] - s) / SNAP_SIGMA_SEC) ** 2)
        out[i] = times[near][int(np.argmax(score))]
    return out


def _voice_end(t: int, limit: int, voiced: np.ndarray) -> int:
    """フレームtから、声が0.1秒以上途切れる所かlimitまで伸ばした終わり。"""
    gap = 0
    end = t + 1
    while end < limit:
        gap = 0 if voiced[end] else gap + 1
        if gap >= 5:
            return end - gap + 1
        end += 1
    return limit


def align(
    lyrics_lines: List[str],
    log_probs: np.ndarray,
    vocab: dict,
    f0_100fps: np.ndarray,
    attack: Optional[np.ndarray] = None,
) -> Tuple[List[AlignedLine], List[HeardSound]]:
    """attackは vowel_align.attack_strength(10ms刻み)。渡すと単位の開始をアタックへ寄せる。"""
    from lyrics_reading import auto_annotate_ruby

    units = lyrics_units(lyrics_lines)
    blank = vocab["<pad>"]
    ids, owner = [], []
    for ui, (_, _, ipa) in enumerate(units):
        for p in ipa:
            if p in vocab:
                ids.append(vocab[p])
                owner.append(ui)
    first, last = forced_align(log_probs, np.array(ids, dtype=int), blank)
    T = len(log_probs)
    n_f0 = min(len(f0_100fps) // 2, T)
    voiced = np.zeros(T, bool)
    voiced[:n_f0] = np.asarray(f0_100fps[: 2 * n_f0]).reshape(n_f0, 2).max(1) > 0

    u_first = np.full(len(units), -1)
    u_last = np.full(len(units), -1)
    u_prob = [[] for _ in units]
    for k, ui in enumerate(owner):
        if u_first[ui] < 0:
            u_first[ui] = first[k]
        u_last[ui] = last[k]
        u_prob[ui].append(float(np.exp(log_probs[first[k] : last[k] + 1, ids[k]].max())))
    # 音の無い単位(「っ」等)は直前の単位の終わりに置く
    for ui in range(len(units)):
        if u_first[ui] < 0:
            u_first[ui] = u_last[ui] = u_last[ui - 1] if ui > 0 else 0

    # 単位の開始・終わり(秒)
    u_end = np.empty(len(units))
    for li in range(len(lyrics_lines)):
        idx = [ui for ui, u in enumerate(units) if u[0] == li]
        next_line_start = next((u_first[ui] for ui in range(idx[-1] + 1, len(units))), T) if idx else T
        for n, ui in enumerate(idx):
            end = u_first[idx[n + 1]] if n + 1 < len(idx) else _voice_end(u_last[ui], next_line_start, voiced)
            u_end[ui] = max(end, u_first[ui] + 1) * FRAME_SEC
    u_start = u_first * FRAME_SEC
    if attack is not None and len(units):
        line_first = np.array([ui == 0 or units[ui][0] != units[ui - 1][0] for ui in range(len(units))])
        u_start = snap_to_attacks(u_start, u_end, attack, Params(), line_first)

    lines: List[AlignedLine] = []
    for li, text in enumerate(lyrics_lines):
        idx = [ui for ui, u in enumerate(units) if u[0] == li]
        timings: List[AlignedReadingToken] = []
        for n, ui in enumerate(idx):
            # 行の途中の単位は次の単位の開始まで続く
            end = u_start[idx[n + 1]] if n + 1 < len(idx) else u_end[ui]
            timings.append({"reading": units[ui][1], "start": float(u_start[ui]), "end": float(max(end, u_start[ui] + FRAME_SEC))})
        probs = [p for ui in idx for p in u_prob[ui]]
        prev_end = lines[-1]["end"] if lines else 0.0
        lines.append(
            {
                "text": text,
                "annotatedText": auto_annotate_ruby(text),
                "start": timings[0]["start"] if timings else prev_end,
                "end": timings[-1]["end"] if timings else prev_end,
                "confidence": float(np.mean(probs)) if probs else 0.0,
                "tokenTimings": timings,
            }
        )
    return lines, heard_phonemes(log_probs, vocab, voiced)


def heard_phonemes(log_probs: np.ndarray, vocab: dict, voiced: np.ndarray, max_frames: int = 25) -> List[HeardSound]:
    """モデルが聞き取った発音記号(最尤の列からblankを除いたもの)を区間にする。各記号は次の記号の
    出始めまで(声が途切れる所・0.5秒まで)続くとみなす。"""
    names = {i: s for s, i in vocab.items()}
    blank = vocab["<pad>"]
    best = log_probs.argmax(1)
    onsets = [t for t in range(len(best)) if best[t] != blank and (t == 0 or best[t] != best[t - 1])]
    out: List[HeardSound] = []
    for n, t in enumerate(onsets):
        nxt = onsets[n + 1] if n + 1 < len(onsets) else len(best)
        end = min(nxt, t + max_frames, _voice_end(t, nxt, voiced) if voiced[t] else t + 1)
        out.append({"start": round(t * FRAME_SEC, 3), "end": round(max(end, t + 1) * FRAME_SEC, 3), "label": names[int(best[t])]})
    return out


def align_lyrics_lines(
    lyrics_lines: List[str],
    vocals_16k_mono: np.ndarray,
    f0_100fps: np.ndarray,
    model_path: Path,
    attack: Optional[np.ndarray] = None,
    on_progress: Optional[Callable[[float], None]] = None,
) -> Tuple[List[AlignedLine], List[HeardSound]]:
    """main.pyから呼ぶ入口。(行ごとの結果, 聞き取った発音記号の区間)を返す。"""
    if not lyrics_lines:
        return [], []
    log_probs, vocab = phoneme_log_probs(vocals_16k_mono, model_path)
    if on_progress:
        on_progress(0.7)
    return align(lyrics_lines, log_probs, vocab, f0_100fps, attack)
