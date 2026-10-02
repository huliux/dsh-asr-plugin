# Development contracts

## Module ownership

`src/index.ts` adapts DSH to MeetingApplication. Repository owns persistent
meeting/version/audio facts. RecordingSession owns a live recording lifecycle,
track state and provisional draft. DSH owns sessions/workspaces, Jobs, Subprocess,
Tools/Approval, configuration persistence, UI primitives and localization.

ASR/diarization and ONNX/native execution live in Workers. Batch Workers read
managed audio/assets and return results; recording Workers may write only their
bounded session work root. Workers do not access network, SQLite or delete original
tracks. The native Helper owns capture, TCC, chunk delivery and watchdog behavior.

## Invariants

Meeting references are explicit IDs in individual messages, not persistent
session bindings. Agent projections retain a fixed transcript version and cursor
contract. Exports derive deterministically from committed text under host approval.
Draft revisions may change and are separate from committed transcript versions.
Model/mode identity is immutable for each attempt; configuration changes affect
future attempts only. Base mode retains recognized words/timestamps without
invented punctuation; optional punctuation requires valid assets and explicit enablement.

## Verification and release

Use package.json scripts and the lockfile as toolchain authority. Run the smallest
relevant tests and pnpm run check. The synthetic fixtures are safe to commit;
actual models/audio/databases remain ignored. Integration gates opt in to real
native/model/host resources and must name an installed artifact where required.
Use isolated DSH_HOME and dynamic ports; clean only your own resources.

Native output hashes are qualified under a specific compiler/SDK. New compiler
bytes or algorithm changes require qualification rather than updating constants
merely to bypass checks. Keep upstream sources, patch explanations and full
license texts. Preserve the Helper bundle ID and signed-tree/executable checks;
source/signature success is distinct from non-silent capture/permission evidence.

Before releasing, record the exact package/model hashes and inventory, perform
secret/private-content scanning and validate the real installation/client/model/
recording/permission paths. Publishing source, models and npm are separate actions.
Do not publish a candidate solely because engineering tests pass.

The optional Developer ID strategy uses neutral example publisher constants in
this source snapshot. A publisher choosing that route must configure the trusted
identity/team consistently in the build and verifier and qualify its artifact.
The default public ad-hoc build requires no such identity or credentials.

Real adapter tests opt in with DSH_RUN_NATIVE_ADAPTERS=1 and
DSH_RUN_VAD_MODEL=1 after verified assets are available in data/assets.
Ordinary check runs without local model weights or native build outputs.

## Publishing

Use the [reviewed candidate publishing guide](publishing.md). Source export, package
qualification and account authentication are separate checks; a pack/dry-run does
not authorize publication.
