# Contributing

Issues and pull requests are welcome after the repository is public. This is a
free project maintained on a best-effort basis. There is no response-time,
release-schedule or continued-maintenance commitment.

## Report a problem

Include the plugin/package hash, DSH version, macOS version, architecture, model
mode, reproduction steps and a minimal content-free diagnostic. Prefer synthetic
audio. Do not post meeting audio/transcripts, databases, credentials, signing keys
or personal data in public issues. Do not publish a suspected credential exposure
or private meeting content; report its location without including the contents.

## Prepare a change

- Follow `AGENTS.md`, `CONTEXT.md` and the relevant product/spec boundaries.
- Discuss changes to the frozen recording, ASR, diarization or meeting contracts
  before implementing them. Keep fixes focused and reuse DSH public capabilities.
- Use Node 24 and the pinned pnpm version. Install with
  `pnpm install --frozen-lockfile`; run the smallest relevant tests, then
  `pnpm run check` and `git diff --check`. Real native/model/recording changes
  require the corresponding installed integration or probe evidence.
- Describe the problem, behavior change, evidence and remaining limitations in
  the pull request. Use concise conventional English commit subjects.
- Keep generated binaries, Helper Apps, package archives, models and private
  recordings out of Git. Preserve third-party license and attribution notices.

## Licensing and release authority

Project-owned contributions are submitted under Apache-2.0 unless explicitly
agreed otherwise. Third-party source retains its original terms and provenance;
do not relabel it as project-owned Apache-2.0 code. This follows the submission
terms in `LICENSE`, section 5; no separate CLA is required by this project.

Registry publication and repository visibility remain maintainer decisions.
Passing tests or merging a change does not by itself authorize a release.
