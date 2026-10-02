import { chmod, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { step } from "./p1b-probe-checks.mjs";
import { parseJsonLine, ProbeFailure, runCommand } from "./p1b-probe-process.mjs";
import { validateReplayWitness } from "./p1c-probe-policy.mjs";

const REPLAY_HELPER = fileURLToPath(
  new URL("./probe-installed-recording-replay.mjs", import.meta.url),
);
const CASES = [
  { id: "recording_replay_30m", key: "replay30m", duration: "1800000", minimum: 1_800_000 },
  { id: "recording_replay_60m", key: "replay60m", duration: "3600000", minimum: 3_600_000 },
  { id: "recording_replay_180m", key: "replay180m", duration: "full", minimum: 10_800_000 },
];

async function prepareRunner(context) {
  const runner = join(context.profileRoot, "p1c-installed-recording-replay.mjs");
  await copyFile(REPLAY_HELPER, runner);
  await chmod(runner, 0o600);
  return runner;
}

function replayFailure(result) {
  const witness = parseJsonLine(result.stdout, "P1C_REPLAY_REPORT_INVALID");
  const code = typeof witness.error_code === "string" &&
    /^[A-Z][A-Z0-9_]+$/.test(witness.error_code)
    ? witness.error_code
    : "P1C_REPLAY_PROCESS_FAILED";
  throw new ProbeFailure(code);
}

async function runReplayCase(context, runner, definition) {
  const result = await runCommand(process.execPath, [
    runner,
    context.world.artifacts.replays[definition.key],
    definition.duration,
  ], {
    ...context.world,
    cwd: context.profileRoot,
    env: {
      ...context.world.env,
      P1C_PACKAGE_ROOT: context.packageRoot,
      P1C_DATA_ROOT: join(context.world.env.DSH_HOME, "dsh-asr-plugin"),
      P1C_PROBE_ROOT: join(context.world.root, "p1c-replays"),
    },
    timeoutMs: definition.minimum >= 10_800_000 ? 7_200_000 : 3_600_000,
  });
  if (result.code !== 0) replayFailure(result);
  const witness = parseJsonLine(result.stdout, "P1C_REPLAY_REPORT_INVALID");
  return {
    ...validateReplayWitness(witness, definition.minimum),
    maxRssBytes: result.maxRssBytes,
  };
}

export async function runInstalledReplayChecks(context, checks, report) {
  const runner = await prepareRunner(context);
  report.replays = {};
  for (const definition of CASES) {
    const witness = await step(checks, definition.id, () =>
      runReplayCase(context, runner, definition));
    report.replays[definition.id] = {
      duration_ms: witness.duration_ms,
      stop_to_commit_ms: witness.stop_to_commit_ms,
      worst_case_freshness_ms: witness.worst_case_freshness_ms,
    };
  }
}
