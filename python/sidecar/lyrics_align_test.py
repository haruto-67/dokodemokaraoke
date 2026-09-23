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
    _build_reading_tokens_from_chars,
    _greedy_decode_chars,
    _insert_note_subanchors,
    _sequence_align_reading_to_hypothesis,
    _subword_to_reading,
    auto_annotate_ruby,
    Wav2Vec2Vocab,
    _load_wav2vec2_model,
    align_lyrics_lines_via_free_decode,
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

    def test_snaps_boundary_to_nearby_note_start(self):
        class FakeVocab:
            def decode_single(self, token_id):
                return {1: "きょう", 2: "は", 3: "はれ"}[token_id]

        # 中間点だけの境界は2.0だが、0.08秒先にノート開始があるのでそちらへ吸い寄せられる
        notes = [{"start": 2.08, "end": 3.0, "pitchMidi": 60, "amplitude": 0.8}]
        result = _build_aligned_reading_tokens(
            [1, 2, 3], np.array([1.5, 2.5, 4.5]), 1.0, 6.0, FakeVocab(), notes=notes
        )
        self.assertEqual(result[0]["end"], 2.08)
        self.assertEqual(result[1]["start"], 2.08)

    def test_does_not_snap_when_note_is_outside_tolerance(self):
        class FakeVocab:
            def decode_single(self, token_id):
                return {1: "きょう", 2: "は", 3: "はれ"}[token_id]

        # 0.5秒差は許容誤差(0.12秒)の外なので、元のCTC中間点のまま変わらない
        notes = [{"start": 2.5, "end": 3.0, "pitchMidi": 60, "amplitude": 0.8}]
        result = _build_aligned_reading_tokens(
            [1, 2, 3], np.array([1.5, 2.5, 4.5]), 1.0, 6.0, FakeVocab(), notes=notes
        )
        self.assertEqual(result[0]["end"], 2.0)

    def test_each_note_start_is_used_by_at_most_one_boundary(self):
        class FakeVocab:
            def decode_single(self, token_id):
                return str(token_id)

        # 2つの内部境界(2.025, 2.075)が両方とも同じノート開始(2.05)の近傍にある場合、
        # 先に処理される境界だけがスナップし、もう一方は元の中間点のまま残る。
        notes = [{"start": 2.05, "end": 2.5, "pitchMidi": 60, "amplitude": 0.8}]
        result = _build_aligned_reading_tokens(
            [1, 2, 3], np.array([2.0, 2.05, 2.1]), 1.0, 6.0, FakeVocab(), notes=notes
        )
        self.assertEqual(result[0]["end"], 2.05)
        self.assertEqual(result[1]["end"], 2.075)

    def test_no_notes_leaves_boundaries_unchanged(self):
        class FakeVocab:
            def decode_single(self, token_id):
                return {1: "きょう", 2: "は", 3: "はれ"}[token_id]

        result = _build_aligned_reading_tokens(
            [1, 2, 3], np.array([1.5, 2.5, 4.5]), 1.0, 6.0, FakeVocab(), notes=None
        )
        self.assertEqual(result[0]["end"], 2.0)


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


