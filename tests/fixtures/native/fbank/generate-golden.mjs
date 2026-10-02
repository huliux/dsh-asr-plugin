import { createHash } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const expectedSha256 = "3f0b35fb52cd6f8e7d2a00e37e002a2be606750a5ae5b8d7836931de9319c567";
const binaryArgument = process.argv[2];
if (binaryArgument === undefined) {
  throw new Error("Pass the legacy fbank.node path used to create migration golden v1");
}
const binaryPath = resolve(repositoryRoot, binaryArgument);
const outputPath = resolve(dirname(fileURLToPath(import.meta.url)), "golden-v1.json");
const temporaryOutputPath = `${outputPath}.${process.pid}.tmp`;

function createSamples() {
  const samples = new Float32Array(16_000);
  for (let index = 0; index < samples.length; index += 1) {
    const time = index / 16_000;
    const perturbation = ((index * 17) % 101 - 50) / 5_000;
    samples[index] = 0.35 * Math.sin(2 * Math.PI * 220 * time)
      + 0.17 * Math.cos(2 * Math.PI * 710 * time)
      + perturbation;
  }
  return samples;
}

const binary = await readFile(binaryPath);
const sha256 = createHash("sha256").update(binary).digest("hex");
if (binary.byteLength !== 156_160 || sha256 !== expectedSha256) {
  throw new Error("Legacy fbank.node size or SHA-256 does not match");
}
const nativeModule = createRequire(import.meta.url)(binaryPath);
const result = nativeModule.fbank(createSamples());
if (!(result?.data instanceof Float32Array) || !Array.isArray(result.dims)) {
  throw new Error("fbank binary returned an invalid result");
}
const golden = `${JSON.stringify({
  schemaVersion: 1,
  sourceBinary: {
    byteLength: binary.byteLength,
    sha256,
  },
  input: { generator: "deterministic-sine-v1", sampleRate: 16_000, sampleCount: 16_000 },
  dims: result.dims,
  data: Array.from(result.data),
})}\n`;
try {
  await writeFile(temporaryOutputPath, golden, { flag: "wx" });
  await rename(temporaryOutputPath, outputPath);
} finally {
  await rm(temporaryOutputPath, { force: true });
}
