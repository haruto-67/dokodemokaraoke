"""separation.pyの純粋ロジック部分(進捗パース)のテスト。

demix_track自体(モデル推論)はmelband-roformer-inferパッケージ本体の実装であり、
かつ実チェックポイント(913MB)を要するため、ここでは検証しない
(実チェックポイントでの動作確認は開発時に手動で実施済み)。
ここでは自作した _ProgressInterceptStream の"標準出力の横取り→進捗率への変換"
ロジックのみを、torch/melband-roformer-infer無しに素早く検証する。
"""

import unittest

from separation import _ProgressInterceptStream


class ProgressInterceptStreamTest(unittest.TestCase):
    def test_total_and_remaining_lines_produce_progress_fraction(self):
        events = []
        stream = _ProgressInterceptStream(events.append)

        stream.write("Estimated total processing time for this track: 100.00 seconds\n")
        stream.write("Estimated time remaining: 100.00 seconds\r")
        stream.write("Estimated time remaining: 75.00 seconds\r")
        stream.write("Estimated time remaining: 0.00 seconds\r")

        self.assertEqual(len(events), 3)
        self.assertAlmostEqual(events[0], 0.0, places=3)
        self.assertAlmostEqual(events[1], 0.25, places=3)
        self.assertAlmostEqual(events[2], 1.0, places=3)

    def test_unrelated_lines_are_ignored(self):
        events = []
        stream = _ProgressInterceptStream(events.append)

        stream.write("Total tracks found: 1\n")
        stream.write("\nProcessing track 1/1: source.wav\n")
        stream.write("Elapsed time: 12.34 sec\n")

        self.assertEqual(events, [])

    def test_remaining_without_total_is_ignored(self):
        events = []
        stream = _ProgressInterceptStream(events.append)

        stream.write("Estimated time remaining: 10.00 seconds\r")

        self.assertEqual(events, [])

    def test_none_callback_never_raises(self):
        stream = _ProgressInterceptStream(None)
        # 例外を出さないことだけを確認する(戻り値は書き込みバイト数)
        length = stream.write("Estimated total processing time for this track: 5.00 seconds\n")
        self.assertEqual(length, len("Estimated total processing time for this track: 5.00 seconds\n"))

    def test_progress_is_clamped_to_0_1(self):
        events = []
        stream = _ProgressInterceptStream(events.append)

        stream.write("Estimated total processing time for this track: 10.00 seconds\n")
        # remaining > total (推定のブレ)でもfractionが範囲外にならない
        stream.write("Estimated time remaining: 15.00 seconds\r")

        self.assertEqual(events, [0.0])


if __name__ == "__main__":
    unittest.main()
