# FBank native

This directory contains the rebuildable source for `fbank.node`. The JavaScript boundary remains the single `extract(Float32Array)` function in `src/native/fbank.ts`. The addon implements only the fixed FBank algorithm and Node-API wrapper required by the product; it does not expose MFCC, Whisper, online extraction, configurable parameters, or another provider.

## Source and fixed options

The core is vendored [`kaldi-native-fbank` v1.20.0](vendor/kaldi-native-fbank/UPSTREAM.md) with one documented mel accumulation compatibility patch. The wrapper fixes 16 kHz audio, 25 ms frames, 10 ms shift, Hamming window, 80 mel bins, zero dither, 0.97 pre-emphasis, DC removal, power spectrum, log FBank, and `snip_edges=true`. The Worker supplies complete PCM for each chunk, so the wrapper uses one-shot extraction. Upstream invariant checks remain enabled.

## Build

On Apple Silicon macOS with Node 24, pnpm dependencies, and Xcode Command Line Tools:

```sh
pnpm run build:native:fbank
```

The output is the ignored `native/fbank/build/Release/fbank.node`. The release path in `build:closed-pilot` copies the committed source closure into two clean temporary build roots, rebuilds and strips both outputs, requires byte equality and the pinned 141,448-byte SHA-256 `62c2b1077eefaa9ada40a9fdc4b8e6a0bfd248084336be130310dab7f57c4438`, then verifies the packed native inventory and license disclosure. It does not read the legacy FBank staging binary. The complete source build also rebuilds and signs the recording Helper ad hoc. Product acceptance remains a separate release gate.

