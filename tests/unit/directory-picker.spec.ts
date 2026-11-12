import { describe, expect, it } from "vitest";

import type { SubprocessCollectedOutputs, SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec } from "@deepseek-ai/dsh-subprocess";
import {
  buildFolderPickerScript, classifyFolderPickerFailure, createMacDirectoryPicker, PickerError,
} from "../../src/transcripts/directory-picker.js";

function collected(text: string) {
  return { readFrom: () => ({ bytes: Buffer.byteLength(text), text }) };
}

interface Fake {
  readonly specs: SubprocessSpawnSpec[];
  readonly picker: ReturnType<typeof createMacDirectoryPicker>;
}

function fake(options: { stdout?: string; stderr?: string; exitCode?: number; timeout?: boolean }): Fake {
  const specs: SubprocessSpawnSpec[] = [];
  return {
    specs,
    picker: createMacDirectoryPicker({
      subprocess: {
        spawn(spec) {
          specs.push(spec);
          const outcome: SubprocessOutcome = { exitCode: options.exitCode ?? 0, signal: null };
          return {
            collected: {
              stdout: collected(options.stdout ?? ""), stderr: collected(options.stderr ?? ""),
            } as unknown as SubprocessCollectedOutputs,
            done: Promise.resolve(outcome),
            terminate() {},
            async waitForExit() { return options.timeout !== true; },
          } as unknown as SubprocessHandle;
        },
      },
    }),
  };
}

describe("macOS transcript folder picker", () => {
  it("builds an AppleScript that activates and returns a POSIX path", () => {
    expect(buildFolderPickerScript("Pick a folder")).toEqual([
      "-e", "activate",
      "-e", "set chosenFolder to choose folder with prompt \"Pick a folder\"",
      "-e", "POSIX path of chosenFolder",
    ]);
  });

  it("escapes quotes and adds a default location", () => {
    const script = buildFolderPickerScript('Pick "here"', "/Users/ex\\ample");
    expect(script[3]).toContain("default location (POSIX file \"/Users/ex\\\\ample\")");
    expect(script[3]).toContain("\\\"here\\\"");
  });

  it("separates a cancelled dialog from a real AppleScript failure", () => {
    expect(classifyFolderPickerFailure("execution error: User canceled. (-128)").cancelled).toBe(true);
    expect(classifyFolderPickerFailure("execution error: User cancelled (-128)").cancelled).toBe(true);
    expect(classifyFolderPickerFailure("execution error: Can't get POSIX path. (-1728)").cancelled).toBe(false);
  });

  it("returns the chosen folder", async () => {
    const test = fake({ stdout: "/Users/erwindassen/Transcripts\n" });
    await expect(test.picker.choose({ prompt: "Pick" })).resolves.toBe("/Users/erwindassen/Transcripts");
    expect(test.specs[0]?.argv.slice(0, 2)).toEqual(["/usr/bin/osascript", "-e"]);
  });

  it("resolves null when the dialog is cancelled", async () => {
    const test = fake({ exitCode: 1, stderr: "execution error: User canceled. (-128)" });
    await expect(test.picker.choose({ prompt: "Pick" })).resolves.toBeNull();
  });

  it("fails when osascript errors for another reason", async () => {
    const test = fake({ exitCode: 1, stderr: "execution error: something else (-1728)" });
    await expect(test.picker.choose({ prompt: "Pick" })).rejects.toBeInstanceOf(PickerError);
  });

  it("reports a timeout when the dialog never returns", async () => {
    const test = fake({ timeout: true, stdout: "/tmp" });
    await expect(test.picker.choose({ prompt: "Pick" })).rejects.toMatchObject({ kind: "timeout" });
  });

  it("rejects output that is not an absolute path", async () => {
    const test = fake({ stdout: "not-a-path" });
    await expect(test.picker.choose({ prompt: "Pick" })).rejects.toMatchObject({ kind: "failed" });
  });
});
