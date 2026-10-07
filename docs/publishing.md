# Release preparation

This procedure applies to a specific source snapshot and package.
The development manifest retains `private: true` to prevent accidental publication.

## Source and package checks

1. Start from a reviewed source snapshot and lockfile. Exclude credentials, user
   data, model weights, generated binaries and machine-specific configuration.
2. Retain the project license and all required third-party copyright, license,
   provenance and modification notices.
3. Install dependencies in an isolated checkout with
   `pnpm install --frozen-lockfile`. Run `pnpm run build`, `pnpm run check`,
   `pnpm run build:closed-pilot` and `git diff --check`.
4. Prepare a separate release copy with the intended version and remove its
   `private` guard. Confirm that repository and issue URLs refer to accessible
   locations.
5. Run `pnpm pack --pack-destination /absolute/path/to/output` in that copy.
   Extract and inspect the archive; record its filename, size, SHA-256 and file
   inventory. Scan source, package contents and Git metadata for secrets and
   private material.
6. Verify the exact archive in an isolated DSH installation on the target
   platform. Include base and punctuation modes, meeting read/export behavior,
   permission admission, non-silent capture, permission recovery and updates.

Use the toolchain requirements in [development](development.md).
A source/signature check does not establish capture permission or real audio
output. Tests using a fixture do not establish recognition accuracy for other
input conditions. Record the tested host, OS, hardware, model identities and
the scope of each check.

Evidence can apply to a subsequent package only when the relevant bytes,
identities and environment remain unchanged and that correspondence is verified.
Rebuild or requalify changed components. Preserve the tested archive and its
inventory; publication must use those exact bytes.

## Model and Helper distribution

Models are obtained separately from pinned upstream sources. Keep weights out
of Git, npm and GitHub Releases. Model archives require matching compatibility
metadata, checksums and legal material; see [model assets](model-assets.md).

Public source builds produce an ad-hoc signed Helper. Developer ID signing and
notarization are optional distribution choices requiring separate credential,
signature, permission and update verification. Credentials stay outside source
and published artifacts.

## Publication and verification

Obtain maintainer authorization for the exact artifact and registry tag.
Publish from the verified archive with registry authentication and account
requirements satisfied. Stable versions use `latest`; prereleases use `next`.

After upload, verify anonymous registry metadata and integrity, download and
compare the archive bytes, and install the exact registry version in an isolated
DSH profile. Record any mismatch and stop further distribution until resolved.
Repository visibility and GitHub Release assets require their own review.
