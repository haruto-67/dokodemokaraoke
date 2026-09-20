"""vad.pyの純粋ロジック部分(segments_from_probabilities)のテスト。
Silero VADモデル自体(実チェックポイント)は使わず、合成した発話確率配列だけで検証する
(実モデルでの検証は開発時に手動で実施済み)。
"""

import unittest

import numpy as np

from vad import CHUNK_SEC, segments_from_probabilities


class SegmentsFromProbabilitiesTest(unittest.TestCase):
    def test_single_sustained_speech_segment(self):
        probs = np.concatenate([np.zeros(5), np.ones(20), np.zeros(5)])
        total_duration = len(probs) * CHUNK_SEC
        segments = segments_from_probabilities(
            probs, total_duration, min_speech_duration_sec=0.1, min_silence_duration_sec=0.1, speech_pad_sec=0.0
        )
        self.assertEqual(len(segments), 1)
        self.assertLess(segments[0]["start"], segments[0]["end"])

    def test_silence_only_produces_no_segments(self):
        probs = np.zeros(50)
        segments = segments_from_probabilities(probs, len(probs) * CHUNK_SEC)
        self.assertEqual(segments, [])

    def test_short_speech_blip_below_min_duration_is_dropped(self):
        # 1チャンクだけの発話は既定のmin_speech_duration_sec(0.25s)未満なので捨てられる
        probs = np.concatenate([np.zeros(10), np.ones(1), np.zeros(10)])
        segments = segments_from_probabilities(probs, len(probs) * CHUNK_SEC)
        self.assertEqual(segments, [])

    def test_short_silence_gap_does_not_split_segment(self):
        # 発話-短い無音(min_silence未満)-発話、は1つのセグメントとして繋がる
        probs = np.concatenate([np.ones(20), np.zeros(2), np.ones(20)])
        segments = segments_from_probabilities(
            probs, len(probs) * CHUNK_SEC, min_silence_duration_sec=0.3, speech_pad_sec=0.0
        )
        self.assertEqual(len(segments), 1)

    def test_long_silence_gap_splits_into_two_segments(self):
        probs = np.concatenate([np.ones(20), np.zeros(30), np.ones(20)])
        segments = segments_from_probabilities(
            probs, len(probs) * CHUNK_SEC, min_silence_duration_sec=0.3, speech_pad_sec=0.0
        )
        self.assertEqual(len(segments), 2)

    def test_speech_pad_extends_segment_but_not_past_bounds(self):
        probs = np.ones(10)
        total_duration = len(probs) * CHUNK_SEC
        segments = segments_from_probabilities(probs, total_duration, speech_pad_sec=10.0)
        self.assertEqual(len(segments), 1)
        self.assertEqual(segments[0]["start"], 0.0)
        self.assertEqual(segments[0]["end"], total_duration)


if __name__ == "__main__":
    unittest.main()
