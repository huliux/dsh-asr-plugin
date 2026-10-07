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
4. Confirm `keywords`, `repository`, `homepage` and `bugs` identify this public
   project. Prepare a stable release with the command below. It makes a temporary
   package copy, removes only that copy's `private` guard, sets its version and
   pins its installation examples to that version. The output directory must be
   new and outside the checkout; existing releases are never overwritten.
5. The command verifies the built package and the final archive, then writes
   the `.tgz`, `SHA256SUMS` and `release.json` with its source identity and inventory.
   Extract and inspect the archive; record its filename, size, SHA-256 and file
   inventory. Scan source, package contents and Git metadata for secrets and
   private material.
6. Verify the exact archive in an isolated DSH installation on the target
   platform. Include base and punctuation modes, meeting read/export behavior,
   permission admission, non-silent capture, permission recovery and updates.

```sh
pnpm run pack:release --version 0.1.2 --output /absolute/path/to/new-release-directory
```

The version is an example; choose a previously unpublished stable version.
Keep the archive immutable after qualification. Recompute its checksum to confirm
the reviewed bytes before publishing. The command does not upload to a registry,
create a GitHub Release, or alter any DSH profile. Preview packages still use a
separate reviewed copy with a prerelease version.

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

Use the same verified `.tgz` as a GitHub Release attachment, alongside its
`SHA256SUMS`. Include the tested DSH/Node/platform versions, changes, model
preparation and signing limitations in release notes. Automatic source archives
are separate downloads. After publishing, align the source manifest and both
README installation examples with the new stable version, confirm the release
asset hash, and verify community catalogs map the repository to npm's `latest`.
See [distribution](distribution.md) for user-facing channels.
