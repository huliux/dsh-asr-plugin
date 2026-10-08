# Contributing

## Issue reports

Include the plugin version, DSH version, macOS version, architecture, model mode
and steps to reproduce. Use synthetic audio and content-free diagnostics where
possible. Do not attach meeting audio, transcripts, databases, credentials,
signing material or other personal data.

For a suspected security vulnerability, follow [SECURITY.md](SECURITY.md) to
report privately. Other support and contact channels are in [SUPPORT.md](SUPPORT.md).

## Changes

Read [development](docs/development.md) and [the contributor instructions](AGENTS.md).
Discuss scope or processing-contract changes before implementation.
Keep patches focused and preserve existing data and license notices.

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm run check
git diff --check
```

Run the smallest relevant tests during development. Changes involving native code,
models, capture or host integration also require the applicable opt-in tests.
Use isolated test data directories and dynamic ports. Documentation changes need
link and consistency checks.

A pull request should describe the problem, resulting behavior, verification
environment and remaining limitations. Keep discussion respectful and technical.

## Licensing

Project-owned contributions are submitted under Apache-2.0, subject to section 5
of [LICENSE](LICENSE), unless explicitly agreed otherwise. No separate CLA is
required. Third-party material retains its original terms and provenance.

The project does not guarantee response times or a release schedule.
Merging a change does not authorize registry publication.
