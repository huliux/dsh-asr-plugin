# Model assets

The base set contains fixed VAD, ASR, speaker embedding and support files; the
optional set adds punctuation. src/assets/manifest.json defines exact bytes and
SHA-256. src/assets/supply-chain.json records canonical upstream repositories,
immutable revisions and license terms. Keep weights out of Git/npm code bundles.

## Prepare models from settings

Open the plugin configuration in DSH Plugins and download the required base set
(about 278 MiB). Optional punctuation is about 274 MiB and is used automatically
for new tasks after verified installation. Download progress, verification, installation,
cancellation and retry are shown in the page. Models come directly from pinned
ModelScope/Hugging Face sources; GitHub Releases do not host model weights.
The downloader verifies each asset and uses the same atomic staging contract below.

## Developer and offline preparation

Schema-2 archives contain packKind, pack/model compatibility fingerprints, an
asset inventory and code-paired legal material. stageModelPack validates archive
members and extracted files before atomic promotion. Corrupt/incompatible or
cancelled staging retains the last valid installation; doctor reports each group.

For a matching archive downloaded or assembled locally, use an installed Web profile.
Desktop profiles are managed by the app; use plugin settings for downloads and diagnostics.

```sh
dsh plugin --profile web exec dsh-asr-assets stage /absolute/path/base.tar
dsh plugin --profile web exec dsh-asr-assets doctor
# Optional; enables punctuation for new tasks after verification.
dsh plugin --profile web exec dsh-asr-assets stage /absolute/path/punctuation.tar
```

Use --data-dir with the same directory if the plugin has a custom data_dir.
A raw user-selected model directory is never the runtime installation contract.
Use the matching plugin version and checksums for a locally built archive; do not mix
code-paired archives from another release. A valid installed model directory does
not need to be replaced solely because archive legal metadata changes. If staging
reports `MODEL_PACK_INCOMPATIBLE`, obtain a matching archive or use the configuration
page's download action. A failed stage preserves the previous valid installation.
Developers can collect the fixed upstream files in modelRoot and build archives:

```sh
pnpm run build:model-pack -- /path/to/base.tar /path/to/modelRoot --pack base
pnpm run build:model-pack -- /path/to/punctuation.tar /path/to/modelRoot --pack punctuation
```

This command rebuilds ordinary dist; run the complete native/Helper build before
packing a recording plugin afterward. Changing code-paired legal material requires
new model archives even when weight fingerprints are unchanged. All shipped model
licenses, attribution and modification declarations must remain available.

## Download connection

Downloads select the default sources automatically. The only connection option
is an optional HTTP/HTTPS forward proxy without embedded credentials. It applies
only to Hugging Face, after mirror and upstream connections fail. ModelScope and
HF-Mirror never use it. Legacy Direct/mirror choices use the default order; enabled
custom proxies are preserved. Previously disabled addresses remain disabled.
Clicking Download saves pending address changes first; validation or concurrency
failures prevent the download. Neither system nor DSH global proxy settings are
inherited. A VPN or transparent gateway can still control the underlying network.

For each fixed file, try reviewed ModelScope copies where available, then
HF-Mirror, Hugging Face and the configured Hugging Face forward proxy. VAD has no
ModelScope copy and starts at HF-Mirror. Current coverage includes both ModelScope and Hugging Face for speaker embedding
and five ASR/punctuation support files. VAD has Hugging Face plus mirror; the
ASR and punctuation quantized weights still have ModelScope only.
Same-name weights are not interchangeable: new counterparts must match exact
size/SHA-256 before being added. Full cross-site coverage is a remaining task.
Network/HTTP failures can retry another source; unsafe redirects, byte/hash
mismatch or cancellation stop. Failed-attempt bytes do not count toward progress.
Fully downloaded files are retained in a private per-pack cache after failure or
cancellation, checked again before reuse, and removed after successful installation.
Partial files restart; no HTTP range-resume guarantee is provided. ModelScope-only
failures offer retry without proxy guidance. No models are bundled in npm.

Mode is captured at task start. Active tasks and committed transcripts keep their
identity. Missing optional models select base; a damaged installed punctuation
pack blocks new tasks until repaired. Legacy punctuation_enabled values are
accepted for configuration compatibility but no longer select the product mode.
