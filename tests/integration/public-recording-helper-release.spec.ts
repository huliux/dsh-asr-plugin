import { spawnSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { verifyRecordingHelperAssets } from "../../src/assets/recording-helper-assets.js";
import { inspectRecordingHelperSignature } from "../../src/assets/recording-helper-signature.js";

const suite = describe.skipIf(process.env.DSH_RUN_PUBLIC_HELPER_RELEASE !== "1");
const root = resolve("dist/recording-helper");
const appRoot = resolve(root, "DSHASRRecordingHelper.app");
const manifestPath = resolve(root, "manifest.json");

suite("source-built public recording helper", () => {
  it("verifies the exact ad-hoc App tree and nested signatures", async () => {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      product: { distribution: string; signingMode: string };
      components: Record<string, { relativePath: string; minimumOS: string }>;
    };
    expect(manifest.product).toMatchObject({ distribution: "public", signingMode: "ad-hoc" });
    const result = await verifyRecordingHelperAssets({
      appRoot, manifestPath,
      inspectSignature: (input) => inspectRecordingHelperSignature(input, async (args, cwd) => {
        const result = spawnSync("/usr/bin/codesign", [...args], { cwd, encoding: "utf8" });
        return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
      }),
    });
    expect(result).toMatchObject({ signingMode: "ad-hoc", teamIdentifier: null });
    for (const component of Object.values(manifest.components)) {
      expect(component.relativePath).toMatch(/^Contents\/(?:MacOS|Helpers)\//u);
      const path = resolve(appRoot, component.relativePath);
      const output = spawnSync("/usr/bin/vtool", ["-show-build", path], { encoding: "utf8" });
      expect(output.status).toBe(0);
      expect(output.stdout).toContain(`minos ${component.minimumOS}`);
      expect((await stat(path)).mode & 0o111).toBe(0o111);
    }
  });

  it("rejects invalid launch input before requesting recording permissions", () => {
    const binary = resolve(appRoot, "Contents/MacOS/DSHASRRecordingHelper");
    const result = spawnSync(binary, ["/tmp", "invalid-meeting-id"], { stdio: "ignore" });
    expect(result.status).toBe(64);
  });
});
