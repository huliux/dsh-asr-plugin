import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  doctorRecordingHelper,
  type RecordingHelperSignatureFacts,
} from "../../src/assets/runtime-assets.js";

const BUNDLE_ID = "com.bitbook.dsh-asr.recording-helper";
const TEAM_ID = "EXAMPLE123";
const SIGNING_IDENTITY =
  "Developer ID Application: Example Publisher (EXAMPLE123)";
const REQUIREMENT = `identifier "${BUNDLE_ID}" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and certificate leaf[subject.OU] = ${TEAM_ID}`;
const COMPONENTS = {
  helper: {
    minimumOS: "13.5",
    relativePath: "Contents/MacOS/DSHASRRecordingHelper",
  },
  microphone: {
    minimumOS: "13.5",
    relativePath: "Contents/Helpers/dsh-asr-capture-mic",
  },
  systemAudio: {
    minimumOS: "14.2",
    relativePath: "Contents/Helpers/dsh-asr-capture-system",
  },
} as const;

const temporaryRoots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
  })));
});

interface FixtureOptions {
  readonly distribution?: "closed-pilot-only" | "public";
  readonly signingMode?: "ad-hoc" | "developer-id";
}

async function createFixture(options: FixtureOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), "dsh-recording-helper-assets-"));
  temporaryRoots.push(root);
  const appRoot = join(root, "DSHASRRecordingHelper.app");
  const manifestPath = join(root, "manifest.json");
  const entries = [
    ["Contents/Info.plist", "info"],
    [COMPONENTS.helper.relativePath, "helper"],
    [COMPONENTS.microphone.relativePath, "microphone"],
    [COMPONENTS.systemAudio.relativePath, "system"],
    ["Contents/_CodeSignature/CodeResources", "signature"],
  ] as const;
  const files = [];
  for (const [relativePath, value] of entries) {
    const path = join(appRoot, relativePath);
    const bytes = Buffer.from(value);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    files.push({
      relativePath,
      byteLength: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  files.sort((left, right) => left.relativePath < right.relativePath
    ? -1
    : left.relativePath > right.relativePath ? 1 : 0);
  const treeHash = createHash("sha256");
  for (const file of files) {
    treeHash.update(`${file.relativePath}\0${file.byteLength}\0${file.sha256}\n`);
  }
  const developerID = options.signingMode !== "ad-hoc";
  await writeFile(manifestPath, JSON.stringify({
    schemaVersion: 1,
    source: {
      project: "Bitbook",
      historicalRepository: "https://github.com/kunji163/clerki.git",
      revision: "44887f62f7b1a69fcc9d23583aa8df8f11898aca",
      sourcePath: "audio-native/",
      license: "BSD-2-Clause",
    },
    product: {
      bundleIdentifier: BUNDLE_ID,
      architecture: "arm64",
      minimumOS: "13.5",
      systemAudioMinimumOS: "14.2",
      distribution: options.distribution ?? "closed-pilot-only",
      signingMode: developerID ? "developer-id" : "ad-hoc",
      signingIdentity: developerID ? SIGNING_IDENTITY : null,
      teamIdentifier: developerID ? TEAM_ID : null,
      designatedRequirement: developerID ? REQUIREMENT : null,
      permissionProbeEligible: developerID || options.distribution === "public",
      hardenedRuntime: true,
      notarization: "not-verified",
      entitlements: {
        app: ["com.apple.security.device.audio-input"],
        microphone: ["com.apple.security.device.audio-input"],
        systemAudio: [],
      },
    },
    components: COMPONENTS,
    treeSha256: treeHash.digest("hex"),
    files,
  }));
  return { appRoot, manifestPath };
}

function validSignatureFacts(): RecordingHelperSignatureFacts {
  return {
    deepValid: true,
    app: {
      adHoc: false,
      bundleIdentifier: BUNDLE_ID,
      designatedRequirement: REQUIREMENT,
      entitlements: ["com.apple.security.device.audio-input"],
      hardenedRuntime: true,
      signingIdentity: SIGNING_IDENTITY,
      teamIdentifier: TEAM_ID,
      valid: true,
    },
    components: Object.entries(COMPONENTS).map(([name, { relativePath }]) => ({
      adHoc: false,
      entitlements: name === "systemAudio"
        ? []
        : ["com.apple.security.device.audio-input"],
      hardenedRuntime: true,
      relativePath,
      signingIdentity: SIGNING_IDENTITY,
      teamIdentifier: TEAM_ID,
      valid: true,
    })),
  };
}

describe("recording helper 资产 doctor", () => {
  it("只让完整且同一 Developer ID 链的 Bitbook helper 通过录音权限门", async () => {
    const fixture = await createFixture();

    await expect(doctorRecordingHelper({
      ...fixture,
      inspectSignature: async () => validSignatureFacts(),
    })).resolves.toMatchObject({
      ready: true,
      signingMode: "developer-id",
      checks: [
        { id: "recording-helper-app-tree", status: "ok", hashStatus: "ok" },
        { id: "recording-helper-signature", status: "ok", hashStatus: "not_checked" },
      ],
      issues: [],
    });
  });

  it("明确拒绝 ad-hoc 制品通过产品权限门", async () => {
    const fixture = await createFixture({ signingMode: "ad-hoc" });
    const facts = validSignatureFacts();
    const adHocFacts: RecordingHelperSignatureFacts = {
      ...facts,
      app: {
        ...facts.app,
        adHoc: true,
        designatedRequirement: null,
        signingIdentity: null,
        teamIdentifier: null,
      },
      components: facts.components.map((component) => ({
        ...component,
        adHoc: true,
        signingIdentity: null,
        teamIdentifier: null,
      })),
    };

    await expect(doctorRecordingHelper({
      ...fixture,
      inspectSignature: async () => adHocFacts,
    })).resolves.toMatchObject({
      ready: false,
      signingMode: "ad-hoc",
      issues: [{
        id: "recording-helper-signature",
        code: "HELPER_ADHOC_ONLY",
        action: "rebuild_or_reinstall_helper",
      }],
    });
  });

  it("接受公开分发的逐层 ad-hoc 签名，同时保留 bundle 与权限检查", async () => {
    const fixture = await createFixture({ signingMode: "ad-hoc", distribution: "public" });
    const facts = validSignatureFacts();
    const adHocFacts: RecordingHelperSignatureFacts = {
      ...facts,
      app: { ...facts.app, designatedRequirement: "cdhash example",
        adHoc: true, signingIdentity: null, teamIdentifier: null },
      components: facts.components.map((component) => ({
        ...component, adHoc: true, signingIdentity: null, teamIdentifier: null,
      })),
    };

    await expect(doctorRecordingHelper({
      ...fixture, inspectSignature: async () => adHocFacts,
    })).resolves.toMatchObject({ ready: true, signingMode: "ad-hoc", issues: [] });

    await expect(doctorRecordingHelper({
      ...fixture,
      inspectSignature: async () => ({
        ...adHocFacts,
        components: adHocFacts.components.map((component) => ({
          ...component, adHoc: false,
        })),
      }),
    })).resolves.toMatchObject({
      ready: false,
      issues: [{ code: "HELPER_SIGNATURE_IDENTITY_MISMATCH" }],
    });
  });

  it("在调用签名检查前拒绝被替换的嵌入 binary", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.appRoot, COMPONENTS.systemAudio.relativePath), "replaced");
    const inspectSignature = vi.fn(async () => validSignatureFacts());

    await expect(doctorRecordingHelper({
      ...fixture,
      inspectSignature,
    })).resolves.toMatchObject({
      ready: false,
      issues: [{
        id: "recording-helper-app-tree",
        code: "HELPER_HASH_MISMATCH",
      }],
    });
    expect(inspectSignature).not.toHaveBeenCalled();
  });

  it("拒绝缺失、额外或未纳入签名链的嵌入代码", async () => {
    const fixture = await createFixture();
    const facts = validSignatureFacts();
    await mkdir(join(fixture.appRoot, "Contents/Resources"), { recursive: true });
    await writeFile(join(fixture.appRoot, "Contents/Resources/unpinned"), "extra");

    await expect(doctorRecordingHelper({
      ...fixture,
      inspectSignature: async () => facts,
    })).resolves.toMatchObject({
      ready: false,
      issues: [{ code: "HELPER_TREE_MISMATCH" }],
    });

    await rm(join(fixture.appRoot, "Contents/Resources/unpinned"));
    await expect(doctorRecordingHelper({
      ...fixture,
      inspectSignature: async () => ({
        ...facts,
        components: facts.components.slice(0, 2),
      }),
    })).resolves.toMatchObject({
      ready: false,
      issues: [{ code: "HELPER_SIGNATURE_INVALID" }],
    });
  });

  it("拒绝错误 bundle、Team、designated requirement 或 hardened runtime", async () => {
    const fixture = await createFixture();
    const facts = validSignatureFacts();

    await expect(doctorRecordingHelper({
      ...fixture,
      inspectSignature: async () => ({
        ...facts,
        app: { ...facts.app, hardenedRuntime: false },
      }),
    })).resolves.toMatchObject({
      ready: false,
      issues: [{ code: "HELPER_SIGNATURE_IDENTITY_MISMATCH" }],
    });
  });

  it("拒绝同 Team 的 Apple Development 证书冒充 Developer ID", async () => {
    const fixture = await createFixture();
    const facts = validSignatureFacts();
    const developmentIdentity =
      "Apple Development: Local Developer (EXAMPLE123)";

    await expect(doctorRecordingHelper({
      ...fixture,
      inspectSignature: async () => ({
        ...facts,
        app: { ...facts.app, signingIdentity: developmentIdentity },
        components: facts.components.map((component) => ({
          ...component,
          signingIdentity: developmentIdentity,
        })),
      }),
    })).resolves.toMatchObject({
      ready: false,
      issues: [{ code: "HELPER_SIGNATURE_IDENTITY_MISMATCH" }],
    });
  });

  it("拒绝 App 或嵌入 binary 获得清单外权限", async () => {
    const fixture = await createFixture();
    const facts = validSignatureFacts();

    await expect(doctorRecordingHelper({
      ...fixture,
      inspectSignature: async () => ({
        ...facts,
        app: {
          ...facts.app,
          entitlements: [
            ...facts.app.entitlements,
            "com.apple.security.network.client",
          ],
        },
      }),
    })).resolves.toMatchObject({
      ready: false,
      issues: [{ code: "HELPER_SIGNATURE_IDENTITY_MISMATCH" }],
    });
  });
});
