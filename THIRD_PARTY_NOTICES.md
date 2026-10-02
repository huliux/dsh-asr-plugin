# Third-party notices

> Generated from `src/assets/supply-chain.json`; do not edit independently.
> Transport mirrors are intentionally excluded: they are not provenance or authorship.

The project itself is licensed under Apache-2.0; the full text is in `LICENSE`.

## huggingface.co/onnx-community/pyannote-segmentation-3.0 — vad-model

- Fixed source: [repository](https://huggingface.co/onnx-community/pyannote-segmentation-3.0) at `733a93b6473d019a773298e08cefa686894b1854`.
- Source files: `onnx/model.onnx`.
- License: [`MIT`](https://opensource.org/license/mit).
- License material: `third_party/licenses/MIT-CNRS.txt`.
- Distribution: `public`.
- Attribution: pyannote segmentation 3.0, Copyright (c) 2023 CNRS; ONNX conversion by onnx-community from pyannote/segmentation-3.0@e66f3d3b9eb0873085418a7b813d3b369bf160bb; model bytes unchanged and repackaged.

## huggingface.co/Wespeaker/wespeaker-voxceleb-resnet34-LM — speaker-embedding-model

- Fixed source: [repository](https://huggingface.co/Wespeaker/wespeaker-voxceleb-resnet34-LM) at `f0c48c298fd835726c27956a5d617bad7115627e`.
- Source files: `voxceleb_resnet34_LM.onnx`.
- License: [`CC-BY-4.0`](https://creativecommons.org/licenses/by/4.0/legalcode).
- License material: `third_party/licenses/CC-BY-4.0.md`.
- Distribution: `public`.
- Attribution: WeSpeaker VoxCeleb ResNet34-LM trained on VoxCeleb2 Dev; model bytes unchanged and renamed to embedding.onnx for delivery.
- Citations:
  - Hongji Wang et al. “WeSpeaker: A research and production oriented speaker embedding learning toolkit.” ICASSP 2023, pp. 1–5. https://arxiv.org/abs/2210.17016
  - Hossein Zeinali et al. “BUT system description to VoxCeleb speaker recognition challenge 2019.” arXiv:1910.12592. https://arxiv.org/abs/1910.12592

## modelscope.cn/models/iic/speech_paraformer-large-vad-punc_asr_nat-zh-cn-16k-common-vocab8404-onnx — asr-config, asr-cmvn, asr-model, asr-tokens

- Fixed source: [repository](https://modelscope.cn/models/iic/speech_paraformer-large-vad-punc_asr_nat-zh-cn-16k-common-vocab8404-onnx) at `99321729a5c7b38be579ead523bac68804573bd3`.
- Source files: `config.yaml`, `am.mvn`, `model_quant.onnx`, `tokens.json`.
- License: [`Apache-2.0`](https://www.apache.org/licenses/LICENSE-2.0.txt).
- License material: `LICENSE`.
- Distribution: `public`.
- Attribution: Alibaba DAMO Academy, IIC and FunASR Paraformer ONNX; bytes unchanged.

## modelscope.cn/models/iic/punc_ct-transformer_zh-cn-common-vocab272727-onnx — punc-config, punc-model, punc-tokens

- Fixed source: [repository](https://modelscope.cn/models/iic/punc_ct-transformer_zh-cn-common-vocab272727-onnx) at `8f239ff78c6267c4d859233e7eb3bbdb68c61824`.
- Source files: `config.yaml`, `model_quant.onnx`, `tokens.json`.
- License: [`Apache-2.0`](https://www.apache.org/licenses/LICENSE-2.0.txt).
- License material: `LICENSE`.
- Distribution: `public`.
- Attribution: Alibaba DAMO Academy, IIC and FunASR CT-Transformer punctuation ONNX; bytes unchanged.
- Citations:
  - Qian Chen, Mengzhe Chen, Bo Li, and Wen Wang. “Controllable Time-Delay Transformer for Real-Time Punctuation Prediction and Disfluency Detection.” ICASSP 2020, pp. 8069–8073.

## github.com/csukuangfj/kaldi-native-fbank — fbank-native

- Fixed source: [repository](https://github.com/csukuangfj/kaldi-native-fbank) at `fdc395d24dc3e9e48ae1df4f0f6860f6b7d4870e`.
- Source files: `kaldi-native-fbank/csrc`.
- License: [`Apache-2.0`](https://www.apache.org/licenses/LICENSE-2.0.txt) AND [`MIT`](https://opensource.org/license/mit) AND `LicenseRef-Ooura-FFT`.
- License material: `LICENSE`, `third_party/licenses/MIT-node-addon-api.md`, `third_party/licenses/Ooura-FFT.txt`.
- Distribution: `public`.
- Attribution: kaldi-native-fbank v1.20.0 vendored C++ sources under Apache-2.0; project compatibility patch in mel-computations.cc; node-addon-api MIT headers; Takuya Ooura FFT source and notice retained.

## github.com/kunji163/clerki — hcluster-native

- Fixed source: [repository](https://github.com/kunji163/clerki) at `44887f62f7b1a69fcc9d23583aa8df8f11898aca`.
- Source files: `hclust-cpp`.
- License: [`BSD-2-Clause`](https://opensource.org/license/bsd-2-clause) AND [`MIT`](https://opensource.org/license/mit).
- License material: `third_party/licenses/BSD-2-Clause-Bitbook.txt`, `third_party/licenses/BSD-2-Clause-fastcluster.txt`, `third_party/licenses/MIT-node-addon-api.md`.
- Distribution: `public`.
- Attribution: Bitbook wrapper Copyright (c) 2024 Max Bain; fastcluster from cdalitz/hclust-cpp@d48fff6bba1199d80422cd37f5b635107a5a0c92, Copyright 2011 Daniel Müllner and 2018-2020 Christoph Dalitz; node-addon-api MIT headers; stderr fallback modified.

## onnxruntime-node@1.19.2

- Fixed source: [repository](https://github.com/microsoft/onnxruntime) at `ffceed9d44f2f3efb9dd69fa75fea51163c91d91`.
- npm integrity: `sha512-9eHMP/HKbbeUcqte1JYzaaRC8JPn7ojWeCeoyShO86TOR97OCyIyAIOGX3V95ErjslVhJRXY8Em/caIUc0hm1Q==`.
- License: [`MIT`](https://opensource.org/license/mit).
- License material: `third_party/onnxruntime/LICENSE`.
- Runtime artifacts: `bin/napi-v3/darwin/arm64/onnxruntime_binding.node`, `bin/napi-v3/darwin/arm64/libonnxruntime.1.19.2.dylib`.
- Packaged upstream notice inputs: `third_party/onnxruntime/LICENSE`, `third_party/onnxruntime/ThirdPartyNotices.txt`.
- Attribution: Microsoft ONNX Runtime; upstream LICENSE and ThirdPartyNotices.txt are required with redistribution.

## Bitbook recording capture

- Fixed source: [repository](https://github.com/kunji163/clerki) at `44887f62f7b1a69fcc9d23583aa8df8f11898aca`, `audio-native/`.
- License: BSD-2-Clause; full text in `third_party/licenses/BSD-2-Clause-Bitbook.txt`.
- Attribution: Bitbook capture sources, Copyright (c) 2024 Max Bain; project changes cover chunk finalization, format conversion and product naming.
- The Helper wrapper is project-owned Apache-2.0 code. Apple frameworks are linked from macOS, not redistributed. AudioTee is a design reference; no AudioTee source or binary is included.
