"""RMVPE(Robust Model for Vocal Pitch Estimation)の推論専用実装(要件定義書v3 §4.4.3 STEP3)。

RVC-Project(https://github.com/RVC-Project/Retrieval-based-Voice-Conversion-WebUI, MIT)の
`infer/rmvpe.py` からアーキテクチャ定義(STFT実装を除く。CPU実行では標準の`torch.stft`だけで
足り、独自STFTクラスはDirectML(AMD GPU on Windows)向けの特殊経路でしか使われないため)を
移植し、以下を取り除いた薄い推論専用版:
- CUDA Graph最適化・DirectML(ONNX/privateuseone)経路・半精度(fp16)分岐
  (本アプリはmacOS arm64専用でCPU実行のみのため不要)
- RVC本体の`configs.config`へのグローバル設定依存

同梱チェックポイント(resources/models/rmvpe.pt)のstate_dictキー
(unet.encoder/unet.intermediate/unet.decoder/cnn/fc)がこの実装とそのまま一致することを
実機で確認済み。
"""

from __future__ import annotations

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
from librosa.filters import mel


class BiGRU(nn.Module):
    def __init__(self, input_features: int, hidden_features: int, num_layers: int) -> None:
        super().__init__()
        self.gru = nn.GRU(
            input_features,
            hidden_features,
            num_layers=num_layers,
            batch_first=True,
            bidirectional=True,
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.gru(x)[0]


class ConvBlockRes(nn.Module):
    def __init__(self, in_channels: int, out_channels: int, momentum: float = 0.01) -> None:
        super().__init__()
        self.conv = nn.Sequential(
            nn.Conv2d(in_channels, out_channels, (3, 3), (1, 1), (1, 1), bias=False),
            nn.BatchNorm2d(out_channels, momentum=momentum),
            nn.ReLU(),
            nn.Conv2d(out_channels, out_channels, (3, 3), (1, 1), (1, 1), bias=False),
            nn.BatchNorm2d(out_channels, momentum=momentum),
            nn.ReLU(),
        )
        if in_channels != out_channels:
            self.shortcut = nn.Conv2d(in_channels, out_channels, (1, 1))

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        if not hasattr(self, "shortcut"):
            return self.conv(x) + x
        return self.conv(x) + self.shortcut(x)


class ResEncoderBlock(nn.Module):
    def __init__(self, in_channels, out_channels, kernel_size, n_blocks=1, momentum=0.01) -> None:
        super().__init__()
        self.conv = nn.ModuleList([ConvBlockRes(in_channels, out_channels, momentum)])
        for _ in range(n_blocks - 1):
            self.conv.append(ConvBlockRes(out_channels, out_channels, momentum))
        self.kernel_size = kernel_size
        if self.kernel_size is not None:
            self.pool = nn.AvgPool2d(kernel_size=kernel_size)

    def forward(self, x: torch.Tensor):
        for conv in self.conv:
            x = conv(x)
        if self.kernel_size is not None:
            return x, self.pool(x)
        return x


class Encoder(nn.Module):
    def __init__(self, in_channels, in_size, n_encoders, kernel_size, n_blocks, out_channels=16, momentum=0.01) -> None:
        super().__init__()
        self.n_encoders = n_encoders
        self.bn = nn.BatchNorm2d(in_channels, momentum=momentum)
        self.layers = nn.ModuleList()
        for _ in range(self.n_encoders):
            self.layers.append(ResEncoderBlock(in_channels, out_channels, kernel_size, n_blocks, momentum))
            in_channels = out_channels
            out_channels *= 2
            in_size //= 2
        self.out_channel = out_channels

    def forward(self, x: torch.Tensor):
        concat_tensors = []
        x = self.bn(x)
        for layer in self.layers:
            t, x = layer(x)
            concat_tensors.append(t)
        return x, concat_tensors


class Intermediate(nn.Module):
    def __init__(self, in_channels, out_channels, n_inters, n_blocks, momentum=0.01) -> None:
        super().__init__()
        self.layers = nn.ModuleList([ResEncoderBlock(in_channels, out_channels, None, n_blocks, momentum)])
        for _ in range(n_inters - 1):
            self.layers.append(ResEncoderBlock(out_channels, out_channels, None, n_blocks, momentum))

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        for layer in self.layers:
            x = layer(x)
        return x


class ResDecoderBlock(nn.Module):
    def __init__(self, in_channels, out_channels, stride, n_blocks=1, momentum=0.01) -> None:
        super().__init__()
        out_padding = (0, 1) if stride == (1, 2) else (1, 1)
        self.conv1 = nn.Sequential(
            nn.ConvTranspose2d(in_channels, out_channels, (3, 3), stride, (1, 1), out_padding, bias=False),
            nn.BatchNorm2d(out_channels, momentum=momentum),
            nn.ReLU(),
        )
        self.conv2 = nn.ModuleList([ConvBlockRes(out_channels * 2, out_channels, momentum)])
        for _ in range(n_blocks - 1):
            self.conv2.append(ConvBlockRes(out_channels, out_channels, momentum))

    def forward(self, x: torch.Tensor, concat_tensor: torch.Tensor) -> torch.Tensor:
        x = self.conv1(x)
        x = torch.cat((x, concat_tensor), dim=1)
        for conv2 in self.conv2:
            x = conv2(x)
        return x


class Decoder(nn.Module):
    def __init__(self, in_channels, n_decoders, stride, n_blocks, momentum=0.01) -> None:
        super().__init__()
        self.layers = nn.ModuleList()
        for _ in range(n_decoders):
            out_channels = in_channels // 2
            self.layers.append(ResDecoderBlock(in_channels, out_channels, stride, n_blocks, momentum))
            in_channels = out_channels

    def forward(self, x: torch.Tensor, concat_tensors: list[torch.Tensor]) -> torch.Tensor:
        for i, layer in enumerate(self.layers):
            x = layer(x, concat_tensors[-1 - i])
        return x


class DeepUnet(nn.Module):
    def __init__(self, kernel_size, n_blocks, en_de_layers=5, inter_layers=4, in_channels=1, en_out_channels=16) -> None:
        super().__init__()
        self.encoder = Encoder(in_channels, 128, en_de_layers, kernel_size, n_blocks, en_out_channels)
        self.intermediate = Intermediate(
            self.encoder.out_channel // 2, self.encoder.out_channel, inter_layers, n_blocks
        )
        self.decoder = Decoder(self.encoder.out_channel, en_de_layers, kernel_size, n_blocks)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        x, concat_tensors = self.encoder(x)
        x = self.intermediate(x)
        return self.decoder(x, concat_tensors)


class E2E(nn.Module):
    def __init__(self, n_blocks, n_gru, kernel_size, en_de_layers=5, inter_layers=4, in_channels=1, en_out_channels=16) -> None:
        super().__init__()
        self.unet = DeepUnet(kernel_size, n_blocks, en_de_layers, inter_layers, in_channels, en_out_channels)
        self.cnn = nn.Conv2d(en_out_channels, 3, (3, 3), padding=(1, 1))
        self.fc = nn.Sequential(
            BiGRU(3 * 128, 256, n_gru),
            nn.Linear(512, 360),
            nn.Dropout(0.25),
            nn.Sigmoid(),
        )

    def forward(self, mel: torch.Tensor) -> torch.Tensor:
        mel = mel.transpose(-1, -2).unsqueeze(1)
        x = self.cnn(self.unet(mel)).transpose(1, 2).flatten(-2)
        return self.fc(x)


class MelSpectrogram(nn.Module):
    """RMVPE入力用のlog-melスペクトログラム(16kHz/128mel/hop160を前提とした固定パラメータで使用)。"""

    def __init__(self, n_mel_channels: int, sampling_rate: int, win_length: int, hop_length: int, n_fft=None, mel_fmin=0, mel_fmax=None, clamp=1e-5) -> None:
        super().__init__()
        n_fft = win_length if n_fft is None else n_fft
        mel_basis = mel(sr=sampling_rate, n_fft=n_fft, n_mels=n_mel_channels, fmin=mel_fmin, fmax=mel_fmax, htk=True)
        self.register_buffer("mel_basis", torch.from_numpy(mel_basis).float())
        self.n_fft = n_fft
        self.hop_length = hop_length
        self.win_length = win_length
        self.clamp = clamp
        self._hann_window: dict[str, torch.Tensor] = {}

    def forward(self, audio: torch.Tensor, center: bool = True) -> torch.Tensor:
        key = str(audio.device)
        if key not in self._hann_window:
            self._hann_window[key] = torch.hann_window(self.win_length).to(audio.device)
        fft = torch.stft(
            audio,
            n_fft=self.n_fft,
            hop_length=self.hop_length,
            win_length=self.win_length,
            window=self._hann_window[key],
            center=center,
            return_complex=True,
        )
        magnitude = torch.sqrt(fft.real.pow(2) + fft.imag.pow(2))
        mel_output = torch.matmul(self.mel_basis, magnitude)
        return torch.log(torch.clamp(mel_output, min=self.clamp))


class RMVPE:
    """RMVPEのCPU専用・推論専用ラッパー。

    RVC-Project本家の`RMVPE`クラスからCUDA Graph/DirectML/半精度対応を取り除いたもの。
    16kHzモノラル音声を受け取り、100fps(10msホップ)のF0(Hz)配列を返す。無声(unvoiced)
    フレームは0.0になる。
    """

    def __init__(self, model_path: str, device: str = "cpu") -> None:
        self.device = torch.device(device)
        self.mel_extractor = MelSpectrogram(128, 16000, 1024, 160, None, 30, 8000).to(self.device)
        model = E2E(4, 1, (2, 2))
        state = torch.load(model_path, map_location="cpu")
        model.load_state_dict(state)
        model.eval()
        self.model = model.to(self.device)
        cents_mapping = 20 * np.arange(360) + 1997.3794084376191
        self.cents_mapping = np.pad(cents_mapping, (4, 4))  # 368

    def _mel2hidden(self, mel_spec: torch.Tensor) -> np.ndarray:
        with torch.no_grad():
            n_frames = mel_spec.shape[-1]
            n_pad = 32 * ((n_frames - 1) // 32 + 1) - n_frames
            if n_pad > 0:
                mel_spec = F.pad(mel_spec, (0, n_pad), mode="constant")
            hidden = self.model(mel_spec)
            return hidden[:, :n_frames].squeeze(0).cpu().numpy()

    def _to_local_average_cents(self, salience: np.ndarray, thred: float = 0.03) -> np.ndarray:
        center = np.argmax(salience, axis=1)
        salience = np.pad(salience, ((0, 0), (4, 4)))
        center += 4
        starts = center - 4
        ends = center + 5
        todo_salience = np.array([salience[idx, starts[idx]:ends[idx]] for idx in range(salience.shape[0])])
        todo_cents_mapping = np.array([self.cents_mapping[starts[idx]:ends[idx]] for idx in range(salience.shape[0])])
        product_sum = np.sum(todo_salience * todo_cents_mapping, axis=1)
        weight_sum = np.sum(todo_salience, axis=1)
        devided = product_sum / weight_sum
        maxx = np.max(salience, axis=1)
        devided[maxx <= thred] = 0
        return devided

    def infer_from_audio(self, audio_16k_mono: np.ndarray, thred: float = 0.03) -> np.ndarray:
        """16kHzモノラルのfloat32 PCM配列からF0(Hz)配列(100fps)を返す。無声区間は0.0。"""
        audio = torch.from_numpy(audio_16k_mono).float().to(self.device).unsqueeze(0)
        mel_spec = self.mel_extractor(audio, center=True)
        hidden = self._mel2hidden(mel_spec)
        cents_pred = self._to_local_average_cents(hidden, thred=thred)
        f0 = 10 * (2 ** (cents_pred / 1200))
        f0[f0 == 10] = 0
        return f0
