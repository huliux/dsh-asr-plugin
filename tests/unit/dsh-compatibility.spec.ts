import { readFileSync } from "node:fs";
import { evaluatePluginCompatibility } from "@deepseek-ai/dsh-app-boot";
import { describe, expect, it } from "vitest";

const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));

describe("DSH host admission", () => {
  it.each([
    "0.2.0-rc.2", "0.2.1-rc.2", "0.2.1-rc.3", "0.2.1-rc.5",
    "0.2.2-rc.1", "0.2.2-rc.2", "0.2.2",
  ])("admits supported host %s without exemptions", runtime => {
    expect(evaluatePluginCompatibility(manifest, {}, runtime)).toBeUndefined();
    // Older hosts decide from peers rather than engines.dsh.
    const { engines: _engines, ...peerManifest } = manifest;
    expect(evaluatePluginCompatibility(peerManifest, {}, runtime)).toBeUndefined();
  });

  it.each([
    "0.1.7-rc.2", "0.2.1-rc.4", "0.2.1-rc.6", "0.2.2-alpha.3", "0.2.3-alpha.1", "0.2.3", "0.3.0",
  ])("keeps host %s outside the declared contract", runtime => {
    expect(evaluatePluginCompatibility(manifest, {}, runtime)).toMatchObject({
      runtimeVersion: runtime, exempted: false,
      requirements: { "engines.dsh": manifest.engines.dsh },
    });
    const { engines: _engines, ...peerManifest } = manifest;
    expect(evaluatePluginCompatibility(peerManifest, {}, runtime)).toMatchObject({ runtimeVersion: runtime, exempted: false });
  });
});
