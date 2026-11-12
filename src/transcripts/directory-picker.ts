import type { SubprocessHandle, SubprocessSpawnSpec } from "@deepseek-ai/dsh-subprocess";

const OSASCRIPT = "/usr/bin/osascript";
const MAX_OUTPUT_BYTES = 4_096;
const DEFAULT_TIMEOUT_MS = 600_000;

export interface DirectoryPickerRequest {
  /** Folder the dialog opens in; the dialog falls back to its own default when absent. */
  readonly defaultDirectory?: string;
  readonly prompt: string;
  readonly signal?: AbortSignal;
}

/** Resolves an absolute folder path, or null when the user cancelled the dialog. */
export interface DirectoryPicker {
  choose(request: DirectoryPickerRequest): Promise<string | null>;
}

export interface DirectoryPickerSubprocess {
  spawn(spec: SubprocessSpawnSpec): SubprocessHandle;
}

function escapeAppleScript(text: string): string {
  return text.replace(/\\/gu, "\\\\").replace(/"/gu, "\\\"");
}

/**
 * AppleScript that shows the standard macOS folder chooser. `activate` brings
 * the dialog to the front for hosts that run without a foreground window.
 */
export function buildFolderPickerScript(prompt: string, defaultDirectory?: string): string[] {
  const location = defaultDirectory === undefined
    ? ""
    : ` default location (POSIX file "${escapeAppleScript(defaultDirectory)}")`;
  const lines = [
    "activate",
    `set chosenFolder to choose folder with prompt "${escapeAppleScript(prompt)}"${location}`,
    "POSIX path of chosenFolder",
  ];
  return lines.flatMap((line) => ["-e", line]);
}

export interface FolderPickerFailure {
  readonly cancelled: boolean;
  readonly reason: string;
}

/**
 * osascript reports a cancelled dialog as exit 1 with a user-cancel error code
 * and reports real AppleScript failures the same way, so the two are separated
 * here by the message instead of the exit status.
 */
export function classifyFolderPickerFailure(stderr: string): FolderPickerFailure {
  const reason = stderr.trim().slice(0, 512);
  return { cancelled: /\(-128\)|User canceled|User cancelled/iu.test(reason), reason };
}

export type PickerErrorKind = "cancelled" | "timeout" | "failed";

export class PickerError extends Error {
  constructor(readonly kind: PickerErrorKind, readonly detail = "") {
    super(`Transcript folder picker ${kind === "failed" ? "failed" : kind}`);
    this.name = "PickerError";
  }
}

export interface MacDirectoryPickerOptions {
  readonly subprocess: DirectoryPickerSubprocess;
  readonly timeoutMs?: number;
}

export function createMacDirectoryPicker(options: MacDirectoryPickerOptions): DirectoryPicker {
  return {
    async choose(request) {
      const bounds: AbortSignal[] = [AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)];
      if (request.signal !== undefined) bounds.push(request.signal);
      const bounded = AbortSignal.any(bounds);
      const handle = options.subprocess.spawn({
        argv: [OSASCRIPT, ...buildFolderPickerScript(request.prompt, request.defaultDirectory)],
        cwd: "/",
        stdio: { stdin: "ignore", stdout: { maxBytes: MAX_OUTPUT_BYTES }, stderr: { maxBytes: MAX_OUTPUT_BYTES } },
        graceMs: 1_000,
      });
      try {
        if (!await handle.waitForExit(bounded)) {
          throw new PickerError(request.signal?.aborted === true ? "cancelled" : "timeout");
        }
        const outcome = await handle.done;
        const stdout = handle.collected.stdout?.readFrom(0).text.trim() ?? "";
        const stderr = handle.collected.stderr?.readFrom(0).text ?? "";
        if (outcome.exitCode === 0) {
          if (!stdout.startsWith("/")) throw new PickerError("failed", stdout);
          return stdout;
        }
        const failure = classifyFolderPickerFailure(stderr);
        if (failure.cancelled) return null;
        throw new PickerError("failed", failure.reason);
      } finally {
        await handle.waitForExit(AbortSignal.timeout(5_000)).catch(() => false);
        handle.terminate();
      }
    },
  };
}
