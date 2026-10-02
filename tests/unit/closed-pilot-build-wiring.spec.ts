import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

interface PackageManifest {
  readonly files?: readonly string[];
  readonly publishConfig?: { readonly executableFiles?: readonly string[] };
  readonly scripts?: Readonly<Record<string, string>>;
}

async function readPackageManifest(): Promise<PackageManifest> {
  return JSON.parse(await readFile("package.json", "utf8")) as PackageManifest;
}

describe("closed-pilot release command wiring", () => {
  it("keeps ordinary build independent from ignored legacy staging", async () => {
    const manifest = await readPackageManifest();
    const build = manifest.scripts?.build;

    expect(build).toBeDefined();
    expect(build).not.toMatch(/closed-pilot|materialize-closed-pilot|release-staging/);
    expect(manifest.scripts?.check).toContain("pnpm run build");
    expect(manifest.scripts?.check).not.toContain("build:closed-pilot");
  });

  it("materializes and inventories natives only in the explicit pilot build", async () => {
    const manifest = await readPackageManifest();
    const pilotBuild = manifest.scripts?.["build:closed-pilot"] ?? "";

    expect(pilotBuild).toMatch(/^pnpm run build/);
    expect(pilotBuild).toContain("materialize-closed-pilot-natives.mjs");
    expect(pilotBuild).toContain("build-recording-helper.mjs --public-release");
    expect(pilotBuild).toContain("verify-closed-pilot-pack.mjs");
    expect(pilotBuild.indexOf("materialize-closed-pilot-natives.mjs"))
      .toBeLessThan(pilotBuild.indexOf("verify-closed-pilot-pack.mjs"));
    expect(pilotBuild.indexOf("build-recording-helper.mjs --public-release"))
      .toBeLessThan(pilotBuild.indexOf("verify-closed-pilot-pack.mjs"));
  });

  it("routes real P1a/P1b product probes through the pilot build", async () => {
    const scripts = (await readPackageManifest()).scripts ?? {};
    for (const name of ["probe:p1a-04", "probe:p1a-05", "probe:p1a-06", "probe:p1a"]) {
      expect(scripts[name], name).toContain("pnpm run build:closed-pilot");
    }
    if (scripts["probe:p1b"] !== undefined) {
      expect(scripts["probe:p1b"]).toContain("pnpm run build:closed-pilot");
    }
  });

  it("keeps P1c proof bound to its explicit installed archive", async () => {
    const probe = (await readPackageManifest()).scripts?.["probe:p1c"];

    expect(probe).toBe("node scripts/probe-p1c.mjs");
    expect(probe).not.toContain("build");
  });

  it("reads committed recording results through meeting_get in the installed probe", async () => {
    const source = await readFile("scripts/release/probe-installed-host.mjs", "utf8");
    const recordMeeting = source.slice(
      source.indexOf("async function recordMeeting"),
      source.indexOf("async function exerciseRecording"),
    );
    const afterStop = recordMeeting.slice(recordMeeting.indexOf("const stopped"));

    expect(afterStop).toContain("meetingGet(host, started.meeting_id)");
    expect(afterStop).not.toContain('"meeting_live_get"');
  });

  it("removes supply-side maintenance and internal probes from npm packlist", async () => {
    const files = (await readPackageManifest()).files ?? [];

    expect(files).toContain("!dist/maintenance/**");
    expect(files).toContain("!dist/probes/**");
  });

  it("preserves every signed Helper executable without exposing internal bins", async () => {
    const manifest = await readPackageManifest();

    expect(manifest.publishConfig?.executableFiles).toEqual([
      "dist/recording-helper/DSHASRRecordingHelper.app/Contents/MacOS/DSHASRRecordingHelper",
      "dist/recording-helper/DSHASRRecordingHelper.app/Contents/Helpers/dsh-asr-capture-mic",
      "dist/recording-helper/DSHASRRecordingHelper.app/Contents/Helpers/dsh-asr-capture-system",
    ]);
  });

});
