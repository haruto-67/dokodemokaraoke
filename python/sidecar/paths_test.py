"""paths.ensure_downloaded_model のテスト(ネットには出ない)。"""

import hashlib
import io
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from paths import ensure_downloaded_model

DATA = b"model-bytes" * 1000
SHA = hashlib.sha256(DATA).hexdigest()


class EnsureDownloadedModelTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.bundled, self.downloaded = root / "bundled", root / "downloaded"
        self.bundled.mkdir()
        env = {"DOKOKARA_MODELS_DIR": str(self.bundled), "DOKOKARA_DOWNLOADED_MODELS_DIR": str(self.downloaded)}
        patcher = mock.patch.dict(os.environ, env)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(self.tmp.cleanup)
        self.calls = []

    def opener(self, data):
        def open_(url):
            self.calls.append(url)
            return io.BytesIO(data)

        return open_

    def test_downloads_and_verifies(self):
        progress = []
        path = ensure_downloaded_model("m.bin", "u", SHA, len(DATA), lambda got, total: progress.append(got), self.opener(DATA))
        self.assertEqual(path, self.downloaded / "m.bin")
        self.assertEqual(path.read_bytes(), DATA)
        self.assertEqual(progress[-1], len(DATA))
        # 2回目はダウンロードしない
        ensure_downloaded_model("m.bin", "u", SHA, len(DATA), opener=self.opener(DATA))
        self.assertEqual(len(self.calls), 1)

    def test_bundled_model_is_preferred(self):
        (self.bundled / "m.bin").write_bytes(DATA)
        path = ensure_downloaded_model("m.bin", "u", SHA, len(DATA), opener=self.opener(DATA))
        self.assertEqual(path, self.bundled / "m.bin")
        self.assertEqual(self.calls, [])

    def test_broken_download_is_removed(self):
        with self.assertRaises(RuntimeError):
            ensure_downloaded_model("m.bin", "u", SHA, len(DATA), opener=self.opener(DATA[:-1] + b"x"))
        self.assertEqual(list(self.downloaded.iterdir()), [])

    def test_network_error_is_reported(self):
        def fail(url):
            raise OSError("no network")

        with self.assertRaisesRegex(RuntimeError, "インターネット"):
            ensure_downloaded_model("m.bin", "u", SHA, len(DATA), opener=fail)


if __name__ == "__main__":
    unittest.main()
