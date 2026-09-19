"""モデル重み等、同梱リソースのパス解決。

オフライン動作要件(要件定義書v3 §5)のため、ライブラリ既定のキャッシュ
(~/.cache/huggingface, ~/.cache/torch 等)やHugging Face Hubへの問い合わせを
一切行わせない。同梱パスは環境変数 DOKOKARA_MODELS_DIR 経由でElectronの
メインプロセス(`src/main/analysisManager.ts` の `buildSidecarEnv()`)から
渡される。
"""

import os
from pathlib import Path


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
