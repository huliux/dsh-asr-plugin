# 合成音频回归样本

`alternating-stereo.mp3` 是两秒钟的确定性合成音频：前一秒只有左声道 440 Hz，后一秒只有右声道 660 Hz，不包含会议或个人数据。

当前 fixture 由 FFmpeg 8.0 + `libmp3lame` 生成，SHA-256 为 `399f859d65955d838b4d94a29324f319ad78e7d0b726bf4156ca16ccbbbad708`。构建脚本只在输出命中该 hash 时原子替换 fixture；其它 FFmpeg/encoder 版本只能作为语义参考，不会静默改写冻结样本。

在安装 FFmpeg（含 `libmp3lame`）后重建：

```sh
node tests/fixtures/audio/build.mjs
```

可通过 `FFMPEG=/absolute/path/to/ffmpeg` 显式指定构建工具。该样本只用于验证导入时的 stereo-to-mono 内容保真，不进入产品资产 manifest。
