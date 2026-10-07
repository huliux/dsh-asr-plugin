# Recording Helper

A signed macOS application supervises independently controlled microphone and
system-audio capture children. It writes completed 16 kHz mono PCM WAV chunks
and content-free control records within the session root supplied by the host.
Native stdout and stderr are drained with bounded memory; they are not persisted.

## Build

```sh
pnpm run build:closed-pilot
DSH_RUN_PUBLIC_HELPER_RELEASE=1 pnpm exec vitest run tests/integration/public-recording-helper-release.spec.ts
```

The complete package build compiles the application and capture children from
source into `dist/recording-helper/`. Children in `Contents/Helpers/` are signed
first, followed by the outer application, using `codesign -s -`.
Signature and inventory checks run after package extraction.

The adjacent generated manifest records source revision, bundle identity,
architecture, minimum OS, entitlements, designated requirement, sizes and SHA-256.
These checks establish artifact identity; they do not establish recording
permission or non-silent capture. The public build requires no signing credentials.

## Process contract

LaunchServices starts the application with three arguments:

```text
/usr/bin/open -n -W <app> --args <absolute-session-root> <meeting-uuid> <host-pid>
```

The Helper validates the host identity and same-user ownership before capture.
Its watchdog terminates capture children if the host or Helper disappears.
Startup cancellation uses `control/host-cancel.json`, bounded TERM/KILL handling
and registered process identities. Cleanup acknowledgement is written to
`host-cancelled.json`. The client awaits acknowledgement and LaunchServices exit;
terminating the `open` process alone does not establish application exit.

Control records must be same-user regular files with validated schemas.
An invalid registry or missing cleanup acknowledgement remains an explicit failure.

## Permissions and signal observation

Microphone APIs require macOS 13.5 or later; system-audio Process Tap APIs require
macOS 14.2 or later. Permission purpose text and the display name are localized
in English and Simplified Chinese. The bundle identifier and executable name
remain stable. An ad-hoc code update can still require reauthorization.

For a requested system track, five seconds of entirely zero completed PCM before
the first signal sets `SYSTEM_AUDIO_NO_SIGNAL` while retaining track state `on`.
A nonzero chunk clears the advisory. Off/retry resets it. This observation is not
a permission verdict or audio-level measurement.

Release verification must cover first launch, permission prompts, non-silent
capture, ordinary Settings recovery and update behavior. Keep system security
protections enabled. Source, signature and permission checks have separate scopes.

Source origin and modifications are recorded in [UPSTREAM.md](UPSTREAM.md).
