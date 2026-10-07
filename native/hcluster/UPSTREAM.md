# Upstream provenance

- Node-API wrapper: [kunji163/clerki](https://github.com/kunji163/clerki),
  revision `44887f62f7b1a69fcc9d23583aa8df8f11898aca`, path `hclust-cpp/`.
- Clustering implementation: [cdalitz/hclust-cpp](https://github.com/cdalitz/hclust-cpp),
  revision `d48fff6bba1199d80422cd37f5b635107a5a0c92`. This revision includes
  NaN handling changes after v1.2.

The retained source consists of the Node-API wrapper and its fastcluster
dependencies. Local modifications provide Node.js 24 / N-API 8 build configuration,
omit Release DWARF and route fallback logging to stderr to preserve Worker framing.

License and copyright information is in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
