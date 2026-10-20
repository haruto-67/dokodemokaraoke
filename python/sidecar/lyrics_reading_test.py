"""lyrics_reading.pyのテスト。読み変換・自動ルビ・語彙は純粋ロジックとして検証する。
wav2vec2モデルの読み込みだけは、実際に本番で起きたバグの回帰テストとして実モデル
(resources/models/)を使う(モデル未取得の環境ではskipする)。
"""

import unittest
from pathlib import Path

from lyrics_reading import (
    Wav2Vec2Vocab,
    auto_annotate_ruby,
    katakana_to_hiragana,
    load_wav2vec2_model,
    subword_to_reading,
    text_to_hiragana_reading,
)

_REPO_ROOT = Path(__file__).resolve().parents[2]
_WAV2VEC2_MODEL_PATH = _REPO_ROOT / "resources" / "models" / "japanese-wav2vec2-base-rs35kh.safetensors"


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


class AutoAnnotateRubyTest(unittest.TestCase):
    def test_adds_ruby_to_kanji_words_and_preserves_kana(self):
        self.assertEqual(auto_annotate_ruby("今日は晴れ"), "｜今日《きょう》は｜晴《は》れ")

    def test_explicit_ruby_is_preserved_instead_of_reestimated(self):
        self.assertEqual(auto_annotate_ruby("今日(こんにち)は"), "｜今日《こんにち》は")

    def test_spaces_are_not_dropped(self):
        self.assertEqual(auto_annotate_ruby("今日 は晴れ"), "｜今日《きょう》 は｜晴《は》れ")

    def test_trailing_okurigana_is_not_included_in_ruby(self):
        # 「捨て(すて)」のように送り仮名にまでルビが振られる問題の回帰テスト
        self.assertEqual(auto_annotate_ruby("捨てる"), "｜捨《す》てる")

    def test_kanji_only_word_keeps_full_reading_as_ruby(self):
        # 送り仮名が無い(全て漢字の)場合は従来通り単語全体にルビを付ける
        self.assertEqual(auto_annotate_ruby("季節"), "｜季節《きせつ》")


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


@unittest.skipUnless(_WAV2VEC2_MODEL_PATH.exists(), "wav2vec2モデル未取得のためskip(npm run build:modelsで取得)")
class Wav2Vec2ConfigRegressionTest(unittest.TestCase):
    """実機で発生したバグの回帰テスト(2026-09-21): `load_wav2vec2_model()`が`vocab_size`以外
    HuggingFaceのdataclass既定値(`do_stable_layer_norm=False`)のままWav2Vec2Configを構築して
    いたため、state_dictのkey名・shapeは完全一致してload_state_dict自体は例外無く成功するに
    もかかわらず、実際の計算経路(各transformer層内でのLayerNorm適用位置)が学習時と食い違い、
    出力がほぼ入力に依存しない退化した確率分布(常に`<unk>`支配的)に収束していた。これが
    「歌詞アライメントが曲冒頭のごく短い区間に全行圧縮される」不具合の真因だった。
    reazon-research/japanese-wav2vec2-base-rs35kh の実config.jsonを取得して
    `do_stable_layer_norm=true`と判明し、修正した。
    """

    def test_config_matches_real_checkpoint(self):
        model = load_wav2vec2_model(_WAV2VEC2_MODEL_PATH)
        self.assertTrue(model.config.do_stable_layer_norm)
        self.assertEqual(model.config.pad_token_id, 0)


class SubwordToReadingTest(unittest.TestCase):
    def test_caches_and_returns_reading(self):
        cache: dict[str, str] = {}
        reading = subword_to_reading("季節", cache)
        self.assertEqual(reading, "きせつ")
        self.assertEqual(cache["季節"], "きせつ")

    def test_strips_sentencepiece_word_boundary_marker(self):
        cache: dict[str, str] = {}
        reading = subword_to_reading("▁これは", cache)
        self.assertEqual(reading, text_to_hiragana_reading("これは"))

    def test_unk_token_yields_empty_reading(self):
        cache: dict[str, str] = {}
        self.assertEqual(subword_to_reading("<unk>", cache), "")


if __name__ == "__main__":
    unittest.main()
