import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  doctorRecordingHelper,
  type RecordingHelperSignatureInspectionInput,
} from "../../src/assets/runtime-assets.js";

interface HelperManifest {
  readonly components: {
    readonly helper: { readonly minimumOS: "13.5"; readonly relativePath: string };
    readonly microphone: { readonly minimumOS: "13.5"; readonly relativePath: string };
    readonly systemAudio: { readonly minimumOS: "14.2"; readonly relativePath: string };
  };
  readonly files: readonly {
    readonly byteLength: number;
    readonly relativePath: string;
    readonly sha256: string;
  }[];
  readonly product: {
    readonly bundleIdentifier: string;
    readonly designatedRequirement: string | null;
    readonly entitlements: {
      readonly app: readonly ["com.apple.security.device.audio-input"];
      readonly microphone: readonly ["com.apple.security.device.audio-input"];
      readonly systemAudio: readonly [];
    };
    readonly hardenedRuntime: true;
    readonly permissionProbeEligible: boolean;
    readonly signingIdentity: string | null;
    readonly signingMode: "ad-hoc" | "developer-id";
    readonly teamIdentifier: string | null;
  };
  readonly schemaVersion: 1;
  readonly source: {
    readonly historicalRepository: "https://github.com/kunji163/clerki.git";
    readonly project: "Bitbook";
    readonly revision: string;
  };
  readonly treeSha256: string;
}

const suite = describe.skipIf(process.env.DSH_RUN_RECORDING_HELPER_REBUILD !== "1");
const stagingRoot = resolve("data/release-staging/recording-helper");
const appRoot = resolve(stagingRoot, "DSHASRRecordingHelper.app");

async function manifest(): Promise<HelperManifest> {
  return JSON.parse(await readFile(resolve(stagingRoot, "manifest.json"), "utf8")) as HelperManifest;
}

function minimumOS(path: string): string {
  const output = execFileSync("/usr/bin/vtool", ["-show-build", path], { encoding: "utf8" });
  const match = /minos (\d+\.\d+)/u.exec(output);
  if (match?.[1] === undefined) throw new Error(`missing minos in ${path}`);
  return match[1];
}

function signatureOutput(path: string, requirements = false): string {
  const args = requirements ? ["-d", "-r-", path] : ["-dvvv", path];
  const result = spawnSync("/usr/bin/codesign", args, { encoding: "utf8" });
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

function teamIdentifier(details: string): string | null {
  const value = /TeamIdentifier=([^\r\n]+)/u.exec(details)?.[1]?.trim() ?? null;
  return value === "not set" ? null : value;
}

function signingIdentity(details: string): string | null {
  return /^Authority=([^\r\n]+)/mu.exec(details)?.[1]?.trim() ?? null;
}

function entitlements(path: string): string[] {
  const result = spawnSync("/usr/bin/codesign", ["-d", "--entitlements", ":-", path], {
    encoding: "utf8",
  });
  const plist = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return [...plist.matchAll(/<key>([^<]+)<\/key>\s*<true\s*\/>/gu)]
    .map((match) => match[1]!)
    .sort();
}

async function inspectSignature({
  appRoot: inspectedAppRoot,
  componentPaths,
}: RecordingHelperSignatureInspectionInput) {
  const appDetails = signatureOutput(inspectedAppRoot);
  const appRequirement = signatureOutput(inspectedAppRoot, true);
  return {
    deepValid: spawnSync("/usr/bin/codesign", [
      "--verify", "--deep", "--strict", inspectedAppRoot,
    ]).status === 0,
    app: {
      adHoc: /Signature=adhoc/u.test(appDetails),
      valid: spawnSync("/usr/bin/codesign", [
        "--verify", "--strict", inspectedAppRoot,
      ]).status === 0,
      bundleIdentifier: /Identifier=([^\r\n]+)/u.exec(appDetails)?.[1]?.trim() ?? null,
      teamIdentifier: teamIdentifier(appDetails),
      designatedRequirement: /designated => (.+)/u.exec(appRequirement)?.[1] ?? null,
      entitlements: entitlements(inspectedAppRoot),
      hardenedRuntime: /flags=.*\([^\r\n)]*\bruntime\b[^\r\n)]*\)/u.test(appDetails),
      signingIdentity: signingIdentity(appDetails),
    },
    components: componentPaths.map((relativePath) => {
      const path = resolve(inspectedAppRoot, relativePath);
      const details = signatureOutput(path);
      return {
        adHoc: /Signature=adhoc/u.test(details),
        relativePath,
        valid: spawnSync("/usr/bin/codesign", ["--verify", "--strict", path]).status === 0,
        entitlements: entitlements(path),
        teamIdentifier: teamIdentifier(details),
        hardenedRuntime: /flags=.*\([^\r\n)]*\bruntime\b[^\r\n)]*\)/u.test(details),
        signingIdentity: signingIdentity(details),
      };
    }),
  };
}

