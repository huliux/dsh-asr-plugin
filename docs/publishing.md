# Publishing a reviewed candidate

Publish only a reviewed public export. Do not publish a development checkout,
private source receipt, model archive, database, recording, or historical docs.
The development manifest intentionally retains `private: true`.

## Freeze and review

1. Review source/licenses, pinned native/Helper identities and installed behavior.
2. Qualify the exact package through the current DSH Plugins/CLI path. Record its
   hash, host/runtime versions, applicable recording/model modes, meeting reference
   and export Approval behavior. Signature checks are not permission acceptance.
3. Verify first-download handling and ordinary macOS permission recovery. Existing
   TCC grants and a synthetic update do not establish a fresh permission pass.
4. Scan the public source, reachable history and packed files for secrets/private
   data. Keep generated code binaries in the npm artifact and out of source Git.
5. Confirm the final package identity/version and public source destination before
   changing the release export's manifest. Remove `private` only in that reviewed
   export, then repack and qualify the resulting exact archive. This prepares a
   publishable candidate without authorizing an upload. The development checkout
   stays private, and the old archive hash no longer applies.

## Source and model delivery

The intended source repository is `huliux/dsh-asr-plugin`. Start its public history
from the reviewed source tree, retaining licenses and future development guidance.
Do not push the development checkout's history. Generated binaries belong in the
npm package. Model weights download directly from pinned upstream providers and
are not uploaded to GitHub Releases.

Qualify settings-page downloads against the fixed source inventory and installed
asset checks. Preserve source licenses and SHA-256 verification. Three weights
currently lack complete cross-provider coverage; record this as a known preview
limitation rather than claiming universal automatic fallback. Historical messages
can also show internal meeting links while identity/reference/export remain usable.
These limitations are accepted for the first preview and remain tracked.

Local base and punctuation archives are developer/offline alternatives. Build them
with this version's legal material, stage each exact archive, run doctor and exercise
base-only, both-installed/base-selected and enhanced modes. Do not upload these
local archives as release assets. An older code-paired archive can be incompatible
even when weights are unchanged.

Prepare source/code release assets and their SHA-256 checksums in a private draft.
Check the uploaded files by downloading and hashing them before the publication
decision. A private draft is not a public endpoint. After approval, publish the
reviewed source and release; no project-hosted model endpoint is required.

## Account and registry

Use npm's official registry for publication, regardless of the registry used to
install dependencies. The manifest fixes `publishConfig.registry` to
`https://registry.npmjs.org/`, `access` to `public`, and the prerelease tag to `next`.
Keep the pnpm `executableFiles` setting so the three Helper executables retain
execution permissions; npm CLI currently warns about this pnpm-specific setting.
Check the extracted archive modes rather than removing it to silence a warning.

```sh
npm whoami --registry=https://registry.npmjs.org/
npm publish /absolute/path/reviewed.tgz --dry-run --ignore-scripts \
  --registry=https://registry.npmjs.org/ --access=public --tag=next
```

A dry run validates packing output but does not prove login, scope ownership,
2FA, release approval or permission behavior. In particular, npm can dry-run a
manifest that still contains `private: true`. Never treat that as publishability.

For a personal first release, use interactive login and account 2FA rather than
introducing a stored automation token. Do not commit credentials, print tokens or
send passwords/OTP values through issues. The account owner performs authentication
in their own terminal and browser:

```sh
npm login --auth-type=web --registry=https://registry.npmjs.org/
npm whoami --registry=https://registry.npmjs.org/
```

For this personal scope, the verified username must be `huliux`. Login credentials
are managed by npm in the owner's user configuration; do not copy that file into
source, archives, reports or screenshots. Login alone does not verify package-name
availability or authorize publication. Only after all acceptance items and the
publication decision are complete, publish the qualified exact archive with the
official registry, public access, `next`, and `--ignore-scripts`.

## After publication

Read the version and integrity from the official registry, then install the exact
version through DSH in an isolated profile. Verify that it matches the reviewed
artifact, that all three Helper executables remain executable, and that configuration,
model preparation, recording and meeting handoff still work. Do not claim registry
installation from a local tarball result. Keep `next` until a stable release is chosen.

See npm's [scoped package guide](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/),
[package metadata](https://docs.npmjs.com/cli/configuring-npm/package-json/), and
[publishing authentication requirements](https://docs.npmjs.com/requiring-2fa-for-package-publishing-and-settings-modification/).
