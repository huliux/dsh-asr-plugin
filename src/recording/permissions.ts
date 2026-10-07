import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { SubprocessHandle } from "@deepseek-ai/dsh-subprocess";
import type { RecordingHelperSubprocess } from "./helper-client.js";
import { parseRecordingPermissions, type RecordingPermissionControl, type RecordingPermissions } from "./permission-contract.js";

type Options = { readonly resolveApp: () => Promise<string>; readonly subprocess: RecordingHelperSubprocess };
const SETTINGS = {
  microphone: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
  system: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
} as const;

function failure(code: string): Error & { code: string } {
  return Object.assign(new Error("Recording permission check failed"), { code });
}

async function finish(handle: SubprocessHandle, signal: AbortSignal): Promise<void> {
  const exited = await handle.waitForExit(signal);
  if (!exited) throw failure(signal.aborted ? "PERMISSION_CHECK_TIMEOUT" : "PERMISSION_CHECK_FAILED");
  const outcome = await handle.done;
  if (outcome.exitCode !== 0 || outcome.signal !== null) throw failure("PERMISSION_CHECK_FAILED");
}

async function waitForTurn(previous: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (signal === undefined) return previous;
  const waiting = Promise.withResolvers<void>();
  const cancel = () => waiting.reject(failure("CANCELLED_BY_USER"));
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  void previous.then(waiting.resolve);
  try { await waiting.promise; }
  finally { signal.removeEventListener("abort", cancel); }
}

export class RecordingPermissionsService implements RecordingPermissionControl {
  private pending = Promise.resolve();
  constructor(private readonly options: Options) {}

  read(signal?: AbortSignal): Promise<RecordingPermissions> { return this.run(false, signal); }
  test(signal?: AbortSignal): Promise<RecordingPermissions> { return this.run(true, signal); }

  async require(signal?: AbortSignal): Promise<void> {
    const status = await this.test(signal);
    if (status.microphone !== "granted") throw failure("MICROPHONE_PERMISSION_REQUIRED");
    if (status.system === "unsupported") throw failure("SYSTEM_AUDIO_UNSUPPORTED");
    if (status.system !== "verified") throw failure("SYSTEM_AUDIO_PERMISSION_REQUIRED");
  }

  async openSettings(track: "microphone" | "system", signal?: AbortSignal): Promise<void> {
    if (!Object.hasOwn(SETTINGS, track)) throw failure("INVALID_INPUT");
    if (signal?.aborted) throw failure("CANCELLED_BY_USER");
    const bounded = AbortSignal.any([AbortSignal.timeout(5_000), ...(signal === undefined ? [] : [signal])]);
    const handle = this.options.subprocess.spawn({ argv: ["/usr/bin/open", SETTINGS[track]], cwd: tmpdir(),
      stdio: { stdin: "ignore", stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } }, graceMs: 500 });
    try { await finish(handle, bounded); }
    finally { handle.terminate(); }
  }

  private async run(test: boolean, signal?: AbortSignal): Promise<RecordingPermissions> {
    if (signal?.aborted) throw failure("CANCELLED_BY_USER");
    const previous = this.pending;
    const turn = Promise.withResolvers<void>();
    this.pending = previous.then(() => turn.promise);
    let parent: string | undefined;
    try {
      await waitForTurn(previous, signal);
      const app = await this.options.resolveApp();
      if (signal?.aborted) throw failure("CANCELLED_BY_USER");
      parent = await realpath(await mkdtemp(join(tmpdir(), "dsh-asr-permission-")));
      const id = randomUUID();
      const root = join(parent, id);
      await mkdir(root, { mode: 0o700 });
      return await this.launch(app, root, id, test, signal);
    } finally {
      try { if (parent !== undefined) await rm(parent, { recursive: true, force: true }); }
      finally { turn.resolve(); }
    }
  }

  private async launch(app: string, root: string, id: string, test: boolean, signal?: AbortSignal): Promise<RecordingPermissions> {
    const deadline = AbortSignal.timeout(50_000);
    const bounded = AbortSignal.any([deadline, ...(signal === undefined ? [] : [signal])]);
    const handle = this.options.subprocess.spawn({
      argv: ["/usr/bin/open", "-n", "-W", app, "--args", "__permissions", root, id, String(process.pid), test ? "test" : "read"],
      cwd: dirname(app), stdio: { stdin: "ignore", stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } }, graceMs: 500,
    });
    const cancel = () => { void writeFile(join(root, "cancel"), "", { mode: 0o600 }).catch(() => undefined); };
    bounded.addEventListener("abort", cancel, { once: true });
    try {
      if (bounded.aborted) cancel();
      if (!await handle.waitForExit(bounded)) throw failure("PERMISSION_CHECK_TIMEOUT");
      const outcome = await handle.done;
      if (outcome.signal !== null || ![0, 1].includes(outcome.exitCode ?? -1)) throw failure("PERMISSION_CHECK_FAILED");
      if (signal?.aborted) throw failure("CANCELLED_BY_USER");
      // open -W can lose a fast-exiting app; its owned native report is authoritative.
      const raw = await readFile(join(root, "permissions.json"), "utf8");
      if (raw.length > 1024) throw failure("PERMISSION_CHECK_FAILED");
      return parseRecordingPermissions(JSON.parse(raw));
    } catch (error) {
      if (signal?.aborted) throw failure("CANCELLED_BY_USER");
      if (deadline.aborted) throw failure("PERMISSION_CHECK_TIMEOUT");
      throw failure("PERMISSION_CHECK_FAILED");
    } finally {
      bounded.removeEventListener("abort", cancel);
      await writeFile(join(root, "cancel"), "", { mode: 0o600 }).catch(() => undefined);
      await handle.waitForExit(AbortSignal.timeout(5_000)).catch(() => false);
      handle.terminate();
    }
  }
}
