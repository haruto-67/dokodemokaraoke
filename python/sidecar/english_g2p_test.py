"""english_g2p.pyのテスト(同梱の辞書と推定モデルを使う)。"""

import unittest

from english_g2p import WORD_RE, syllabify, word_phonemes, word_syllables


class WordPhonemesTest(unittest.TestCase):
    def test_dictionary_words_and_apostrophes(self):
        self.assertEqual(word_phonemes("Fading"), ["F", "EY1", "D", "IH0", "NG"])
        self.assertEqual(word_phonemes("I’m"), ["AY1", "M"])

    def test_unknown_word_is_predicted(self):
        phones = word_phonemes("dokokara")
        self.assertGreater(len(phones), 4)
        self.assertEqual(phones[0], "D")


class SyllabifyTest(unittest.TestCase):
    def test_consonants_between_vowels_go_to_the_longest_legal_onset(self):
        self.assertEqual([s.text for s in word_syllables("protagonist")], ["P R OW", "T AE", "G AH", "N AH S T"])
        self.assertEqual([s.text for s in syllabify(["EH1", "K", "S", "T", "R", "AH0"])], ["EH K", "S T R AH"])

    def test_word_without_vowel_has_no_syllable(self):
        self.assertEqual(syllabify(["S", "T"]), [])


class WordReTest(unittest.TestCase):
    def test_words_with_apostrophes(self):
        self.assertEqual(WORD_RE.findall("(Let's go) I’m 愛 baby"), ["Let's", "go", "I’m", "baby"])


if __name__ == "__main__":
    unittest.main()
