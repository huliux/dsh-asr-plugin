import { dirname } from "node:path";

import type {
  SubprocessHandle,
  SubprocessSpawnSpec,
} from "@deepseek-ai/dsh-subprocess";

import type {
  RecordingHelperSignatureFacts,
  RecordingHelperSignatureInspectionInput,
  RecordingHelperSignatureInspector,
} from "./recording-helper-assets.js";

const CODESIGN = "/usr/bin/codesign";
const OUTPUT_LIMIT_BYTES = 64 * 1_024;
const PROCESS_TIMEOUT_MS = 15_000;

export interface CodesignResult {
  readonly output: string;
  readonly status: number | null;
}

export type CodesignRunner = (args: readonly string[], cwd: string) => Promise<CodesignResult>;

export interface CodesignSubprocess {
  spawn(spec: SubprocessSpawnSpec): SubprocessHandle;
}

function detail(output: string, pattern: RegExp): string | null {
  return pattern.exec(output)?.[1]?.trim() ?? null;
}

function entitlements(output: string): string[] {
  return [...output.matchAll(/<key>([^<]+)<\/key>\s*<true\s*\/>/gu)]
    .map((match) => match[1]!)
    .sort();
}

function hasHardenedRuntime(output: string): boolean {
  return /flags=.*\([^\r\n)]*\bruntime\b[^\r\n)]*\)/u.test(output);
}

async function factsForPath(
  path: string,
  relativePath: string,
  run: CodesignRunner,
): Promise<RecordingHelperSignatureFacts["components"][number]> {
  const cwd = dirname(path);
  const [verification, details, rights] = await Promise.all([
    run(["--verify", "--strict", path], cwd),
    run(["-dvvv", path], cwd),
    run(["-d", "--entitlements", ":-", path], cwd),
  ]);
  const team = detail(details.output, /TeamIdentifier=([^\r\n]+)/u);
  return {
    relativePath,
    valid: verification.status === 0,
    adHoc: /Signature=adhoc/u.test(details.output),
    entitlements: entitlements(rights.output),
    teamIdentifier: team === "not set" ? null : team,
    hardenedRuntime: hasHardenedRuntime(details.output),
    signingIdentity: detail(details.output, /^Authority=([^\r\n]+)/mu),
  };
}

export async function inspectRecordingHelperSignature(
  input: RecordingHelperSignatureInspectionInput,
  run: CodesignRunner,
): Promise<RecordingHelperSignatureFacts> {
  const cwd = dirname(input.appRoot);
  const [deep, app, requirements, ...components] = await Promise.all([
    run(["--verify", "--deep", "--strict", input.appRoot], cwd),
    factsForPath(input.appRoot, "", run),
    run(["-d", "-r-", input.appRoot], cwd),
    ...input.componentPaths.map((relativePath) =>
      factsForPath(`${input.appRoot}/${relativePath}`, relativePath, run)),
  ]);
  const details = await run(["-dvvv", input.appRoot], cwd);
  return {
    deepValid: deep.status === 0,
    app: {
      valid: app.valid,
      adHoc: app.adHoc,
      bundleIdentifier: detail(details.output, /Identifier=([^\r\n]+)/u),
      designatedRequirement: detail(requirements.output, /designated => (.+)/u),
      entitlements: app.entitlements,
      hardenedRuntime: app.hardenedRuntime,
      signingIdentity: app.signingIdentity,
      teamIdentifier: app.teamIdentifier,
    },
    components,
  };
}

function collected(handle: SubprocessHandle, name: "stdout" | "stderr"): string {
  return handle.collected[name]?.readFrom(0).text ?? "";
}

export function createDshCodesignRunner(subprocess: CodesignSubprocess): CodesignRunner {
  return async (args, cwd) => {
    const handle = subprocess.spawn({
      argv: [CODESIGN, ...args],
      cwd,
      stdio: {
        stdin: "ignore",
        stdout: { maxBytes: OUTPUT_LIMIT_BYTES },
        stderr: { maxBytes: OUTPUT_LIMIT_BYTES },
      },
      graceMs: 2_000,
    });
    const outcome = await handle.done;
    const exited = await handle.waitForExit(AbortSignal.timeout(PROCESS_TIMEOUT_MS));
    if (!exited) {
      handle.terminate();
      throw new Error("codesign process tree did not exit");
    }
    return {
      status: outcome.exitCode,
      output: `${collected(handle, "stdout")}${collected(handle, "stderr")}`,
    };
  };
}

export function createDshRecordingHelperSignatureInspector(
  subprocess: CodesignSubprocess,
): RecordingHelperSignatureInspector {
  const run = createDshCodesignRunner(subprocess);
  return (input) => inspectRecordingHelperSignature(input, run);
}
