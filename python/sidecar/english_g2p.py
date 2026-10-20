"""英単語の発音(ARPAbetの音素列)と音節。歌詞の英語の部分のタイミング付けに使う。

- CMU発音辞書(data/cmudict.dict、BSD系ライセンス: data/cmudict.LICENSE)を引く
- 辞書に無い単語(造語・固有名詞)は、g2p_en(Kyubyong Park & Jongseok Kim、Apache-2.0:
  data/g2p_en.LICENSE)の学習済みの推定モデル(data/g2p_en_checkpoint20.npz)で発音を推定する。
  g2p_enのパッケージは初回にnltkのデータをネットから取りに行くため使わず、推定部分(GRUの
  エンコーダ・デコーダ)だけをここへ移した。品詞による読み分け(read の過去形など)はしない
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Dict, List, Tuple

import numpy as np

DATA_DIR = Path(__file__).resolve().parent / "data"

# 英語の歌詞の単語(アポストロフィで続く Let's / I’m 等も1語)
WORD_RE = re.compile(r"[A-Za-z]+(?:['’][A-Za-z]+)*")

VOWELS = {"AA", "AE", "AH", "AO", "AW", "AY", "EH", "ER", "EY", "IH", "IY", "OW", "OY", "UH", "UW"}
UNVOICED = {"P", "T", "K", "F", "S", "SH", "TH", "HH", "CH"}
NASALS = {"M", "N", "NG"}
# 2子音以上の連続のうち、音節の頭に来られるもの(これ以外は前の音節の終わりへ分ける)
_ONSET2 = {
    ("P", "R"), ("P", "L"), ("B", "R"), ("B", "L"), ("T", "R"), ("D", "R"), ("K", "R"), ("K", "L"),
    ("G", "R"), ("G", "L"), ("F", "R"), ("F", "L"), ("TH", "R"), ("SH", "R"), ("S", "P"), ("S", "T"),
    ("S", "K"), ("S", "M"), ("S", "N"), ("S", "L"), ("S", "W"), ("T", "W"), ("D", "W"), ("K", "W"),
    ("P", "Y"), ("B", "Y"), ("F", "Y"), ("K", "Y"), ("M", "Y"), ("HH", "Y"), ("V", "Y"),
}
_ONSET3 = {("S", "P", "R"), ("S", "T", "R"), ("S", "K", "R"), ("S", "P", "L"), ("S", "K", "W")}


@dataclass
class Syllable:
    onset: Tuple[str, ...]
    nucleus: str  # 強勢の数字を除いた母音(AY 等)
    coda: Tuple[str, ...]

    @property
    def text(self) -> str:
        return " ".join(self.onset + (self.nucleus,) + self.coda)


@lru_cache(maxsize=1)
def _cmudict() -> Dict[str, List[str]]:
    d: Dict[str, List[str]] = {}
    with (DATA_DIR / "cmudict.dict").open(encoding="utf-8") as f:
        for line in f:
            line = line.split("#", 1)[0].strip()
            if not line:
                continue
            word, *phones = line.split()
            if "(" in word:  # 2つ目以降の発音は使わない
                continue
            d[word] = phones
    return d


class _NeuralG2p:
    """g2p_en の推定モデル(文字→音素のGRU seq2seq)。"""

    GRAPHEMES = ["<pad>", "<unk>", "</s>"] + list("abcdefghijklmnopqrstuvwxyz")
    PHONEMES = ["<pad>", "<unk>", "<s>", "</s>"] + [
        "AA0", "AA1", "AA2", "AE0", "AE1", "AE2", "AH0", "AH1", "AH2", "AO0", "AO1", "AO2", "AW0", "AW1", "AW2",
        "AY0", "AY1", "AY2", "B", "CH", "D", "DH", "EH0", "EH1", "EH2", "ER0", "ER1", "ER2", "EY0", "EY1", "EY2",
        "F", "G", "HH", "IH0", "IH1", "IH2", "IY0", "IY1", "IY2", "JH", "K", "L", "M", "N", "NG", "OW0", "OW1",
        "OW2", "OY0", "OY1", "OY2", "P", "R", "S", "SH", "T", "TH", "UH0", "UH1", "UH2", "UW", "UW0", "UW1",
        "UW2", "V", "W", "Y", "Z", "ZH",
    ]  # fmt: skip

    def __init__(self) -> None:
        self.v = dict(np.load(DATA_DIR / "g2p_en_checkpoint20.npz"))
        self.g2idx = {g: i for i, g in enumerate(self.GRAPHEMES)}

    @staticmethod
    def _gru_cell(x, h, w_ih, w_hh, b_ih, b_hh):
        rzn_ih = x @ w_ih.T + b_ih
        rzn_hh = h @ w_hh.T + b_hh
        k = rzn_ih.shape[-1] * 2 // 3
        rz = 1 / (1 + np.exp(-(rzn_ih[:, :k] + rzn_hh[:, :k])))
        r, z = np.split(rz, 2, -1)
        n = np.tanh(rzn_ih[:, k:] + r * rzn_hh[:, k:])
        return (1 - z) * n + z * h

    def predict(self, word: str) -> List[str]:
        v = self.v
        h = np.zeros((1, v["enc_w_hh"].shape[1]), np.float32)
        for ch in list(word) + ["</s>"]:
            x = v["enc_emb"][[self.g2idx.get(ch, 1)]]
            h = self._gru_cell(x, h, v["enc_w_ih"], v["enc_w_hh"], v["enc_b_ih"], v["enc_b_hh"])
        dec = v["dec_emb"][[2]]  # <s>
        out: List[str] = []
        for _ in range(20):
            h = self._gru_cell(dec, h, v["dec_w_ih"], v["dec_w_hh"], v["dec_b_ih"], v["dec_b_hh"])
            pred = int((h @ v["fc_w"].T + v["fc_b"]).argmax())
            if pred == 3:  # </s>
                break
            out.append(self.PHONEMES[pred])
            dec = v["dec_emb"][[pred]]
        return out


@lru_cache(maxsize=1)
def _neural() -> _NeuralG2p:
    return _NeuralG2p()


def word_phonemes(word: str) -> List[str]:
    """英単語1語の音素列(強勢の数字付きARPAbet)。"""
    w = word.lower().replace("’", "'")
    d = _cmudict()
    if w in d:
        return d[w]
    plain = re.sub("[^a-z]", "", w)
    if plain in d:
        return d[plain]
    return _neural().predict(plain) if plain else []


def syllabify(phones: List[str]) -> List[Syllable]:
    """音素列を音節(頭子音・母音・末子音)に分ける。母音の間の子音は、音節の頭に来られる
    最長の連続を次の音節へ、残りを前の音節の終わりへ割り当てる。"""
    base = [re.sub(r"\d", "", p) for p in phones]
    nuclei = [i for i, p in enumerate(base) if p in VOWELS]
    if not nuclei:
        return []
    sylls: List[Syllable] = []
    onset_start = 0
    for k, ni in enumerate(nuclei):
        onset = tuple(base[onset_start:ni])
        if k + 1 < len(nuclei):
            between = base[ni + 1 : nuclei[k + 1]]
            n_onset = 0
            for n in range(min(3, len(between)), 0, -1):
                tail = tuple(between[len(between) - n :])
                if n == 1 or (n == 2 and tail in _ONSET2) or (n == 3 and tail in _ONSET3):
                    n_onset = n
                    break
            coda = tuple(between[: len(between) - n_onset])
            onset_start = ni + 1 + len(coda)
        else:
            coda = tuple(base[ni + 1 :])
        sylls.append(Syllable(onset, base[ni], coda))
    return sylls


def word_syllables(word: str) -> List[Syllable]:
    return syllabify(word_phonemes(word))
