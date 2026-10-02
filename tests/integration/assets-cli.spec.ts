import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runAssetsCli } from "../../src/cli/dsh-asr-assets.js";
import { buildModelPack } from "../../src/maintenance/model-pack-builder.js";

const MODEL_BYTES = Buffer.from("model bytes");
const MODEL_SHA256 = "9cb7487000bc86ac36ce83c4acfabe8878552be99572a6770f65ab1d048a5c48";
const MODEL_SET_FINGERPRINT =
  "ddc9cb78463f9cbd00a44d5feb30c5051fe93493fee52eddfc721c5684ecad17";
const roots: string[] = [];

async function writeFixtureFile(root: string, path: string, bytes: string | Buffer): Promise<void> {
  const destination = join(root, path);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, bytes);
}

function sourceFacts(id: string): Record<string, unknown> {
  return {
    id,
    sourceMode: "reuse",
    canonicalRepository: "https://example.com/source",
    revision: "a".repeat(40),
    sourcePath: `${id}.bin`,
    license: "MIT",
    licenseFiles: ["LICENSE"],
    attribution: "Test fixture",
    distribution: "public",
    transports: [{ kind: "canonical", url: "https://example.com/source.bin" }],
  };
}

function supplyChain(): Record<string, unknown> {
  const runtime = {
    platform: process.platform,
    architecture: process.arch,
    nodeMajor: Number(process.versions.node.split(".")[0]),
    addonNapi: 3,
    verifiedNapi: Number(process.versions.napi),
  };
  return {
    schemaVersion: 1,
    assets: [sourceFacts("example-model")],
    dependencies: [{
      ...sourceFacts("onnxruntime-node"),
      packageName: "onnxruntime-node",
      version: "1.19.2",
      integrity: `sha512-${"A".repeat(86)}==`,
      runtime,
      artifacts: [{ path: "bin/binding.node", byteLength: 1, sha256: "0".repeat(64) }],
      noticeFiles: [{
        path: "LICENSE",
        deliveryPath: "third_party/onnxruntime/LICENSE",
        byteLength: 1,
        sha256: "0".repeat(64),
      }],
    }],
  };
}

async function createFixture(): Promise<{
  modelPackPath: string;
  packageRoot: string;
  root: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "dsh-asr-assets-cli-"));
  roots.push(root);
  const packageRoot = join(root, "package");
  const sourceRoot = join(root, "source");
  const modelPackPath = join(root, "model-pack.tar");
  await writeFixtureFile(packageRoot, "dist/assets/manifest.json", JSON.stringify({
    schemaVersion: 2,
    algorithmRevision: "test-v1",
    assets: [{
      id: "example-model",
      kind: "model",
      relativePath: "models/example.onnx",
      byteLength: MODEL_BYTES.byteLength,
      sha256: MODEL_SHA256,
    }],
  }));
  await writeFixtureFile(
    packageRoot,
    "dist/assets/supply-chain.json",
    JSON.stringify(supplyChain()),
  );
  await writeFixtureFile(packageRoot, "LICENSE", "license\n");
  await writeFixtureFile(packageRoot, "THIRD_PARTY_NOTICES.md", "notices\n");
  await writeFixtureFile(sourceRoot, "models/example.onnx", MODEL_BYTES);
  await buildModelPack({ modelRoot: sourceRoot, outputPath: modelPackPath, packageRoot });
  return { modelPackPath, packageRoot, root };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("dsh-asr-assets CLI staging", () => {
  it("显式 data-dir 优先于 DSH_HOME，并输出 content-free staging 结果", async () => {
    const fixture = await createFixture();
    const explicitDataRoot = join(fixture.root, "explicit-data");
    const outcome = await runAssetsCli([
      "stage",
      fixture.modelPackPath,
      "--data-dir",
      explicitDataRoot,
    ], {
      env: { DSH_HOME: join(fixture.root, "harness-home") },
      packageRoot: fixture.packageRoot,
    });

    expect(outcome).toEqual({
      exitCode: 0,
      stderr: "",
      stdout: `${JSON.stringify({
        installed: true,
        modelSetFingerprint: MODEL_SET_FINGERPRINT,
      })}\n`,
    });
    expect(outcome.stdout).not.toContain(fixture.root);
  });

  it("未指定 data-dir 时遵循 DSH_HOME，并让 doctor 以报告和退出码表达未就绪", async () => {
    const fixture = await createFixture();
    const harnessHome = join(fixture.root, "harness-home");
    const options = { env: { DSH_HOME: harnessHome }, packageRoot: fixture.packageRoot };
    await runAssetsCli(["stage", fixture.modelPackPath], options);

    const outcome = await runAssetsCli(["doctor"], options);
    const report = JSON.parse(outcome.stdout) as {
      issues: Array<{ code: string; id: string }>;
      ready: boolean;
    };
    expect(outcome.exitCode).toBe(1);
    expect(outcome.stderr).toBe("");
    expect(report.ready).toBe(false);
    expect(report.issues).toContainEqual({
      action: "reinstall_dependency",
      code: "DEPENDENCY_MISSING",
      id: "onnxruntime-node",
    });
    expect(outcome.stdout).not.toContain(fixture.root);
  });
});

describe("dsh-asr-assets CLI 输入边界", () => {
  it("拒绝未知命令并保持错误不含本机路径", async () => {
    const fixture = await createFixture();
    const outcome = await runAssetsCli(["unknown"], {
      env: { DSH_HOME: join(fixture.root, "harness-home") },
      packageRoot: fixture.packageRoot,
    });

    expect(outcome).toEqual({
      exitCode: 2,
      stderr: "dsh-asr-assets: expected `stage <model-pack>` or `doctor`\n",
      stdout: "",
    });
    expect(outcome.stderr).not.toContain(fixture.root);
  });
});
