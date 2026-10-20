"""モデル重み等、同梱リソースのパス解決。

オフライン動作要件(要件定義書v3 §5)のため、ライブラリ既定のキャッシュ
(~/.cache/huggingface, ~/.cache/torch 等)やHugging Face Hubへの問い合わせを
一切行わせない。同梱パスは環境変数 DOKOKARA_MODELS_DIR 経由でElectronの
メインプロセス(`src/main/analysisManager.ts` の `buildSidecarEnv()`)から
渡される。

例外として、大きすぎてアプリに同梱しないモデル(英語用の音素認識モデル)は、初めて使う時に
このリポジトリのGitHub Releases(model-weights-v1)から DOKOKARA_DOWNLOADED_MODELS_DIR
(アプリのユーザーデータの下)へダウンロードする(ensure_downloaded_model)。DMGがGitHubの
リリースに付けられる1ファイルの上限(2GiB)を超えたため。
"""

import hashlib
import os
from pathlib import Path
from typing import Callable, Optional


def models_dir() -> Path:
    raw = os.environ.get("DOKOKARA_MODELS_DIR")
    if not raw:
        raise RuntimeError(
            "DOKOKARA_MODELS_DIR が設定されていません。"
            "サイドカーはElectronのメインプロセスから起動される想定です。"
        )
    return Path(raw)


def model_path(filename: str) -> Path:
    """同梱モデル重み1ファイルのパスを返す。存在確認は呼び出し側で行う
    (重みがまだ配置されていない開発中の状態と、実際に壊れている状態を
    区別できるよう、ここでは例外にしない)。
    """
    return models_dir() / filename


def downloaded_models_dir() -> Path:
    raw = os.environ.get("DOKOKARA_DOWNLOADED_MODELS_DIR")
    if not raw:
        raise RuntimeError("DOKOKARA_DOWNLOADED_MODELS_DIR が設定されていません。")
    return Path(raw)


def ensure_downloaded_model(
    filename: str,
    url: str,
    sha256: str,
    size: int,
    on_progress: Optional[Callable[[int, int], None]] = None,
    opener: Optional[Callable[[str], object]] = None,
) -> Path:
    """同梱しないモデルのパス。同梱フォルダにあればそれを(開発時)、無ければダウンロード先を返し、
    まだ無い時はダウンロードしてsha256を確かめる。on_progress(受け取ったバイト数, 全体)で進捗を返す。
    openerはテスト用(既定はurllib)。"""
    bundled = model_path(filename)
    if bundled.exists():
        return bundled
    target = downloaded_models_dir() / filename
    if target.exists() and target.stat().st_size == size:
        return target
    target.parent.mkdir(parents=True, exist_ok=True)
    part = target.with_name(target.name + ".part")
    if opener is None:
        import ssl
        import urllib.request

        try:
            import certifi

            context = ssl.create_default_context(cafile=certifi.where())
        except ImportError:
            context = ssl.create_default_context()
        opener = lambda u: urllib.request.urlopen(u, timeout=60, context=context)  # noqa: E731
    digest = hashlib.sha256()
    received = 0
    try:
        with opener(url) as res, part.open("wb") as f:
            while True:
                chunk = res.read(1 << 20)
                if not chunk:
                    break
                f.write(chunk)
                digest.update(chunk)
                received += len(chunk)
                if on_progress:
                    on_progress(received, size)
    except OSError as exc:
        part.unlink(missing_ok=True)
        raise RuntimeError(
            f"モデル({filename})のダウンロードに失敗しました。インターネットに接続してからやり直してください: {exc}"
        ) from exc
    if received != size or digest.hexdigest() != sha256:
        part.unlink(missing_ok=True)
        raise RuntimeError(f"ダウンロードしたモデル({filename})が壊れています。もう一度やり直してください。")
    part.replace(target)
    return target