class GreedyDecodeCharsTest(unittest.TestCase):
    """to_readingには決定的なダミー関数(恒等変換)を渡し、実際の形態素解析
    (pyopenjtalk)に依存しないようにする。読み変換自体の検証はSubwordToReadingTestで行う。
    """

    def test_collapses_blanks_and_repeats(self):
        class FakeVocab:
            def decode_single(self, token_id):
                return {1: "あ", 2: "い"}[token_id]

        frame_sec = 0.02
        blank_id = 0
        lpz = np.full((6, 3), -10.0)
        for i, tid in enumerate([0, 0, 1, 1, 0, 2]):
            lpz[i, tid] = 0.0
        chars, times, is_anchor = _greedy_decode_chars(lpz, FakeVocab(), blank_id, frame_sec, to_reading=lambda s: s)
        self.assertEqual(chars, ["あ", "い"])
        self.assertAlmostEqual(times[0], 2 * frame_sec)
        self.assertAlmostEqual(times[1], 5 * frame_sec)
        self.assertEqual(is_anchor, [True, True])

    def test_multi_char_unit_only_last_char_is_a_trustworthy_anchor(self):
        # 語彙の1単位が複数文字(例:「もう」)の場合、CTCは1フレームでまとめて検出するため
        # 単位内の全文字が同じ時刻を持つ。しかしそれは「単位全体が検出された瞬間」であって
        # 各文字の発音開始ではないため、最後の文字だけを時刻アンカーとして信頼する。
        class FakeVocab:
            def decode_single(self, token_id):
                return {1: "もう"}[token_id]

        frame_sec = 0.02
        blank_id = 0
        lpz = np.full((3, 2), -10.0)
        for i, tid in enumerate([0, 1, 1]):
            lpz[i, tid] = 0.0
        chars, times, is_anchor = _greedy_decode_chars(lpz, FakeVocab(), blank_id, frame_sec, to_reading=lambda s: s)
        self.assertEqual(chars, ["も", "う"])
        self.assertAlmostEqual(times[0], frame_sec)
        self.assertAlmostEqual(times[1], frame_sec)
        self.assertEqual(is_anchor, [False, True])

    def test_kanji_unit_is_converted_to_reading_via_to_reading(self):
        class FakeVocab:
            def decode_single(self, token_id):
                return {1: "季節"}[token_id]

        frame_sec = 0.02
        blank_id = 0
        lpz = np.full((1, 2), -10.0)
        lpz[0, 1] = 0.0
        chars, times, is_anchor = _greedy_decode_chars(
            lpz, FakeVocab(), blank_id, frame_sec, to_reading=lambda s: {"季節": "きせつ"}[s]
        )
        self.assertEqual(chars, ["き", "せ", "つ"])
        self.assertEqual(is_anchor, [False, False, True])

    def test_empty_reading_produces_no_chars(self):
        # <unk>等、読みに変換できない単位は何も出力しない(無視される)
        class FakeVocab:
            def decode_single(self, token_id):
                return {1: "<unk>"}[token_id]

        frame_sec = 0.02
        blank_id = 0
        lpz = np.full((1, 2), -10.0)
        lpz[0, 1] = 0.0
        chars, times, is_anchor = _greedy_decode_chars(lpz, FakeVocab(), blank_id, frame_sec, to_reading=lambda s: "")
        self.assertEqual(chars, [])
        self.assertEqual(is_anchor, [])


class SubwordToReadingTest(unittest.TestCase):
    def test_caches_and_returns_reading(self):
        cache: dict[str, str] = {}
        reading = _subword_to_reading("季節", cache)
        self.assertEqual(reading, "きせつ")
        self.assertEqual(cache["季節"], "きせつ")

    def test_strips_sentencepiece_word_boundary_marker(self):
        cache: dict[str, str] = {}
        reading = _subword_to_reading("▁これは", cache)
        self.assertEqual(reading, text_to_hiragana_reading("これは"))

    def test_unk_token_yields_empty_reading(self):
        cache: dict[str, str] = {}
        self.assertEqual(_subword_to_reading("<unk>", cache), "")


