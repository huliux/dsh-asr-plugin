# Development reference

## Build environment

Use Node.js 24 and pnpm 10.33.2, as declared in `package.json`.
Install dependencies from `pnpm-lock.yaml`.
The native build pins `node-gyp` 12.4.0; dependency install-script permissions
are declared in `pnpm-workspace.yaml`.

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm run check
pnpm run build:closed-pilot
```

`build` generates TypeScript and client outputs.
`build:closed-pilot` additionally compiles native add-ons, builds and ad-hoc signs
the recording Helper, and verifies package contents. It requires no Developer ID
credentials or model weights. The script name is retained for compatibility.
The TypeScript build alone does not produce a complete recording package.
Run `build` before the first `check` in a new checkout to generate asset manifests.
`check` ends with an ordinary build that clears complete package outputs;
run `build:closed-pilot` afterward when preparing a recording package.

The FBank and hcluster hash checks require Apple clang 17.0.0
(`clang-1700.3.19.1`) and macOS SDK 26.0. Their resolver selects matching Command
Line Tools when `DEVELOPER_DIR` is unset and validates an explicit selection.
Helper builds use their own selected Apple toolchain. Record the actual compiler,
SDK and build environment when comparing Helper bytes.
A different compiler or SDK requires qualification; changing expected hashes
alone does not establish equivalence.

## Module contracts

DSH owns lifecycle, configuration, UI and localization, sessions and workspaces,
Tools/Approval, Jobs and Subprocess. The plugin owns managed audio, meeting
persistence, model delivery, recording protocols and ASR/speaker processing.

`src/index.ts` adapts DSH to `MeetingApplication`. The Repository stores meeting,
transcript-version and audio facts. A RecordingSession owns one live recording,
its tracks and provisional draft. Domain definitions are in [CONTEXT.md](../CONTEXT.md).

ONNX and native inference run in Workers. Batch Workers read managed audio and
verified assets and return results. Recording Workers may write only within their
session work root. Workers do not use network or SQLite.
Product child processes use DSH Subprocess. The signed Helper owns capture,
macOS permission interaction, chunks and watchdogs.

Meeting references contain explicit IDs in individual messages. Transcript
projections read a fixed version with stable cursors. Exports are deterministic
derivatives of committed text and require host approval for file writes.
Draft revisions are replaceable and separate from committed transcript versions.

## Model and recording lifecycle

Processing identity is captured for each attempt. Base mode preserves recognized
words and timestamps. Verified installed punctuation applies to new attempts;
damaged installed punctuation blocks preparation until repaired.
See [model assets](model-assets.md).

Recorder expansion can prepare models without creating a meeting, job or capture
session. Each start verifies runtime assets and performs fresh silent permission
admission before meeting or job creation. Permission results are not cached.
System-audio verification failure can reflect permission or output routing.

The recording model process can retain verified resources across sequential
meetings with the same engine, mode and installation roots. Audio readers, drafts,
VAD state, speaker clusters and result caches are fresh for every meeting.
Five idle minutes release resources; import or retranscription releases idle
recording resources. Failure or cancellation disposes the process.

Recording protocol v1 runs within model-process protocol v1. A matching
`session_end` settles inference, forwarding and cleanup before logical EOF and
outcome are exposed. Logical completion does not establish physical exit.
Host shutdown awaits process-tree exit before releasing the data-root lease.
Batch RUN v2 retains its physical-exit contract.

## Verification

`pnpm run check` runs type checking, ordinary tests and the TypeScript/client build.
Opt-in tests require the resources named by their environment gates.
Ordinary checks do not measure speech accuracy, recording permission behavior
or a complete supported OS matrix.

| Command | Additional resources |
| --- | --- |
| `pnpm run probe:native:fbank` | Qualified Apple toolchain |
| `pnpm run probe:native:recording-helper` | Apple toolchain |
| `pnpm run test:workers:real` | Verified models and applicable audio fixtures |
| `pnpm run probe:p1a-06` | Complete package |
| `pnpm run probe:p1c` | Isolated installed DSH artifact |

The FBank probe builds the complete package before comparing the packaged add-on
with an independent source rebuild. It needs no pre-existing `data/assets` tree.

Use synthetic fixtures, isolated `DSH_HOME` directories and dynamic ports.
Existing user profiles require task-specific authorization. Clean only owned
test resources. Keep recordings, transcripts, models, databases and generated
artifacts outside Git.

Changes to frozen processing algorithms or constants increment
`src/assets/manifest.json` `algorithmRevision`. Asset changes update sizes and
hashes. Retain vendored licenses, provenance and local modification notices.
The default Helper uses ad-hoc signing. A Developer ID build must configure and
verify its own identity and qualify the resulting permissions and update behavior.

Release preparation is specified in [publishing](publishing.md).
