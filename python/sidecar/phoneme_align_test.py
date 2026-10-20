"""phoneme_align.pyの純粋ロジック部分のテスト(モデルは使わない)。"""

import json
import unittest
from pathlib import Path

import numpy as np

import phoneme_align
from phoneme_align import english_ratio, forced_align, heard_phonemes, lyrics_units, mora_to_ipa, snap_to_attacks
from vowel_align import Params


class LyricsUnitsTest(unittest.TestCase):
    def test_english_words_and_japanese_morae(self):
        units = lyrics_units(["Let's go", "しゃっきー"])
        self.assertEqual([(u[0], u[1]) for u in units], [(0, "Let's"), (0, "go"), (1, "しゃ"), (1, "っ"), (1, "き"), (1, "ー")])
        self.assertEqual(units[0][2], ["l", "ɛ", "t", "s"])
        self.assertEqual(units[2][2], ["ɕ", "a"])
        self.assertEqual(units[3][2], [])  # 「っ」は音が無い
        self.assertEqual(units[5][2], ["i"])  # 「ー」は直前の母音

    def test_kana(self):
        self.assertEqual(mora_to_ipa("きゃ", None), ["k", "j", "a"])
        self.assertEqual(mora_to_ipa("つ", None), ["ts", "u"])
        self.assertEqual(mora_to_ipa("ん", None), ["ɴ"])

    def test_english_ratio(self):
        self.assertEqual(english_ratio(["hello world"]), 1.0)
        self.assertLess(english_ratio(["さくらが咲いた baby"]), 0.5)


class ForcedAlignTest(unittest.TestCase):
    def test_tokens_are_placed_where_they_are_heard(self):
        # 語彙: 0=blank, 1=a, 2=b。blank×3, a×2, blank×2, b×3, blank×2
        frames = [0, 0, 0, 1, 1, 0, 0, 2, 2, 2, 0, 0]
        lp = np.full((len(frames), 3), np.log(0.05))
        for t, k in enumerate(frames):
            lp[t, k] = np.log(0.9)
        first, last = forced_align(lp, np.array([1, 2]), 0)
        self.assertEqual(first.tolist(), [3, 7])
        self.assertEqual(last.tolist(), [4, 9])

    def test_repeated_token_needs_a_blank_between(self):
        frames = [1, 1, 0, 1, 0]
        lp = np.full((len(frames), 2), np.log(0.1))
        for t, k in enumerate(frames):
            lp[t, k] = np.log(0.9)
        first, _ = forced_align(lp, np.array([1, 1]), 0)
        self.assertEqual(first.tolist(), [0, 3])


class HeardPhonemesTest(unittest.TestCase):
    def test_each_symbol_lasts_until_the_next(self):
        vocab = {"<pad>": 0, "a": 1, "b": 2}
        frames = [0, 1, 0, 0, 2, 0]
        lp = np.full((len(frames), 3), np.log(0.05))
        for t, k in enumerate(frames):
            lp[t, k] = np.log(0.9)
        out = heard_phonemes(lp, vocab, np.ones(len(frames), bool))
        self.assertEqual([h["label"] for h in out], ["a", "b"])
        self.assertAlmostEqual(out[0]["start"], 0.02)
        self.assertAlmostEqual(out[0]["end"], 0.08)


class SnapToAttacksTest(unittest.TestCase):
    def test_starts_move_to_nearby_strong_attacks_in_order(self):
        attack = np.zeros(300)  # 10ms刻み
        attack[[95, 165, 250]] = 1.0  # ずらし(20ms)後は0.97・1.67・2.52秒
        starts = np.array([1.0, 1.5, 1.6, 2.3])
        ends = np.array([1.5, 1.6, 2.3, 2.8])
        out = snap_to_attacks(starts, ends, attack, Params(attack_shift_sec=0.02))
        # 1.0→0.97。1.5は0.1秒以内に無いのでそのまま。1.6→1.67。2.3は2.52が0.1秒より遠いのでそのまま
        self.assertEqual([round(x, 2) for x in out], [0.97, 1.5, 1.67, 2.3])

    def test_does_not_move_before_the_previous_start(self):
        attack = np.zeros(300)
        attack[100] = 1.0
        out = snap_to_attacks(np.array([1.0, 1.06]), np.array([1.06, 1.5]), attack, Params(attack_shift_sec=0.0))
        self.assertEqual([round(x, 2) for x in out], [1.0, 1.06])

    def test_line_first_unit_only_moves_later(self):
        attack = np.zeros(300)
        attack[[95, 205]] = 1.0  # 0.95秒(行の前)・2.05秒
        out = snap_to_attacks(
            np.array([1.0, 2.0]), np.array([1.5, 2.5]), attack, Params(attack_shift_sec=0.0), np.array([True, True])
        )
        self.assertEqual([round(x, 2) for x in out], [1.0, 2.05])


class ModelManifestTest(unittest.TestCase):
    def test_download_info_matches_models_json(self):
        manifest = Path(__file__).resolve().parents[1] / "models.json"
        entry = next(m for m in json.loads(manifest.read_text())["models"] if m["filename"] == phoneme_align.MODEL_FILENAME)
        self.assertEqual(entry["url"], phoneme_align.MODEL_URL)
        self.assertEqual(entry["sha256"], phoneme_align.MODEL_SHA256)
        self.assertEqual(entry["size"], phoneme_align.MODEL_SIZE)


if __name__ == "__main__":
    unittest.main()
