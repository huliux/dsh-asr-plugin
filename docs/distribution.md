# Installation and release channels

This is an unofficial DeepSeek Harness plugin maintained by huliux.
Compatibility and recording limitations are stated in the
[README](../README.md) and [Chinese README](../README.zh-CN.md).

## npm installation

The public package is [@huliux/dsh-asr-plugin](https://www.npmjs.com/package/@huliux/dsh-asr-plugin).
Use the DSH Plugins page, or install the documented stable version into your
chosen Web profile:

```sh
dsh plugin --profile web add --ignore-scripts @huliux/dsh-asr-plugin@0.1.2
```

Published packages contain the compiled client, native add-ons and signed
recording Helper. Model weights are downloaded separately through settings.
`latest` selects the stable release; `next` selects a preview and can point to an
older version. Check the actual tags before choosing a preview:

```sh
npm view @huliux/dsh-asr-plugin dist-tags --json --registry=https://registry.npmjs.org/
```

Updating a package preserves the existing meeting/model data. Use one active
plugin host per data directory. A package change can require macOS permission
approval; follow the [recording guidance](../README.md#recording-and-meeting-access).

## GitHub package downloads

[GitHub Releases](https://github.com/huliux/dsh-asr-plugin/releases) provide
the same qualified `.tgz` uploaded to npm, with `SHA256SUMS` and release notes.
Choose an attached package archive. GitHub's automatic source ZIP/tar downloads
require the [complete build](development.md); they omit compiled recording assets.

Download the [0.1.2 package](https://github.com/huliux/dsh-asr-plugin/releases/download/v0.1.2/huliux-dsh-asr-plugin-0.1.2.tgz)
and [SHA256SUMS](https://github.com/huliux/dsh-asr-plugin/releases/download/v0.1.2/SHA256SUMS)
into one directory, verify them, and install the absolute
local archive path into your selected profile:

```sh
shasum -a 256 -c SHA256SUMS
dsh plugin --profile web add --ignore-scripts /absolute/path/to/qualified-package.tgz
```

Checksum verification detects changed bytes. Download both files from the
maintainer's release page. The archive excludes models and user data.

## Source, support and discovery

- [Source and contributions](https://github.com/huliux/dsh-asr-plugin) include the
  license, native provenance, build requirements and current development state.
- [Issues](https://github.com/huliux/dsh-asr-plugin/issues) are the support route.
  Include versions and content-free diagnostics; keep audio, transcripts, local
  databases and credentials private.
- [Support and contact](../SUPPORT.md) distinguishes public support from private
  inquiries; [the security policy](../SECURITY.md) provides private reporting routes.
- The [`dsh-plugin` topic](https://github.com/topics/dsh-plugin) helps discovery.
  Community catalogs review submissions independently. A topic or listing does
  not establish DeepSeek endorsement or additional platform compatibility.

## Maintainer delivery

Follow [publishing](publishing.md) for exact-artifact qualification and approval.
The release pack command produces an archive, checksums and a content inventory
without changing the development manifest or publishing anything. Reuse those
exact archive bytes for npm and GitHub; verify both downloads after upload.

Catalog submissions must use the public repository URL, the actual supported
platform and the tested DSH version. Confirm that npm's `latest.repository`
identifies this repository before relying on automated npm mapping. Submit the
catalog's maintained data file and let its maintainers review it.
