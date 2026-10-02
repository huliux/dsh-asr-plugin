import { expect, it, vi } from "vitest";

import { inspectRecordingHelperSignature } from "../../src/assets/recording-helper-signature.js";

const IDENTITY = "Developer ID Application: Example Publisher (EXAMPLE123)";

it("maps codesign facts for the app and every nested capture binary", async () => {
  const run = vi.fn(async (args: readonly string[]) => {
    const output = args.includes("-dvvv")
      ? `Identifier=com.bitbook.dsh-asr.recording-helper\nAuthority=${IDENTITY}\nTeamIdentifier=EXAMPLE123\nflags=0x10000(runtime)\n`
      : args.includes("--entitlements")
        ? "<plist><dict><key>com.apple.security.device.audio-input</key><true/></dict></plist>"
        : args.includes("-r-")
          ? "designated => identifier requirement"
          : "";
    return { status: 0, output };
  });

  const result = await inspectRecordingHelperSignature({
    appRoot: "/plugin/DSHASRRecordingHelper.app",
    componentPaths: ["Contents/MacOS/helper", "Contents/Helpers/mic"],
  }, run);

  expect(result).toMatchObject({
    deepValid: true,
    app: {
      valid: true,
      bundleIdentifier: "com.bitbook.dsh-asr.recording-helper",
      designatedRequirement: "identifier requirement",
      entitlements: ["com.apple.security.device.audio-input"],
      hardenedRuntime: true,
      adHoc: false,
      signingIdentity: IDENTITY,
      teamIdentifier: "EXAMPLE123",
    },
    components: [
      { relativePath: "Contents/MacOS/helper", valid: true },
      { relativePath: "Contents/Helpers/mic", valid: true },
    ],
  });
});

it("recognizes ad-hoc signatures that retain hardened runtime", async () => {
  const run = vi.fn(async (args: readonly string[]) => ({
    status: 0,
    output: args.includes("-dvvv")
      ? "Identifier=com.bitbook.dsh-asr.recording-helper\nSignature=adhoc\nTeamIdentifier=not set\nflags=0x10002(adhoc,runtime)\n"
      : args.includes("-r-") ? "# designated => cdhash H\"example\"" : "",
  }));

  const result = await inspectRecordingHelperSignature({
    appRoot: "/plugin/DSHASRRecordingHelper.app",
    componentPaths: ["Contents/Helpers/dsh-asr-capture-mic"],
  }, run);

  expect(result.app).toMatchObject({
    adHoc: true, hardenedRuntime: true, signingIdentity: null, teamIdentifier: null,
  });
  expect(result.components[0]).toMatchObject({
    adHoc: true, hardenedRuntime: true, signingIdentity: null, teamIdentifier: null,
  });
});
