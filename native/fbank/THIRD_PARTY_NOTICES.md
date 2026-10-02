# 第三方声明

`fbank.node` 链接了 vendored `kaldi-native-fbank` v1.20.0 源码，依 Apache License 2.0 使用；许可证全文见 `vendor/kaldi-native-fbank/LICENSE`。

其中 `vendor/kaldi-native-fbank/csrc/fftsg.cc` 来自 Takuya Ooura 的 FFT package。其源码声明允许免费用于、复制、修改和分发（包括商业用途），修改时应引用原 package；本项目保持该文件原样。

Node-API wrapper 使用 `node-addon-api@8.5.0` 头文件并将其实现内联进产物；其 MIT 许可证见 `vendor/node-addon-api-LICENSE.md`。

公开分发 `fbank.node` 时，必须同时交付 Apache-2.0 许可证、node-addon-api MIT 许可证、本声明以及 `fftsg.cc` 中的原始版权与许可声明。
