# DSH ASR Recording Helper

This directory owns the rebuildable macOS recording boundary for P1c. One
signed app is the TCC-responsible process and supervises two independently
switchable capture children. Its durable outputs are closed 16 kHz mono PCM WAV
chunks and content-free control state inside the meeting root supplied by the
Host. Native stdout/stderr is drained in memory with a hard bound; no native log
file is persisted.

Build the source-based ad-hoc package candidate on Apple Silicon macOS:

```bash
pnpm run build:closed-pilot
DSH_RUN_PUBLIC_HELPER_RELEASE=1 pnpm exec vitest run tests/integration/public-recording-helper-release.spec.ts
```

Despite the historical script name, this package now rebuilds FBank, hcluster,
the Helper App and both capture tools from repository source. The Helper is
written to ignored `dist/recording-helper/`, signed inside-out with `codesign -s -`,
and checked again after npm packing and extraction. The capture tools live in
`Contents/Helpers/`, a standard nested-code directory. This is a package
candidate, not a completed public release or permission proof.

The separate closed-pilot staging build remains available:

```bash
pnpm run build:native:recording-helper
```

Its default ad-hoc output remains marked `closed-pilot-only` and is rejected by
the product verifier. The original Developer ID closed-pilot mode uses an
explicit identity:

```bash
DSH_RECORDING_HELPER_CODESIGN_IDENTITY="Developer ID Application: YOUR_NAME (YOUR_TEAM_ID)" \
  pnpm run build:native:recording-helper
```

That historical build writes to the ignored
`data/release-staging/recording-helper/` directory. The adjacent generated
manifest records source revision, bundle identity, architecture, minOS,
entitlements, designated requirement, file sizes and SHA-256 values. Signing is
inside-out: both capture children first, then the outer app.

The app is launched through LaunchServices with exactly three arguments:

```text
/usr/bin/open -n -W <app> --args <absolute-session-root> <meeting-uuid> <host-pid>
```

The Helper validates the Host process identity and same-user ownership before
starting capture. Its watchdog terminates both capture children when either the
Host or Helper identity disappears, including `SIGKILL` paths.

Startup timeouts and cancellation use `control/host-cancel.json`. The watchdog
also responds while the Host is alive: it stops the Helper with an identity
check and bounded TERM/KILL grace, then stops registered capture processes.
Only after cleanup does it publish `host-cancelled.json`. The client awaits that
acknowledgement and Launch Services exit before reporting startup failure;
terminating `open` alone cannot stop the detached App. Control records must be
private same-user regular files with strict schema validation. A malformed
registry or unavailable cleanup acknowledgement remains an explicit failure.

Permission purpose text and the short display name are localized in English
and Simplified Chinese. The bundle identifier and executable name remain
stable; localization does not establish permission continuity after an ad-hoc
code update. macOS owns the prompt's framing and permission decisions.

Source/signature checks do not certify capture permissions. Release acceptance must verify actual download/quarantine, first launch, microphone/system permission, non-silent capture, ordinary Settings recovery and updates. Ad-hoc identity can change with code bytes; measure update behavior.

Product support is Apple Silicon macOS 13.5+ for microphone capture. System
audio requires the Core Audio Process Tap available on macOS 14.2+. The Helper keeps
the other track available when one track is unavailable.

## System audio signal observation

Core Audio startup alone does not prove authorized or non-silent capture. The
existing validated PCM16 chunk inspection records only whether a chunk contains
a nonzero sample. Before the first signal in a requested system track, five
seconds of entirely zero closed PCM set `SYSTEM_AUDIO_NO_SIGNAL` in the existing
track diagnostic field while keeping state `on`. This is an advisory, not a TCC
verdict or capture failure. A nonzero chunk clears it without restarting capture;
off/retry resets the observation. Microphone silence is not given this system
warning. No private permission API or automatic security-setting change is used.

The client asks the user to play audio and, if necessary, enable the recorder in
ordinary macOS privacy settings and retry the system track. A supported source
can still produce silence for reasons other than permissions; do not label it
permission-denied or stop recording based on zero PCM. The existing animation
is a recording-status indicator, not an audio-level meter.