class SequenceAlignReadingToHypothesisTest(unittest.TestCase):
    def test_exact_match_uses_hypothesis_times_directly(self):
        times, matched = _sequence_align_reading_to_hypothesis("あいう", ["あ", "い", "う"], [1.0, 2.0, 3.0])
        self.assertEqual(times, [1.0, 2.0, 3.0])
        self.assertEqual(matched, [True, True, True])

    def test_missing_chars_are_interpolated_from_surrounding_matches(self):
        # "あいうえお"のうち"い""う""え"が認識結果から脱落(認識ミス)したケース
        times, matched = _sequence_align_reading_to_hypothesis("あいうえお", ["あ", "お"], [1.0, 5.0])
        self.assertEqual(matched, [True, False, False, False, True])
        self.assertAlmostEqual(times[0], 1.0)
        self.assertAlmostEqual(times[1], 2.0)
        self.assertAlmostEqual(times[2], 3.0)
        self.assertAlmostEqual(times[3], 4.0)
        self.assertAlmostEqual(times[4], 5.0)

    def test_empty_hypothesis_falls_back_to_zero_with_no_matches(self):
        times, matched = _sequence_align_reading_to_hypothesis("あい", [], [])
        self.assertEqual(times, [0.0, 0.0])
        self.assertEqual(matched, [False, False])

    def test_empty_reading_returns_empty_lists(self):
        times, matched = _sequence_align_reading_to_hypothesis("", ["あ"], [1.0])
        self.assertEqual(times, [])
        self.assertEqual(matched, [])

    def test_non_anchor_hyp_chars_are_treated_as_interpolation_targets(self):
        # "いない"が1フレームでまとめて検出され、hyp_anchorは最後の"い"だけTrue
        # (_greedy_decode_chars参照)。内容は一致していてもアンカーでない文字は
        # 補間対象として扱われ、実際の発音のばらつきをそのまま時刻として採用しない。
        times, matched = _sequence_align_reading_to_hypothesis(
            "いない", ["い", "な", "い"], [2.0, 2.0, 2.0], hyp_anchor=[False, False, True]
        )
        self.assertEqual(matched, [False, False, True])
        self.assertAlmostEqual(times[2], 2.0)

    def test_notes_fill_interpolation_gap_instead_of_pure_linear_split(self):
        # "あいうえお"のうち先頭と末尾だけがASRと一致(t=0.0, t=4.0)。単純な直線補間なら
        # 等間隔(1.0, 2.0, 3.0)になるが、間にある音符開始時刻(1.5, 2.5)が優先的に
        # 割り当てられるべき。
        notes = [
            {"start": 1.5, "end": 2.0, "pitchMidi": 60, "amplitude": 1.0},
            {"start": 2.5, "end": 3.0, "pitchMidi": 60, "amplitude": 1.0},
        ]
        times, matched = _sequence_align_reading_to_hypothesis(
            "あいうえお",
            ["あ", "お"],
            [0.0, 4.0],
            hyp_anchor=[True, True],
            notes=notes,
        )
        self.assertAlmostEqual(times[0], 0.0)
        self.assertAlmostEqual(times[1], 1.5)
        self.assertAlmostEqual(times[2], 2.5)
        self.assertAlmostEqual(times[4], 4.0)


class InsertNoteSubanchorsTest(unittest.TestCase):
    def test_no_notes_leaves_matched_time_unchanged(self):
        matched_time = [0.0, None, None, 2.0]
        _insert_note_subanchors(matched_time, None)
        self.assertEqual(matched_time, [0.0, None, None, 2.0])

    def test_assigns_note_within_gap_to_a_char_position(self):
        matched_time = [0.0, None, 2.0]
        notes = [{"start": 1.0, "end": 1.5, "pitchMidi": 60, "amplitude": 1.0}]
        _insert_note_subanchors(matched_time, notes)
        self.assertEqual(matched_time, [0.0, 1.0, 2.0])

    def test_note_outside_gap_range_is_not_used(self):
        matched_time = [0.0, None, 2.0]
        notes = [{"start": 5.0, "end": 5.5, "pitchMidi": 60, "amplitude": 1.0}]
        _insert_note_subanchors(matched_time, notes)
        self.assertEqual(matched_time, [0.0, None, 2.0])

    def test_edge_gaps_without_both_side_anchors_are_left_untouched(self):
        # 曲頭(先頭にアンカーが無い)区間はノート割り当てを保留する
        matched_time = [None, None, 2.0]
        notes = [{"start": 0.5, "end": 1.0, "pitchMidi": 60, "amplitude": 1.0}]
        _insert_note_subanchors(matched_time, notes)
        self.assertEqual(matched_time, [None, None, 2.0])

    def test_each_note_used_at_most_once(self):
        matched_time = [0.0, None, None, 3.0]
        notes = [
            {"start": 1.0, "end": 1.2, "pitchMidi": 60, "amplitude": 1.0},
            {"start": 2.0, "end": 2.2, "pitchMidi": 60, "amplitude": 1.0},
        ]
        _insert_note_subanchors(matched_time, notes)
        self.assertEqual(matched_time, [0.0, 1.0, 2.0, 3.0])


