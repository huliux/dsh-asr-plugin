import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  inspectInputs,
  inspectRegularFile,
  prepareWorld,
} from "./p1b-probe-world.mjs";

const REPLAY_INPUTS = [
  ["input_replay_30m", "replay30m"],
  ["input_replay_60m", "replay60m"],
  ["input_replay_180m", "replay180m"],
];

async function inspectReplayInputs(input, checks, artifacts) {
  for (const [id, key] of REPLAY_INPUTS) {
    const inspection = await inspectRegularFile(input.replays[key]);
    if (inspection.errorCode === undefined) {
      checks.push({ id, status: "passed" });
      artifacts[id] = {
        byte_length: inspection.byteLength,
        sha256: inspection.sha256,
      };
    } else {
      checks.push({ id, status: "failed", error_code: inspection.errorCode });
    }
  }
}

export async function inspectP1cInputs(input) {
  const inspected = await inspectInputs(input);
  await inspectReplayInputs(input, inspected.checks, inspected.artifacts);
  if (input.authorEvidence !== undefined) {
    const evidence = await inspectRegularFile(input.authorEvidence);
    if (evidence.errorCode === undefined) {
      inspected.checks.push({ id: "input_author_evidence", status: "passed" });
      inspected.artifacts.input_author_evidence = {
        byte_length: evidence.byteLength,
        sha256: evidence.sha256,
      };
    } else {
      inspected.checks.push({
        id: "input_author_evidence",
        status: "failed",
        error_code: evidence.errorCode,
      });
    }
  }
  return inspected;
}

async function copyPrivateInput(source, target) {
  await copyFile(source, target, constants.COPYFILE_EXCL);
  await chmod(target, 0o600);
  return target;
}

export async function prepareP1cWorld(input) {
  const world = await prepareWorld(input, {
    parent: join(homedir(), "Library", "Caches"),
    prefix: "dsh-asr-p1c-installed-",
  });
  const replayRoot = join(world.root, "artifacts");
  world.artifacts.replays = {};
  for (const [, key] of REPLAY_INPUTS) {
    const target = join(replayRoot, `${key}-${randomUUID()}.wav`);
    world.artifacts.replays[key] = await copyPrivateInput(input.replays[key], target);
  }
  if (input.authorEvidence !== undefined) {
    world.artifacts.authorEvidence = await copyPrivateInput(
      input.authorEvidence,
      join(replayRoot, `author-evidence-${randomUUID()}.json`),
    );
  }
  return world;
}
