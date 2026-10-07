import { writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import type { SubprocessHandle, SubprocessSpawnSpec } from "@deepseek-ai/dsh-subprocess";
import { parseRecordingPermissions } from "../../src/recording/permission-contract.js";
import { expect, it, vi } from "vitest";
import { RecordingPermissionsService } from "../../src/recording/permissions.js";

it("does not accept an unverified system capture as permission to record", async () => {
  const service = new RecordingPermissionsService({
    resolveApp: async () => "/owned/helper.app",
    subprocess: { spawn: vi.fn() },
  });
  vi.spyOn(service, "test").mockResolvedValue({microphone:"granted",system:"unverified"});
  await expect(service.require()).rejects.toMatchObject({code:"SYSTEM_AUDIO_PERMISSION_REQUIRED"});
});

it.each([0, 1])("accepts a completed native report when open exits with %i and cleans its response root", async (exitCode) => {
  let command!: SubprocessSpawnSpec;
  const service = new RecordingPermissionsService({resolveApp:async()=>"/owned/helper.app",
    subprocess:{spawn:spec=>{
      command=spec;
      return {done:Promise.resolve({exitCode,signal:null}),terminate:vi.fn(),
        waitForExit:async()=>{await writeFile(join(spec.argv[6]!,"permissions.json"),JSON.stringify({microphone:"denied",system:"unverified"}));return true;},
      } as unknown as SubprocessHandle;
    }}});
  expect(await service.read()).toEqual({microphone:"denied",system:"unverified"});
  expect(command.argv.slice(0,6)).toEqual(["/usr/bin/open","-n","-W","/owned/helper.app","--args","__permissions"]);
  expect(command.argv.at(-1)).toBe("read");
  await expect(access(command.argv[6]!)).rejects.toMatchObject({code:"ENOENT"});
});

it("rejects malformed native permission reports rather than accepting truthy values", () => {
  for (const value of [{microphone:true,system:"verified"},{microphone:"granted",system:"verified",extra:1},
    {microphone:"granted",system:"granted"},
    {microphone:{toString:()=>"granted"},system:"verified"},null]) expect(()=>parseRecordingPermissions(value)).toThrow();
});

it.each([0, 1])("rejects missing native reports even when open exits with %i and releases the busy guard", async (exitCode) => {
  const spawn = vi.fn(() => ({done:Promise.resolve({exitCode,signal:null}),terminate:vi.fn(),
    waitForExit:async()=>true}) as unknown as SubprocessHandle);
  const service = new RecordingPermissionsService({resolveApp:async()=>"/owned/helper.app",subprocess:{spawn}});
  await expect(service.read()).rejects.toMatchObject({code:"PERMISSION_CHECK_FAILED"});
  await expect(service.read()).rejects.toMatchObject({code:"PERMISSION_CHECK_FAILED"});
  expect(spawn).toHaveBeenCalledTimes(2);
});

it("rejects settings targets outside the fixed allowlist before spawning", async () => {
  const spawn=vi.fn();
  const service=new RecordingPermissionsService({resolveApp:async()=>"/owned/helper.app",subprocess:{spawn}});
  await expect(service.openSettings("file:///private" as "system")).rejects.toMatchObject({code:"INVALID_INPUT"});
  expect(spawn).not.toHaveBeenCalled();
});

function queuedChecks() {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const resolveApp = vi.fn(async () => "/owned/helper.app");
  resolveApp.mockImplementationOnce(async () => { await gate; return "/owned/helper.app"; });
  const spawn = vi.fn((spec: SubprocessSpawnSpec) => ({
    control: undefined, stdin: undefined, stdout: undefined, stderr: undefined, collected: {},
    done: Promise.resolve({ exitCode: 0, signal: null }), terminate() {},
    waitForExit: async () => {
      await writeFile(join(spec.argv[6]!, "permissions.json"), JSON.stringify({
        microphone: "granted", system: spec.argv.at(-1) === "test" ? "verified" : "unverified",
      }));
      return true;
    },
  } satisfies SubprocessHandle));
  return { service: new RecordingPermissionsService({ resolveApp, subprocess: { spawn } }),
    release, resolveApp, spawn };
}

it("waits for status reading before verifying permission to start recording", async () => {
  const checks = queuedChecks();
  const status = checks.service.read();
  const start = checks.service.require();
  void start.catch(() => undefined);
  checks.release();
  await expect(status).resolves.toMatchObject({ system: "unverified" });
  await expect(start).resolves.toBeUndefined();
  expect(checks.spawn.mock.calls.map(([spec]) => spec.argv.at(-1))).toEqual(["read", "test"]);
});

it("cancels a queued check without allowing later checks to bypass the active read", async () => {
  const checks = queuedChecks();
  const status = checks.service.read();
  const controller = new AbortController();
  const start = checks.service.require(controller.signal);
  controller.abort();
  await expect(start).rejects.toMatchObject({ code: "CANCELLED_BY_USER" });
  const later = checks.service.read();
  void later.catch(() => undefined);
  await Promise.resolve();
  expect(checks.resolveApp).toHaveBeenCalledTimes(1);
  checks.release();
  await expect(status).resolves.toMatchObject({ system: "unverified" });
  await expect(later).resolves.toMatchObject({ system: "unverified" });
  expect(checks.spawn).toHaveBeenCalledTimes(2);
});
