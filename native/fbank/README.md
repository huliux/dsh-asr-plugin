# FBank native add-on

The add-on exposes `extract(Float32Array)` through `src/native/fbank.ts`.
It implements the fixed filter-bank feature extraction used by the inference
Workers. Upstream source and modifications are documented in
[vendor provenance](vendor/kaldi-native-fbank/UPSTREAM.md).

## Parameters

Input is 16 kHz PCM. Extraction uses 25 ms frames, a 10 ms shift, a Hamming window,
80 mel bins, zero dither, 0.97 pre-emphasis, DC removal, power spectrum, log FBank
and `snip_edges=true`. Each Worker chunk is processed in one shot.
Upstream invariant checks remain enabled.

## Build and verification

```sh
pnpm run build:native:fbank
```

The build requires Apple Silicon macOS, Node.js 24, Apple clang 17.0.0
(`clang-1700.3.19.1`) and macOS SDK 26.0. When `DEVELOPER_DIR` is unset,
the resolver selects matching Command Line Tools. It validates explicit
selections and removes ambient compiler/SDK overrides for its child processes.

Output is `native/fbank/build/Release/fbank.node`.
The complete package build performs two isolated builds, strips debug symbols,
and compares their bytes with the recorded asset identity: 141,448 bytes,
SHA-256 `62c2b1077eefaa9ada40a9fdc4b8e6a0bfd248084336be130310dab7f57c4438`.

Byte reproducibility is specific to this compiler, SDK, source and command.
A changed toolchain requires numerical and artifact verification.
See [development](../../docs/development.md) and
[third-party notices](THIRD_PARTY_NOTICES.md).
