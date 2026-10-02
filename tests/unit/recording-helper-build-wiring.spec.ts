import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

interface PackageManifest {
  readonly scripts?: Readonly<Record<string, string>>;
}

async function readPackageManifest(): Promise<PackageManifest> {
  return JSON.parse(await readFile("package.json", "utf8")) as PackageManifest;
}

describe("recording helper build wiring", () => {
  it("keeps ordinary build independent from signing and ignored helper staging", async () => {
    const scripts = (await readPackageManifest()).scripts ?? {};

    expect(scripts.build).toBeDefined();
    expect(scripts.build).not.toMatch(/recording-helper|codesign|release-staging/);
    expect(scripts.check).toContain("pnpm run build");
    expect(scripts.check).not.toContain("build:native:recording-helper");
  });

  it("exposes one explicit rebuild and one real probe command", async () => {
    const scripts = (await readPackageManifest()).scripts ?? {};

    expect(scripts["build:native:recording-helper"])
      .toBe("node scripts/build-recording-helper.mjs");
    expect(scripts["probe:native:recording-helper"])
      .toContain("build:native:recording-helper");
    expect(scripts["probe:native:recording-helper"])
      .toContain("recording-helper-rebuild.spec.ts");
  });

  it("keeps source, license, signing inputs and protocol tests in the repository", async () => {
    const required = [
      "native/recording-helper/README.md",
      "native/recording-helper/UPSTREAM.md",
      "native/recording-helper/LICENSE.bitbook",
      "native/recording-helper/THIRD_PARTY_NOTICES.md",
      "native/recording-helper/app/Info.plist",
      "native/recording-helper/app/entitlements.plist",
      "native/recording-helper/app/main.m",
      "native/recording-helper/tests/protocol_tests.m",
    ];

    await expect(Promise.all(required.map((path) => readFile(path)))).resolves.toHaveLength(
      required.length,
    );
  });

  it("closes capture chunks on the same five-second product cadence", async () => {
    const source = await readFile("native/recording-helper/app/RHCaptureTrack.m", "utf8");

    expect(source).toContain('@"--chunk-size", @"5"');
    expect(source).not.toContain('@"--chunk-size", @"12"');
  });
});
