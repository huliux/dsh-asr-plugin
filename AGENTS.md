# Development guide

## Scope and ownership

Read README.md for supported installation and docs/development.md before changes.
Use CONTEXT.md for domain terms and docs/model-assets.md for model delivery.
The public repository contains current contracts and future development guidance.

DSH owns lifecycle, configuration, UI primitives, Tools/Approval, Jobs and
Subprocess. The plugin owns meeting persistence, managed audio, model delivery,
ASR/diarization, recording protocols and the native recording Helper. Use public
host seams; validate capability against the selected DSH version.

## Changes and evidence

- Keep changes focused and discuss recording/ASR/diarization contract changes first.
- Test observable behavior through public seams. Start with the smallest relevant
  tests, then run pnpm run check and git diff --check. Native and model changes
  require real build/inference evidence; recording changes require an installed
  artifact. Respect the test suite's explicit integration opt-in variables.
- Keep Worker processes free of network and database access. The Host coordinates
  models and meeting facts. Use DSH Subprocess for product child processes.
- Preserve existing meetings, model identities and active-run snapshots. Increment
  algorithmRevision when frozen processing behavior changes; update size/hash
  records when assets change. Never bypass the native reproducibility verifier.
- Use TypeScript ESM on Node 24 and the pinned pnpm lockfile. Reuse existing modules
  and platform/host capabilities before adding dependencies or abstractions.
- Use concise English identifiers, comments, filenames and conventional commits.
  Discuss work in the requester's language. Separate code and documentation commits.

## Privacy and release

Keep recordings, transcripts, databases, model weights, credentials, build outputs,
package archives and machine-specific configuration outside Git. Use synthetic
fixtures and content-free diagnostics. Preserve all upstream licenses, copyright,
modification notices and rebuild provenance.

Use isolated DSH_HOME directories and dynamic ports for automated acceptance.
Existing user profiles may be changed only with task-specific authorization.
Cleanup is limited to the operation's own temporary files and process trees.

Public releases require exact inventory/hash, license, model-mode, Helper
permission/capture and installed-host evidence. Source publication, model hosting
and npm publication are separate maintainer decisions. Keep private:true until
an explicitly reviewed npm artifact is ready. Preserve normal future Git history.
