"""lyrics_align.pyの純粋ロジック部分のテスト。wav2vec2モデル自体(実チェックポイント)は
使わず、katakana_to_hiragana / Wav2Vec2Vocab(実際に同梱するvocab.jsonを使用)だけを
検証する(実モデルでのforced align検証は開発時に手動で実施済み)。
"""

import unittest

from lyrics_align import Wav2Vec2Vocab, katakana_to_hiragana, text_to_hiragana_reading


class KatakanaToHiraganaTest(unittest.TestCase):
    def test_basic_conversion(self):
        self.assertEqual(katakana_to_hiragana("キョウ"), "きょう")

    def test_choonpu_is_kept_as_is(self):
        # 長音記号「ー」は変換対象外(ひらがなに対応する文字が無いため)
        self.assertEqual(katakana_to_hiragana("キョー"), "きょー")

    def test_non_katakana_is_unaffected(self):
        self.assertEqual(katakana_to_hiragana("今日、Hello"), "今日、Hello")

    def test_empty_string(self):
        self.assertEqual(katakana_to_hiragana(""), "")


class Wav2Vec2VocabTest(unittest.TestCase):
    def setUp(self):
        self.vocab = Wav2Vec2Vocab()

    def test_known_single_char_round_trips(self):
        ids = self.vocab.encode("の")
        self.assertEqual(len(ids), 1)
        self.assertEqual(self.vocab.decode_single(ids[0]), "の")

    def test_greedy_longest_match_prefers_multi_char_token(self):
        # "って"はvocabに複数文字トークンとして存在する(README調査で確認済み)ため、
        # "っ"+"て"の2トークンではなく1トークンになるはず
        ids = self.vocab.encode("って")
        self.assertEqual(len(ids), 1)
        self.assertEqual(self.vocab.decode_single(ids[0]), "って")

    def test_unknown_character_falls_back_to_unk(self):
        ids = self.vocab.encode("🎵")
        self.assertEqual([self.vocab.decode_single(i) for i in ids], ["<unk>"])

    def test_empty_string_produces_no_tokens(self):
        self.assertEqual(self.vocab.encode(""), [])

    def test_vocab_size_matches_model_output_dim(self):
        # lm_head.bias([3003])に対し、vocab.jsonの3000 + 特殊トークン3個(<s></s><pad>)分の
        # 余地がある。ここではvocab.json自体の件数だけ検証する。
        self.assertEqual(len(self.vocab.token_to_id), 3000)


class TextToHiraganaReadingTest(unittest.TestCase):
    def test_explicit_ruby_bracket_notation_is_preferred_over_g2p(self):
        # 「河野」は通常こうの/かわの等いずれにも読めるが、括弧記法のルビを明示すれば
        # pyopenjtalkの推定に関わらずそちらがそのまま採用される
        self.assertEqual(text_to_hiragana_reading("河野(かわの)さん"), "かわのさん")

    def test_explicit_ruby_aozora_notation_is_preferred(self):
        # 助詞「は」はpyopenjtalk側の推定で正しく「わ」になる(ルビ指定は「今日」の部分のみ)
        self.assertEqual(text_to_hiragana_reading("｜今日《きょう》は晴れ"), "きょうわはれ")

    def test_no_ruby_falls_back_to_pyopenjtalk(self):
        # ルビ無しの「今日」はpyopenjtalkの推定に委ねられ、長音表記の「きょー」になる
        # (「｜今日《きょう》」のように明示ルビを与えれば「きょう」表記を強制できる)
        self.assertEqual(text_to_hiragana_reading("今日は晴れ"), "きょーわはれ")


if __name__ == "__main__":
    unittest.main()