suite("可重建 recording helper", () => {
  it("ships localized permission copy without changing the bundle identity", async () => {
    const plist = (path: string) => JSON.parse(execFileSync("/usr/bin/plutil", [
      "-convert", "json", "-o", "-", path,
    ], { encoding: "utf8" })) as Record<string, unknown>;
    const base = plist(resolve(appRoot, "Contents/Info.plist"));
    const english = plist(resolve(appRoot, "Contents/Resources/en.lproj/InfoPlist.strings"));
    const chinese = plist(resolve(appRoot, "Contents/Resources/zh-Hans.lproj/InfoPlist.strings"));
    expect(base).toMatchObject({ CFBundleExecutable: "DSHASRRecordingHelper",
      CFBundleIdentifier: "com.bitbook.dsh-asr.recording-helper", CFBundleName: "DSH Recorder",
      CFBundleDevelopmentRegion: "en" });
    expect(english.CFBundleDisplayName).toBe("DSH Recorder");
    expect(chinese).toEqual({ CFBundleDisplayName: "DSH 录音助手", CFBundleName: "DSH 录音助手",
      NSMicrophoneUsageDescription: "录制你的声音，用于本地转写。你可以随时关闭麦克风。",
      NSAudioCaptureUsageDescription: "录制电脑播放的声音，用于本地转写。你可以随时关闭系统音频。" });
  });

  it("accepts a canonical macOS temporary root before rejecting unsafe control storage", async () => {
    const temporary = await mkdtemp(resolve(tmpdir(), "recording-helper-root-"));
    try {
      const meetingId = randomUUID();
      const root = resolve(await realpath(temporary), meetingId);
      const outside = resolve(temporary, "outside");
      await mkdir(root, { mode: 0o700 });
      await mkdir(outside, { mode: 0o700 });
      // Unsafe control storage stops initialization before permissions or capture.
      await symlink(outside, resolve(root, "control"));
      const executable = resolve(appRoot, "Contents/MacOS/DSHASRRecordingHelper");
      const result = spawnSync(executable, [root, meetingId, String(process.pid)], {
        stdio: "ignore", timeout: 5_000,
      });

      expect(result.status).toBe(70);
      expect(await readdir(outside)).toEqual([]);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("rejects linked, traversed and shared session roots before capture", async () => {
    const temporary = await mkdtemp(resolve(tmpdir(), "recording-helper-unsafe-root-"));
    try {
      const meetingId = randomUUID();
      const base = await realpath(temporary);
      const root = resolve(base, meetingId);
      const linkParent = resolve(base, "linked");
      await mkdir(root, { mode: 0o700 });
      await symlink(base, linkParent);
      const executable = resolve(appRoot, "Contents/MacOS/DSHASRRecordingHelper");
      for (const input of [`${linkParent}/${meetingId}`, `${base}/../${base.split("/").at(-1)}/${meetingId}`]) {
        const result = spawnSync(executable, [input, meetingId, String(process.pid)], {
          stdio: "ignore", timeout: 5_000,
        });
        expect(result.status).toBe(64);
      }
      await chmod(root, 0o755);
      expect(spawnSync(executable, [root, meetingId, String(process.pid)], {
        stdio: "ignore", timeout: 5_000,
      }).status).toBe(64);
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("逐文件固定 source、hash、大小并通过严格嵌套签名验证", async () => {
    const value = await manifest();

    expect(value.schemaVersion).toBe(1);
    expect(value.source).toMatchObject({
      project: "Bitbook",
      historicalRepository: "https://github.com/kunji163/clerki.git",
      revision: "44887f62f7b1a69fcc9d23583aa8df8f11898aca",
    });
    expect(value.product.bundleIdentifier).toBe("com.bitbook.dsh-asr.recording-helper");
    expect(value.treeSha256).toMatch(/^[0-9a-f]{64}$/u);
    for (const file of value.files) {
      const bytes = await readFile(resolve(appRoot, file.relativePath));
      expect({
        byteLength: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      }, file.relativePath).toEqual({ byteLength: file.byteLength, sha256: file.sha256 });
    }
    expect(spawnSync("/usr/bin/codesign", [
      "--verify", "--deep", "--strict", "--verbose=4", appRoot,
    ]).status).toBe(0);
  });

  it("把 mic 与 system 的真实最低系统边界写进二进制和 manifest", async () => {
    const value = await manifest();
    const expected = {
      helper: { minimumOS: "13.5", relativePath: "Contents/MacOS/DSHASRRecordingHelper" },
      microphone: {
        minimumOS: "13.5",
        relativePath: "Contents/Helpers/dsh-asr-capture-mic",
      },
      systemAudio: {
        minimumOS: "14.2",
        relativePath: "Contents/Helpers/dsh-asr-capture-system",
      },
    } as const;

    expect(value.components).toEqual(expected);
    for (const component of Object.values(expected)) {
      expect(minimumOS(resolve(appRoot, component.relativePath))).toBe(component.minimumOS);
    }
  });

  it("明确拒绝把 ad-hoc 构建冒充产品权限制品", async () => {
    const value = await manifest();

    if (value.product.signingMode === "ad-hoc") {
      expect(value.product.teamIdentifier).toBeNull();
      expect(value.product.permissionProbeEligible).toBe(false);
    } else {
      expect(value.product.teamIdentifier).toBe("EXAMPLE123");
      expect(value.product.signingIdentity).toBe(
        "Developer ID Application: Example Publisher (EXAMPLE123)",
      );
      expect(value.product.designatedRequirement).toContain(
        "certificate leaf[field.1.2.840.113635.100.6.1.13]",
      );
      expect(value.product.permissionProbeEligible).toBe(true);
    }
    expect((await stat(resolve(stagingRoot, "manifest.json"))).mode & 0o777).toBe(0o600);
  });

  it("以 RuntimeAssets 录音 doctor 校验 App 树、嵌套签名与 identity", async () => {
    const value = await manifest();
    const report = await doctorRecordingHelper({
      appRoot,
      manifestPath: resolve(stagingRoot, "manifest.json"),
      inspectSignature,
    });

    if (value.product.signingMode === "developer-id") {
      expect(report).toMatchObject({ ready: true, signingMode: "developer-id", issues: [] });
    } else {
      expect(report).toMatchObject({
        ready: false,
        signingMode: "ad-hoc",
        issues: [{ code: "HELPER_ADHOC_ONLY" }],
      });
    }
  });

  it("在启动 capture 前拒绝非规范 session root 与 meeting id", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "recording-helper-invalid-"));
    try {
      const executable = resolve(appRoot, "Contents/MacOS/DSHASRRecordingHelper");
      const result = spawnSync(executable, [root, "not-a-meeting-id"], {
        stdio: "ignore",
      });

      expect(result.status).toBe(64);
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
