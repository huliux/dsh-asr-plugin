# Upstream provenance

- Project: [`csukuangfj/kaldi-native-fbank`](https://github.com/csukuangfj/kaldi-native-fbank)
- Tag:`v1.20.0`
- Commit:`fdc395d24dc3e9e48ae1df4f0f6860f6b7d4870e`
- `kaldi-native-fbank/csrc` tree:`abf1fed0830cc74c2ae1f8196f317a0cf27878dd`
- Imported: 2026-08-28
- License: Apache-2.0; see `LICENSE` in this directory.

The following upstream compile/include closure supplies the fixed FBank algorithm:

- `feature-fbank.{cc,h}`, `feature-functions.{cc,h}`, `feature-window.{cc,h}`
- `fftsg.cc`, `kaldi-math.{cc,h}`, `log.{cc,h}`
- `mel-computations.{cc,h}`, `rfft.{cc,h}`

Import recipe:

```sh
git clone https://github.com/csukuangfj/kaldi-native-fbank.git
git -C kaldi-native-fbank checkout fdc395d24dc3e9e48ae1df4f0f6860f6b7d4870e
# Copy the listed csrc files into the vendor csrc directory
cp kaldi-native-fbank/LICENSE native/fbank/vendor/kaldi-native-fbank/LICENSE
```

The project-owned Node-API wrapper is `native/fbank/src/fbank_napi.cpp` and is not part of the upstream snapshot.

## Local modification

`csrc/mel-computations.cc` rounds 16 separate float products before adding them in input order for each full group; the tail uses fused multiply-add. Preserve this qualified accumulation order and record any future vendor changes here.
