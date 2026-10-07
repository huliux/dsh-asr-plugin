# Changelog

## 0.1.2 — Unreleased

- Enforce the actual HTTP peer's loopback address before dispatching recording
  RPCs, while preserving DSH authentication and Host/Origin checks. Reject
  oversized or malformed input and remove routes when the plugin is disposed.
- Link the npm package to its public source, documentation and issue tracker;
  add discovery keywords and installation/verification guidance in both languages.
- Include the domain vocabulary referenced by packaged developer documentation.
- Prepare verified release archives and checksums through `pack:release`, keeping
  the development publication guard and existing artifacts intact.

Inference algorithms, model weights, native add-ons and the public ad-hoc signed
Helper retain their qualified identities. Models are downloaded separately.
The supported target remains DSH 0.2.0-rc.2, Node.js 24 and Apple Silicon macOS.
