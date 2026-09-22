"""lyrics_align.pyの純粋ロジック部分のテスト。wav2vec2モデル自体(実チェックポイント)は
使わず、katakana_to_hiragana / Wav2Vec2Vocab(実際に同梱するvocab.jsonを使用)だけを
検証する。ただしCTC blank ID回りは実際に本番で例外が発生したバグがあったため、
AlignTokensToAudioBlankIdRegressionTestだけは実モデル(resources/models/)を使って検証する
(モデル未取得の環境ではskipする)。
"""

import unittest
from pathlib import Path

import numpy as np

from lyrics_align import (
    _build_aligned_reading_tokens,
    auto_annotate_ruby,
    Wav2Vec2Vocab,
    _load_wav2vec2_model,
    align_tokens_to_audio,
    katakana_to_hiragana,
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


class AlignedReadingTokensTest(unittest.TestCase):
    def test_builds_boundaries_from_neighboring_ctc_centers(self):
        class FakeVocab:
            def decode_single(self, token_id):
                return {1: "きょう", 2: "は", 3: "はれ"}[token_id]

        result = _build_aligned_reading_tokens(
            [1, 2, 3], np.array([1.5, 2.5, 4.5]), 1.0, 6.0, FakeVocab()
        )
        self.assertEqual(result[0], {"reading": "きょう", "start": 1.0, "end": 2.0})
        self.assertEqual(result[1], {"reading": "は", "start": 2.0, "end": 3.5})
        self.assertEqual(result[2], {"reading": "はれ", "start": 3.5, "end": 6.0})

    def test_clamps_non_monotonic_centers(self):
        class FakeVocab:
            def decode_single(self, token_id):
                return str(token_id)

        result = _build_aligned_reading_tokens(
            [1, 2], np.array([4.0, 2.0]), 1.0, 5.0, FakeVocab()
        )
        self.assertLessEqual(result[0]["end"], result[1]["start"])


class AutoAnnotateRubyTest(unittest.TestCase):
    def test_adds_ruby_to_kanji_words_and_preserves_kana(self):
        self.assertEqual(auto_annotate_ruby("今日は晴れ"), "｜今日《きょう》は｜晴れ《はれ》")

    def test_explicit_ruby_is_preserved_instead_of_reestimated(self):
        self.assertEqual(auto_annotate_ruby("今日(こんにち)は"), "｜今日《こんにち》は")

    def test_spaces_are_not_dropped(self):
        self.assertEqual(auto_annotate_ruby("今日 は晴れ"), "｜今日《きょう》 は｜晴れ《はれ》")


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
class AlignTokensToAudioBlankIdRegressionTest(unittest.TestCase):
    """実機で発生したバグの回帰テスト: CTCのblank IDをmodel.config.pad_token_id(常に0、
    _load_wav2vec2_model()がvocab_sizeだけでConfigを再構築するため実値を反映しない)から
    取っていたため、vocab.json上のid 0("<unk>"、通常の文字として頻出しうる)がtargetsに
    含まれるたびにtorchaudio.functional.forced_alignが
    `targets Tensor shouldn't contain blank index`で例外を投げていた。
    blank_idをmodel.config.vocab_size-1に変更して解消したことを検証する。
    """

    def test_does_not_raise_when_target_contains_unk_token(self):
        vocab = Wav2Vec2Vocab()
        # "X"はvocabに無いため<unk>(id 0)にフォールバックする。これが本番で起きた状況の再現。
        text = "きょうはXいいてんきですね"
        target_ids = vocab.encode(text)
        self.assertIn(0, target_ids, "このテスト自体がunk(id 0)を含む状況を再現できていない")

        audio = (np.random.default_rng(0).standard_normal(16000 * 3) * 0.01).astype(np.float32)
        tokens, confidence = align_tokens_to_audio(text, audio, _WAV2VEC2_MODEL_PATH, vocab=vocab)

        self.assertGreater(len(tokens), 0)
        self.assertGreaterEqual(confidence, 0.0)


@unittest.skipUnless(_WAV2VEC2_MODEL_PATH.exists(), "wav2vec2モデル未取得のためskip(npm run build:modelsで取得)")
class AlignTokensToAudioCtcTooLongRegressionTest(unittest.TestCase):
    """実機で発生したバグの回帰テスト: VAD検出区間(音声)が短すぎるのに対応する歌詞行が
    長い場合、CTCの制約(targets長 + 連続重複ラベル数 <= フレーム数)を満たせず
    torchaudio.functional.forced_alignが`targets length is too long for CTC`で例外を投げ、
    main.py側でこれをそのままエラー扱いにしていたため、この1行のミスマッチだけで解析全体
    (分離・F0・ノート化等、それまでの数分〜十数分の処理結果)が失われていた。
    align_tokens_to_audio側でCTCの最小フレーム数を満たせるか事前チェックし、
    満たせない場合は例外を投げず空の結果を返すことを検証する。
    """

    def test_returns_empty_result_instead_of_raising_when_audio_too_short_for_text(self):
        vocab = Wav2Vec2Vocab()
        # 十分に長い歌詞行(64文字相当を狙う)に対し、極端に短い音声(0.3秒)を渡す。
        long_text = "きょうはとてもいいてんきですね" * 4
        target_ids = vocab.encode(long_text)
        self.assertGreater(len(target_ids), 30, "このテスト自体が十分に長いtargetsを再現できていない")

        short_audio = (np.random.default_rng(1).standard_normal(int(16000 * 0.3)) * 0.01).astype(np.float32)

        tokens, confidence = align_tokens_to_audio(long_text, short_audio, _WAV2VEC2_MODEL_PATH, vocab=vocab)

        self.assertEqual(tokens, [])
        self.assertEqual(confidence, 0.0)


@unittest.skipUnless(_WAV2VEC2_MODEL_PATH.exists(), "wav2vec2モデル未取得のためskip(npm run build:modelsで取得)")
class Wav2Vec2ConfigRegressionTest(unittest.TestCase):
    """実機で発生したバグの回帰テスト(2026-09-21): `_load_wav2vec2_model()`が`vocab_size`以外
    HuggingFaceのdataclass既定値(`do_stable_layer_norm=False`)のままWav2Vec2Configを構築して
    いたため、state_dictのkey名・shapeは完全一致してload_state_dict自体は例外無く成功するに
    もかかわらず、実際の計算経路(各transformer層内でのLayerNorm適用位置)が学習時と食い違い、
    出力がほぼ入力に依存しない退化した確率分布(常に`<unk>`支配的)に収束していた。これが
    「歌詞アライメントが曲冒頭のごく短い区間に全行圧縮される」不具合の真因だった。
    reazon-research/japanese-wav2vec2-base-rs35kh の実config.jsonを取得して
    `do_stable_layer_norm=true`と判明し、修正した。
    """

    def test_config_matches_real_checkpoint(self):
        model = _load_wav2vec2_model(_WAV2VEC2_MODEL_PATH)
        self.assertTrue(model.config.do_stable_layer_norm)
        self.assertEqual(model.config.pad_token_id, 0)


if __name__ == "__main__":
    unittest.main()
