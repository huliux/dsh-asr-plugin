# Third-party notices

## Bitbook `audio-native`

The capture-child compile closure under `vendor/bitbook-audio/` is derived from
Bitbook revision `44887f62f7b1a69fcc9d23583aa8df8f11898aca` and is
redistributed under the BSD 2-Clause License in `LICENSE.bitbook`.

The system capture implementation uses public Apple Core Audio Process Tap
APIs. Source comments credit the AudioTee global-tap configuration as a design
reference; no AudioTee source or binary is vendored here.

Apple system frameworks are linked from macOS and are not redistributed.
