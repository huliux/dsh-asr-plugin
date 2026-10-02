export const REBUILT_FBANK_MANIFEST = Object.freeze({
  id: "fbank-native",
  kind: "native",
  relativePath: "native/darwin-arm64/fbank.node",
  byteLength: 141_448,
  sha256: "62c2b1077eefaa9ada40a9fdc4b8e6a0bfd248084336be130310dab7f57c4438",
  runtime: Object.freeze({
    platform: "darwin",
    architecture: "arm64",
    nodeMajor: 24,
    napi: 10,
  }),
});

export const HCLUSTER_MANIFEST = Object.freeze({
  id: "hcluster-native",
  kind: "native",
  relativePath: "native/darwin-arm64/hcluster.node",
  byteLength: 131_536,
  sha256: "ebc22050bd12065c9fb03d90ed7ed39b481edb65559cedd88af80200c8e63688",
  runtime: Object.freeze({
    platform: "darwin",
    architecture: "arm64",
    nodeMajor: 24,
    napi: 10,
  }),
});

export const CLOSED_PILOT_NATIVE_ASSETS = Object.freeze([
  REBUILT_FBANK_MANIFEST,
  HCLUSTER_MANIFEST,
]);
