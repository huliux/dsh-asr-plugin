import { describe, expect, it } from "vitest";
import type { SubprocessCollectedOutputs, SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec } from "@deepseek-ai/dsh-subprocess";
import {
  AudioDeviceError,
  createAudioDeviceService,
  parseAudioDeviceInventory,
} from "../../src/recording/audio-devices.js";
import type { RecordingHelperSubprocess } from "../../src/recording/helper-client.js";

const APP = "/Applications/test/DSHASRRecordingHelper.app";
const INVENTORY = {
  schema_version: 1,
  default_input_uid: "AppleUSBAudioEngine:Insta360:Insta360 Link 2C:144000:3",
  default_output_uid: "AppleUSBAudioEngine:QTIL:Ruark MR1:ABCDEF0123456789:1",
  devices: [
    {
      uid: "AppleUSBAudioEngine:Insta360:Insta360 Link 2C:144000:3",
      name: "Insta360 Link 2C",
      input_channels: 1,
      output_channels: 0,
      default_input: true,
      default_output: false,
    },
    {
      uid: "BuiltInMicrophoneDevice",
      name: "MacBook Pro Microphone",
      input_channels: 1,
      output_channels: 0,
      default_input: false,
      default_output: false,
    },
  ],
};

function collected(text: string) {
  return { readFrom: () => ({ bytes: text.length, lossy: false, nextOffset: text.length, text }) };
}

function fake(options: { stdout?: string; exitCode?: number; timeout?: boolean }) {
  const specs: SubprocessSpawnSpec[] = [];
  const subprocess: RecordingHelperSubprocess = {
    spawn(spec) {
      specs.push(spec);
      const outcome: SubprocessOutcome = { exitCode: options.exitCode ?? 0, signal: null };
      return {
        collected: {
          stdout: collected(options.stdout ?? ""), stderr: collected(""),
        } as unknown as SubprocessCollectedOutputs,
        done: Promise.resolve(outcome),
        terminate() {},
        async waitForExit() { return options.timeout !== true; },
      } as unknown as SubprocessHandle;
    },
  };
  return { specs, service: createAudioDeviceService({ resolveApp: async () => APP, subprocess }) };
}

describe("parseAudioDeviceInventory", () => {
  it("reads the helper payload into camelCase devices", () => {
    const inventory = parseAudioDeviceInventory(INVENTORY);
    expect(inventory.defaultInputUID).toBe(INVENTORY.default_input_uid);
    expect(inventory.defaultOutputUID).toBe(INVENTORY.default_output_uid);
    expect(inventory.devices).toHaveLength(2);
    expect(inventory.devices[0]).toEqual({
      uid: INVENTORY.devices[0]!.uid,
      name: "Insta360 Link 2C",
      inputChannels: 1,
      outputChannels: 0,
      defaultInput: true,
      defaultOutput: false,
    });
  });

  it("accepts a missing default device", () => {
    const inventory = parseAudioDeviceInventory({ ...INVENTORY, default_input_uid: null });
    expect(inventory.defaultInputUID).toBeNull();
  });

  it("rejects an unknown schema version", () => {
    expect(() => parseAudioDeviceInventory({ ...INVENTORY, schema_version: 2 }))
      .toThrow(AudioDeviceError);
  });

  it("rejects malformed device rows", () => {
    expect(() => parseAudioDeviceInventory({
      ...INVENTORY, devices: [{ ...INVENTORY.devices[0]!, input_channels: -1 }],
    })).toThrow(AudioDeviceError);
    expect(() => parseAudioDeviceInventory({
      ...INVENTORY, devices: [{ ...INVENTORY.devices[0]!, uid: "" }],
    })).toThrow(AudioDeviceError);
  });

  it("rejects a non-array device list", () => {
    expect(() => parseAudioDeviceInventory({ ...INVENTORY, devices: {} })).toThrow(AudioDeviceError);
  });
});

describe("createAudioDeviceService", () => {
  it("spawns the helper __devices subcommand directly", async () => {
    const { specs, service } = fake({ stdout: JSON.stringify(INVENTORY) });
    const inventory = await service.list();
    expect(inventory.devices).toHaveLength(2);
    expect(specs).toHaveLength(1);
    expect(specs[0]?.argv).toEqual([`${APP}/Contents/MacOS/DSHASRRecordingHelper`, "__devices"]);
    expect(specs[0]?.cwd).toBe("/Applications/test");
  });

  it("reports DEVICES_UNAVAILABLE when the helper fails", async () => {
    const { service } = fake({ stdout: JSON.stringify(INVENTORY), exitCode: 70 });
    await expect(service.list()).rejects.toMatchObject({ code: "DEVICES_UNAVAILABLE" });
  });

  it("reports DEVICES_UNAVAILABLE when the helper times out", async () => {
    const { service } = fake({ stdout: JSON.stringify(INVENTORY), timeout: true });
    await expect(service.list()).rejects.toMatchObject({ code: "DEVICES_UNAVAILABLE" });
  });

  it("reports DEVICES_UNAVAILABLE on non-JSON output", async () => {
    const { service } = fake({ stdout: "not json" });
    await expect(service.list()).rejects.toMatchObject({ code: "DEVICES_UNAVAILABLE" });
  });

  it("coalesces concurrent reads into one helper spawn", async () => {
    const { specs, service } = fake({ stdout: JSON.stringify(INVENTORY) });
    const [first, second] = await Promise.all([service.list(), service.list()]);
    expect(first).toEqual(second);
    expect(specs).toHaveLength(1);
  });
});
