"""vowel_align.pyの純粋ロジック部分のテスト(モデル・音声は使わない)。
曲全体での精度は python/experiments/ の正解データとの比較で確かめる。
"""

import unittest

import numpy as np

from vowel_align import (
    CLASSES,
    FRAME_SEC,
    Alignment,
    Params,
    _mora_times,
    attack_cue,
    attack_marks,
    heard_sounds,
    lyrics_to_morae,
    pitch_glides,
    split_morae,
    starts_at_vowel,
    to_aligned_lines,
    viterbi,
)


def _onehot(labels):
    """母音クラス名の列から、そのクラスの確率が高いフレーム列を作る。"""
    p = np.full((len(labels), len(CLASSES)), 0.02)
    for t, lab in enumerate(labels):
        p[t, CLASSES.index(lab)] = 0.9
    return p / p.sum(1, keepdims=True)


class SplitMoraeTest(unittest.TestCase):
    def test_small_kana_joins_previous_and_n_q_long_are_separate(self):
        self.assertEqual(split_morae("きょうっとーん"), ["きょ", "う", "っ", "と", "ー", "ん"])

    def test_symbols_and_spaces_are_dropped(self):
        self.assertEqual(split_morae("あ い、う"), ["あ", "い", "う"])


class LyricsToMoraeTest(unittest.TestCase):
    def test_kinds_and_vowels(self):
        morae = lyrics_to_morae(["さくらん", "ばっ"])
        self.assertEqual([m.text for m in morae], ["さ", "く", "ら", "ん", "ば", "っ"])
        self.assertEqual([m.kind for m in morae], ["V", "V", "V", "N", "V", "Q"])
        self.assertEqual(morae[0].vowels, ("a",))
        self.assertEqual([m.line for m in morae], [0, 0, 0, 0, 1, 1])

    def test_ou_and_ei_accept_both_vowels(self):
        # 「おう」「えい」は歌では伸ばすことが多いため、2モーラ目はどちらの母音でも一致とみなす
        # (かなのままだとpyopenjtalkが「こー」と読むため、ルビで読みを固定する)
        morae = lyrics_to_morae(["｜項《こう》", "｜性《せい》"])
        self.assertEqual(morae[1].vowels, ("u", "o"))
        self.assertEqual(morae[3].vowels, ("i", "e"))


class ViterbiTest(unittest.TestCase):
    def test_places_morae_on_matching_vowels_in_order(self):
        # 無音 0.2秒 → a 0.3秒 → i 0.3秒 → 無音 0.2秒
        labels = ["a"] * 10 + ["a"] * 15 + ["i"] * 15 + ["a"] * 10
        vowel_p = _onehot(labels)
        sil = np.array([0.98] * 10 + [0.02] * 30 + [0.98] * 10)
        zeros = np.zeros(len(sil))
        morae = lyrics_to_morae(["あい"])
        segs, _ = viterbi(morae, vowel_p, sil, zeros, zeros, Params())
        self.assertEqual(segs[0][0], 10)  # 「あ」は声の出始めから
        self.assertEqual(segs[1][0], 25)  # 「い」は i に変わった所から
        self.assertEqual(segs[1][2], 40)  # 声が止まる所で終わる

    def test_voice_before_first_line_is_not_absorbed_by_first_mora(self):
        # 曲頭に歌詞でない短い声があっても、1行目の最初のモーラをそこへ飛ばさない
        labels = ["a"] * 8 + ["a"] * 200 + ["a"] * 15 + ["i"] * 15 + ["a"] * 10
        vowel_p = _onehot(labels)
        sil = np.array([0.02] * 8 + [0.98] * 200 + [0.02] * 30 + [0.98] * 10)
        zeros = np.zeros(len(sil))
        segs, _ = viterbi(lyrics_to_morae(["あい"]), vowel_p, sil, zeros, zeros, Params())
        self.assertEqual(segs[0][0], 208)


    def test_same_vowels_are_split_at_the_attack(self):
        # 「ああ」を a が続く0.6秒に置く。母音だけでは区切りが決まらないため、アタックの所で区切る
        labels = ["a"] * 10 + ["a"] * 30 + ["a"] * 10
        sil = np.array([0.98] * 10 + [0.02] * 30 + [0.98] * 10)
        attack = np.zeros(len(sil))
        attack[32] = 1.0
        params = Params()
        segs, _ = viterbi(
            lyrics_to_morae(["ああ"]), _onehot(labels), sil, params.attack_bonus * attack, params.attack_hold * attack, params
        )
        self.assertEqual(segs[1][0], 32)


