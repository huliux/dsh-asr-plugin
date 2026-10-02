# Model assets

The base set contains fixed VAD, ASR, speaker embedding and support files; the
optional set adds punctuation. src/assets/manifest.json defines exact bytes and
SHA-256. src/assets/supply-chain.json records canonical upstream repositories,
immutable revisions and license terms. Keep weights out of Git/npm code bundles.

Schema-2 archives contain packKind, pack/model compatibility fingerprints, an
asset inventory and code-paired legal material. stageModelPack validates archive
members and extracted files before atomic promotion. Corrupt/incompatible or
cancelled staging retains the last valid installation; doctor reports each group.

For a matching archive downloaded or assembled locally:

```sh
dsh plugin --profile PROFILE exec dsh-asr-assets stage /absolute/path/base.tar
dsh plugin --profile PROFILE exec dsh-asr-assets doctor
# Optional; does not enable punctuation.
dsh plugin --profile PROFILE exec dsh-asr-assets stage /absolute/path/punctuation.tar
```

Use --data-dir with the same directory if the plugin has a custom data_dir.
A raw user-selected model directory is never the runtime installation contract.
Use the plugin version and checksums supplied with a project archive; do not mix
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

The settings page selects direct-only or direct-first with fallback. New installs
allow fallback through hf-mirror.com; custom HTTP/HTTPS forward proxies are
optional and cannot contain credentials. Neither system nor DSH global proxy
settings are inherited. ModelScope is always direct. A VPN or transparent gateway
can still control the network beneath the application.

For each fixed file, try reviewed ModelScope copies, then reviewed Hugging Face
copies, then the selected Hugging Face mirror/forward proxy. Current coverage includes both ModelScope and Hugging Face for speaker embedding
and five ASR/punctuation support files. VAD has Hugging Face plus mirror; the
ASR and punctuation quantized weights still have ModelScope only.
Same-name weights are not interchangeable: new counterparts must match exact
size/SHA-256 before being added. Full cross-site coverage is a remaining task.
Network/HTTP failures can retry another source; unsafe redirects, byte/hash
mismatch or cancellation stop. Failed-attempt bytes do not count toward progress.
