# Contributor instructions

Read [README.md](README.md) for scope, [CONTEXT.md](CONTEXT.md) for terminology,
and [docs/development.md](docs/development.md) for module contracts.
Model changes also require [docs/model-assets.md](docs/model-assets.md).

- Use Node.js 24, TypeScript ESM and the pnpm version in `package.json`.
  Install from the lockfile. Reuse project, DSH and platform capabilities before
  adding a dependency.
- Test observable behavior through public boundaries. Run the smallest relevant
  tests, `pnpm run check` and `git diff --check`. Run `pnpm run build` once before
  the first check to generate asset manifests. Documentation changes require
  consistency and link checks. Native, model and recording changes require
  the applicable integration evidence.
- Preserve meeting data, processing identities and Worker protocol contracts.
  Keep Workers free of network and database access.
- Use synthetic fixtures and isolated `DSH_HOME` directories with dynamic ports.
  Modify existing user profiles only with task-specific authorization.
  Cleanup is limited to resources owned by the operation.
- Keep user data, credentials, models and generated artifacts outside Git.
  Preserve upstream attribution, licenses and modification notices.
- Use English identifiers, filenames and concise conventional commit subjects.
  Describe verification and limitations in pull requests.

Package preparation follows [docs/publishing.md](docs/publishing.md).
The development manifest retains `private: true`; release authorization applies
to a specific verified artifact.