class BuildReadingTokensFromCharsTest(unittest.TestCase):
    def test_no_gap_produces_contiguous_tokens(self):
        tokens = _build_reading_tokens_from_chars(["あ", "い", "う"], [1.0, 1.1, 1.2], 0.9, 1.3)
        self.assertEqual(tokens[0]["end"], tokens[1]["start"])
        self.assertEqual(tokens[1]["end"], tokens[2]["start"])

    def test_large_gap_between_chars_inserts_a_rest(self):
        # "い"と"う"の間だけ認識時刻の間隔が広い(休符があるはず)ケース
        tokens = _build_reading_tokens_from_chars(["あ", "い", "う"], [1.0, 1.1, 3.0], 0.9, 3.2)
        self.assertEqual(tokens[0]["end"], tokens[1]["start"])  # 通常間隔(0.1s)は休符にならない
        self.assertLess(tokens[1]["end"], tokens[2]["start"])  # 広い間隔(1.9s)は休符になる
        self.assertAlmostEqual(tokens[1]["end"], 1.2)
        self.assertAlmostEqual(tokens[2]["start"], 2.9)

    def test_gap_between_interpolated_chars_does_not_create_a_rest(self):
        # 補間された文字同士の間隔は実際の無音を反映していないため、休符を作らない
        tokens = _build_reading_tokens_from_chars(
            ["あ", "い", "う"], [1.0, 1.1, 3.0], 0.9, 3.2, matched=[True, False, True]
        )
        self.assertEqual(tokens[0]["end"], tokens[1]["start"])
        self.assertEqual(tokens[1]["end"], tokens[2]["start"])

    def test_rest_margin_larger_than_gap_is_clamped_safely(self):
        # マージンがgapに対して極端に大きい設定でも、start<=endの順序は崩れない
        # (候補値が元の中間点より内側に食い込む場合のみ適用するガードで守られる)
        tokens = _build_reading_tokens_from_chars(
            ["あ", "い"], [1.0, 1.6], 0.9, 1.8, rest_gap_threshold_sec=0.5, rest_margin_sec=1.0
        )
        self.assertLessEqual(tokens[0]["end"], tokens[1]["start"])


@unittest.skipUnless(_WAV2VEC2_MODEL_PATH.exists(), "wav2vec2モデル未取得のためskip(npm run build:modelsで取得)")
class AlignLyricsLinesViaFreeDecodeRegressionTest(unittest.TestCase):
    """自由デコード方式の歌詞タイミング付け(2026-09-22導入)の健全性チェック。
    精度自体は実曲データでの手動検証(手編集済みプロジェクトとの突き合わせ)で確認済みのため、
    ここでは例外なく動作すること・戻り値の形式が正しいことのみ検証する。
    """

    def test_returns_one_entry_per_line_with_valid_shape(self):
        lyrics_lines = ["きょうはいいてんきですね", "あしたはどうかな"]
        audio = (np.random.default_rng(0).standard_normal(16000 * 5) * 0.01).astype(np.float32)

        result = align_lyrics_lines_via_free_decode(lyrics_lines, audio, _WAV2VEC2_MODEL_PATH)

        self.assertEqual(len(result), len(lyrics_lines))
        for line_text, entry in zip(lyrics_lines, result):
            self.assertEqual(entry["text"], line_text)
            self.assertGreaterEqual(entry["end"], entry["start"])
            self.assertGreaterEqual(entry["confidence"], 0.0)
            self.assertLessEqual(entry["confidence"], 1.0)
            self.assertEqual(len(entry["tokenTimings"]), len(text_to_hiragana_reading(line_text)))

    def test_empty_lines_returns_empty_result(self):
        audio = (np.random.default_rng(0).standard_normal(16000) * 0.01).astype(np.float32)
        self.assertEqual(align_lyrics_lines_via_free_decode([], audio, _WAV2VEC2_MODEL_PATH), [])


if __name__ == "__main__":
    unittest.main()
