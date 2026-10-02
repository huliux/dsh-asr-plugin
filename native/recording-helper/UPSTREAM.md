# Upstream provenance

- Repository: `https://github.com/kunji163/clerki.git`
- Source revision: `44887f62f7b1a69fcc9d23583aa8df8f11898aca`
- Source path: `audio-native/`
- Imported on: 2026-08-30
- License snapshot SHA-256: `cddc25bce26226b4a04ed12839d9006b7a4403da9020ef6428ef7282a6567441`

Bitbook and this product are both owned by 上海会搞定智能科技有限公司,
which has authorized this source transplant. The upstream copyright and
BSD-2-Clause notice remain preserved.

`vendor/bitbook-audio/` is the compile closure used by the two capture children.
It is copied from the revision above. Behavioral changes are limited to:

- `AggregateDeviceConfig.isPrivate = true`;
- an explicit macOS 14.2 availability guard around Process Tap
  creation/destruction;
- closing/flushing the system-audio WAV before renaming a temporary chunk to
  its closed filename;
- refreshing each system input stream's current sample rate and channel count
  before consuming its buffer, closing the old-format tail and rebuilding the
  converter when the format changes without a stream-count change.

The V2 real-device probe proved that the private aggregate prevents a
force-killed system capture child from leaving a public device behind. The WAV
publication ordering fixes an observed race where the Helper could inspect a
renamed chunk before `ExtAudioFileDispose` finalized its header. Product-facing
names and C++ namespaces were mechanically updated to Bitbook, and trailing
whitespace was normalized. The format-change repair has a native regression
that simulates only the HAL edge while using real CoreAudio WAV conversion:
16 kHz mono to 48 kHz stereo preserves both duration and tone frequency.

Bitbook was formerly named Clerki. The historical repository URL above is kept
only as immutable provenance; product-facing names, vendored paths and source
namespaces use `Bitbook`/`bitbook`.

The app wrapper, command/event journal, chunk promotion and watchdog are new
code in this project. Electron services, settings, global temporary-directory
recovery, realtime transcription and UI code are intentionally not imported.
