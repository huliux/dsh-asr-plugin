# dsh-asr-plugin

English | [简体中文](README.zh-CN.md)

Local meeting transcription for DeepSeek Harness on Apple Silicon macOS. Import
WAV/M4A/MP3 or capture microphone and system audio, obtain timestamps and speaker
labels, and explicitly reference meetings in DSH for Agent reading and export.

**Preview:** experimental prereleases use npm's `next` tag. Check the npm package
versions for availability; preview limitations are listed below. The source
repository is not public during this npm-only preview.
The qualified host is DSH 0.2.0-rc.2 with a Node 24 runtime. Other versions require
acceptance. Microphone capture requires macOS 13.5+, system capture macOS 14.2+;
those platform API minima are not a claim of testing every macOS release.

## Installation and first use

Use DSH's native Plugins page with `@huliux/dsh-asr-plugin@next`, or the profile CLI
with an exact published version. A checksum-verified local release package is an
alternative input:

```sh
dsh plugin --profile PROFILE add --ignore-scripts @huliux/dsh-asr-plugin@VERSION
# Alternative: verified release package.
dsh plugin --profile PROFILE add --ignore-scripts /absolute/path/plugin.tgz
```

The prebuilt plugin includes FBank/hcluster and an ad-hoc signed recording Helper;
ordinary users do not compile them or need Python/Homebrew. DSH resolves npm
runtime dependencies. Model weights are separate: the required base set is about
278 MiB; optional punctuation is about 274 MiB. Base mode works without punctuation.

Open the plugin's configuration in the native Plugins page. Click **Download base
models**; progress shows downloaded bytes, verification and installation. The
optional punctuation action downloads a separate pack. Downloads prefer verified
domestic direct sources, then other direct sources where available. **Proxy**
enables hf-mirror.com after direct failures; a custom HTTP/HTTPS proxy is also
available. Save connection changes before downloading. See [model assets](docs/model-assets.md)
for source coverage and proxy limitations.

Models download directly from pinned ModelScope/Hugging Face sources; GitHub
Releases do not contain model weights. Downloads verify sizes/SHA-256 before atomic
installation. No model download starts merely by enabling the plugin. You can
cancel, retry, or reopen the page to observe the Host task. Installing punctuation
does not enable it: valid assets and an explicit save are required. Missing or
invalid punctuation cannot be enabled. Settings apply to new attempts, preserving
existing transcripts. Developers can alternatively stage a verified archive;
see [model assets](docs/model-assets.md).

The Helper is not notarized. Follow macOS security prompts and separately grant
microphone/system-audio permissions. Updates may require reauthorization. Do not
disable global platform protections.

If “No system sound received yet” appears, start audio playback first; natural
silence does not establish a permission denial. If playback remains silent, enable
DSH Recorder (some cached macOS labels show `DSHASRRecordingHelper`) in System
Settings → Privacy & Security → Screen & System Audio Recording → System Audio
Recording Only. Follow any macOS quit/reopen prompt, then switch system audio off
and on in the plugin, or stop and retry. Enable microphone access separately in
Microphone. First-download and permission behavior are qualified only for the
actual installation route and macOS tested.

Select/create a DSH session, start recording or ask the Agent to import an absolute
local audio path. Use the native `@` picker to reference a meeting. Ask the Agent
to read, compare or export it; file writes use DSH Approval. Meetings are global
plugin facts, not session/workspace attachments. Processing is local after model
preparation; LLM use follows the host's selected provider and policy.

## Known preview limitations

- Three fixed model weights do not yet have verified copies on both providers.
  Existing sources work, but a source outage may require retrying later or building
  a matching local archive. Same-named weights cannot be substituted.
- A meeting reference can display its internal link in sent
message history. The picker and composer show the meeting label, and the reference
still supplies the meeting ID. Presentation support requires a host extension;
this remains a known limitation.

## Build and contribute

The source repository is currently private. The commands and source-document links
below apply to maintainers with source access; a public source release is a separate
step. npm installation does not require building from source.

Install Node 24, pinned pnpm and Apple Command Line Tools. Reproducible native
hashes are currently qualified with Apple clang 17 / macOS SDK 26. Verify the
selected toolchain rather than bypassing a hash failure.

```sh
pnpm install --frozen-lockfile
pnpm run check
DEVELOPER_DIR=/Library/Developer/CommandLineTools pnpm run build:closed-pilot
pnpm pack --pack-destination /path/to/output
```

`build:closed-pilot` is a historical command name: it now rebuilds native/Helper
code from this source, signs the Helper ad hoc and verifies the extracted package.
No developer signing credentials, model weights or private staging inputs are
needed for that code build. Plain TypeScript build alone does not make a complete
recording package. Compiler/toolchain changes require new native qualification.

See [development](docs/development.md), [AGENTS.md](AGENTS.md), [CONTEXT.md](CONTEXT.md)
and [CONTRIBUTING.md](CONTRIBUTING.md). The project is free and maintained on a
best-effort basis, without guaranteed response times or continued maintenance.
Project-owned source uses Apache-2.0. Retain the separate terms, attribution and
modification notices in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), `third_party/`
and vendored native sources. Generated binaries/models/private data stay out of Git.
