"""f0_notes.pyの純粋ロジック部分のテスト。RMVPEモデル自体(実チェックポイント)は使わず、
合成したF0配列だけで resample_f0 / f0_to_basic_pitch_activation / notes_from_f0 を検証する
(実モデルでの検証は開発時に手動で実施済み: 440Hz→660Hzの2音テストでpitchMidi 69→76を確認)。
"""

import unittest

import numpy as np
from basic_pitch.constants import ANNOTATIONS_FPS, N_FREQ_BINS_CONTOURS, N_FREQ_BINS_NOTES

from f0_notes import f0_to_basic_pitch_activation, notes_from_f0, resample_f0


class ResampleF0Test(unittest.TestCase):
    def test_output_length_matches_annotations_fps(self):
        f0 = np.full(1000, 440.0, dtype=np.float32)  # 100fpsで10秒相当
        resampled = resample_f0(f0, source_fps=100.0, duration_sec=10.0)
        self.assertEqual(len(resampled), round(10.0 * ANNOTATIONS_FPS))

    def test_sample_and_hold_does_not_invent_pitch_across_unvoiced_gap(self):
        # 440Hz -> 無声(0) -> 880Hz という区間で、中間フレームが440と880の中間値
        # (線形補間なら660付近)にならず、必ずどちらかのソース値そのものになることを確認する
        f0 = np.concatenate([np.full(50, 440.0), np.zeros(50), np.full(50, 880.0)]).astype(np.float32)
        resampled = resample_f0(f0, source_fps=100.0, duration_sec=1.5)
        allowed = {0.0, np.float32(440.0), np.float32(880.0)}
        for v in resampled:
            self.assertIn(round(float(v), 3), {round(a, 3) for a in allowed})

    def test_empty_input_returns_zeros(self):
        resampled = resample_f0(np.array([], dtype=np.float32), source_fps=100.0, duration_sec=1.0)
        self.assertTrue(np.all(resampled == 0))


class F0ToActivationTest(unittest.TestCase):
    def test_shapes_match_basic_pitch_constants(self):
        f0 = np.array([440.0, 440.0, 0.0, 660.0], dtype=np.float32)
        activation = f0_to_basic_pitch_activation(f0)
        self.assertEqual(activation["contour"].shape, (4, N_FREQ_BINS_CONTOURS))
        self.assertEqual(activation["note"].shape, (4, N_FREQ_BINS_NOTES))
        self.assertEqual(activation["onset"].shape, (4, N_FREQ_BINS_NOTES))

    def test_unvoiced_frame_has_no_activation(self):
        f0 = np.array([440.0, 0.0, 440.0], dtype=np.float32)
        activation = f0_to_basic_pitch_activation(f0)
        self.assertTrue(np.all(activation["note"][1] == 0))
        self.assertTrue(np.all(activation["contour"][1] == 0))

    def test_onset_fires_once_per_voiced_segment(self):
        # 440Hzが3フレーム続く1つのセグメント -> onsetは先頭フレームだけ1になる
        f0 = np.array([440.0, 440.0, 440.0], dtype=np.float32)
        activation = f0_to_basic_pitch_activation(f0)
        onset_frame_indices = np.where(activation["onset"].sum(axis=1) > 0)[0]
        np.testing.assert_array_equal(onset_frame_indices, [0])

    def test_reonset_after_unvoiced_gap(self):
        # 440Hz -> 無声 -> 440Hz。2つ目のセグションの先頭でも再度onsetが立つ
        f0 = np.array([440.0, 0.0, 440.0], dtype=np.float32)
        activation = f0_to_basic_pitch_activation(f0)
        onset_frame_indices = np.where(activation["onset"].sum(axis=1) > 0)[0]
        np.testing.assert_array_equal(onset_frame_indices, [0, 2])

    def test_out_of_range_frequency_is_treated_as_unvoiced(self):
        # ANNOTATIONS_BASE_FREQUENCY(27.5Hz)未満は範囲外として無視される
        f0 = np.array([10.0], dtype=np.float32)
        activation = f0_to_basic_pitch_activation(f0)
        self.assertTrue(np.all(activation["note"][0] == 0))


class NotesFromF0Test(unittest.TestCase):
    def test_single_sustained_pitch_produces_one_note(self):
        # 440Hz(A4, MIDI 69)を100fpsで2秒間持続させた合成F0
        f0 = np.full(200, 440.0, dtype=np.float32)
        notes, f0_86fps = notes_from_f0(f0, source_fps=100.0, duration_sec=2.0)

        self.assertEqual(len(f0_86fps), round(2.0 * ANNOTATIONS_FPS))
        self.assertEqual(len(notes), 1)
        self.assertEqual(notes[0]["pitchMidi"], 69)
        self.assertGreater(notes[0]["end"], notes[0]["start"])
        self.assertAlmostEqual(notes[0]["start"], 0.0, delta=0.05)

    def test_silence_produces_no_notes(self):
        f0 = np.zeros(200, dtype=np.float32)
        notes, _f0_86fps = notes_from_f0(f0, source_fps=100.0, duration_sec=2.0)
        self.assertEqual(notes, [])

    def test_notes_are_sorted_by_start_time(self):
        f0 = np.concatenate(
            [np.full(80, 440.0), np.zeros(20), np.full(80, 660.0)]
        ).astype(np.float32)
        notes, _f0_86fps = notes_from_f0(f0, source_fps=100.0, duration_sec=1.8)
        starts = [n["start"] for n in notes]
        self.assertEqual(starts, sorted(starts))


if __name__ == "__main__":
    unittest.main()
