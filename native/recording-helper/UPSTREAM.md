# Upstream provenance

- Repository: [kunji163/clerki](https://github.com/kunji163/clerki).
- Source revision: `44887f62f7b1a69fcc9d23583aa8df8f11898aca`.
- Source path: `audio-native/`.
- License snapshot SHA-256:
  `cddc25bce26226b4a04ed12839d9006b7a4403da9020ef6428ef7282a6567441`.

The capture-child compile closure is retained in `vendor/bitbook-audio/`.
The upstream BSD-2-Clause copyright and license are preserved.
See [third-party notices](THIRD_PARTY_NOTICES.md).

## Local modifications

- Set `AggregateDeviceConfig.isPrivate = true`.
- Guard Process Tap creation and destruction with macOS 14.2 availability.
- Close and flush system-audio WAV output before renaming a completed chunk.
- Read the current sample rate and channel count before consuming each system
  input buffer. Close the old-format tail and recreate the converter when the
  input format changes.
- Use Bitbook product names and C++ namespaces, and normalize trailing whitespace.

The application wrapper, command/event journal, chunk promotion and watchdog
are project-owned code. Upstream application services and UI are excluded.