class AttackCueTest(unittest.TestCase):
    def test_strong_peaks_are_shifted_and_weak_ones_dropped(self):
        attack = np.zeros(2000)  # 10ms刻み
        attack[50:1800:60] = 1.0  # 0.6秒ごとの強いアタック(曲の上位1%)
        attack[1820] = 0.1  # 上位1%を1とした強さで attack_min 未満
        params = Params(attack_shift_sec=0.02)
        cue = attack_cue(attack, 1000, params)
        self.assertEqual(int(cue[:50].argmax()), 26)  # 0.5秒+0.02秒 → 20msフレームの26
        self.assertAlmostEqual(cue[26], 1.0)
        self.assertLess(cue[905:915].max(), 1e-9)

    def test_marks_list_shifted_peaks_with_strength(self):
        attack = np.zeros(2000)
        attack[50:1800:60] = 1.0
        attack[1820] = 0.1
        marks = attack_marks(attack, Params(attack_shift_sec=0.02))
        self.assertEqual(len(marks), 30)  # 弱いピークは含めない
        self.assertEqual(marks[0], {"time": 0.52, "strength": 1.0})


class PitchGlidesTest(unittest.TestCase):
    @staticmethod
    def _hz(semitones):
        return 440 * 2 ** ((np.asarray(semitones, dtype=float) - 69) / 12)

    def test_arrival_of_a_jump_is_where_the_new_pitch_is_reached(self):
        # 52半音を0.3秒 → 0.1秒かけて59半音へ上がる → 59半音を0.3秒
        st = np.concatenate([np.full(30, 52.0), np.linspace(52, 59, 11)[1:], np.full(30, 59.0)])
        glides = pitch_glides(self._hz(st), Params())
        self.assertEqual(len(glides), 1)
        begin, arrive, step = glides[0]
        self.assertAlmostEqual(step, 7.0, delta=0.3)
        self.assertLessEqual(abs(begin - 30), 2)
        self.assertLessEqual(abs(arrive - 40), 2)

    def test_vibrato_is_not_a_jump(self):
        t = np.arange(100) / 100
        st = 60 + 0.4 * np.sin(2 * np.pi * 6 * t)  # 6Hz・±0.4半音
        self.assertEqual(pitch_glides(self._hz(st), Params()), [])


class StartsAtVowelTest(unittest.TestCase):
    def test_consonant_morae_start_at_the_vowel(self):
        morae = lyrics_to_morae(["はなあ"])
        self.assertEqual([starts_at_vowel(m) for m in morae], [True, True, False])


class MoraTimesTest(unittest.TestCase):
    def test_skipped_mora_shares_the_second_half_of_the_previous_one(self):
        morae = lyrics_to_morae(["かん"])
        starts, ends = _mora_times(morae, [(0, 2, 10), None])
        self.assertAlmostEqual(starts[1], 5 * FRAME_SEC)
        self.assertAlmostEqual(ends[0], 5 * FRAME_SEC)
        self.assertAlmostEqual(ends[1], 10 * FRAME_SEC)


class ToAlignedLinesTest(unittest.TestCase):
    def test_lines_carry_mora_timings_and_confidence(self):
        lines = ["あい", "う"]
        morae = lyrics_to_morae(lines)
        vowel_p = _onehot(["a"] * 10 + ["i"] * 10 + ["u"] * 10)
        result = Alignment(morae, [(0, 0, 10), (10, 10, 20), (20, 20, 30)], vowel_p, np.zeros(30), [])
        out = to_aligned_lines(lines, result)
        self.assertEqual([t["reading"] for t in out[0]["tokenTimings"]], ["あ", "い"])
        self.assertAlmostEqual(out[0]["start"], 0.0)
        self.assertAlmostEqual(out[0]["end"], 20 * FRAME_SEC)
        self.assertAlmostEqual(out[1]["start"], 20 * FRAME_SEC)
        self.assertGreater(out[0]["confidence"], 0.8)


class HeardSoundsTest(unittest.TestCase):
    def test_runs_are_merged_and_silence_is_dropped(self):
        vowel_p = _onehot(["a"] * 10 + ["i"] + ["a"] * 9 + ["o"] * 10)
        # 最後の10フレームのうち5つは無声(F0なし・音量あり)、残りは無音
        sil = np.array([0.02] * 25 + [0.5] * 5 + [0.98] * 0)
        out = heard_sounds(vowel_p[:30], sil)
        self.assertEqual([h["label"] for h in out], ["a", "o", "unvoiced"])
        self.assertAlmostEqual(out[0]["end"], 20 * FRAME_SEC)  # 1フレームだけの i は a にまとめる

    def test_silence_is_not_returned(self):
        out = heard_sounds(_onehot(["a"] * 10), np.array([0.98] * 10))
        self.assertEqual(out, [])


if __name__ == "__main__":
    unittest.main()
