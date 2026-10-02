#!/usr/bin/env node

import { resolve } from "node:path";

import { terminateActiveProcessGroups } from "./release/p1b-probe-process.mjs";
import { runInstalledP1cProbe } from "./release/p1c-probe-runtime.mjs";

const USAGE = [
  "usage: node scripts/probe-p1c.mjs --code-tgz <file> --model-pack <file>",
  "--wav <file> --m4a <file> --mp3 <file>",
  "--replay-30m <wav> --replay-60m <wav> --replay-180m <wav>",
  "[--author-evidence <json>] [--report <file>]\n",
].join(" ");
const VALUE_FLAGS = new Set([
  "--code-tgz", "--model-pack", "--wav", "--m4a", "--mp3", "--replay-30m",
  "--replay-60m", "--replay-180m", "--author-evidence", "--report",
]);
const REQUIRED_FLAGS = [
  "--code-tgz", "--model-pack", "--wav", "--m4a", "--mp3", "--replay-30m",
  "--replay-60m", "--replay-180m",
];

function valuesFrom(rawArguments) {
  const argv = rawArguments.filter((argument) => argument !== "--");
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!VALUE_FLAGS.has(flag) || values.has(flag) || value === undefined ||
      value.startsWith("--") || value.trim().length === 0) throw new Error("USAGE");
    values.set(flag, resolve(value));
    index += 1;
  }
  if (REQUIRED_FLAGS.some((flag) => !values.has(flag))) throw new Error("USAGE");
  return values;
}

function parseArguments(rawArguments) {
  const values = valuesFrom(rawArguments);
  return {
    codeTgz: values.get("--code-tgz"),
    modelPack: values.get("--model-pack"),
    audio: {
      wav: values.get("--wav"),
      m4a: values.get("--m4a"),
      mp3: values.get("--mp3"),
    },
    replays: {
      replay30m: values.get("--replay-30m"),
      replay60m: values.get("--replay-60m"),
      replay180m: values.get("--replay-180m"),
    },
    ...(values.has("--author-evidence")
      ? { authorEvidence: values.get("--author-evidence") }
      : {}),
    reportPath: values.get("--report") ?? resolve("data/p1c-probe/latest.json"),
  };
}

let interruptedSignal;
function interrupt(signal) {
  interruptedSignal ??= signal;
  terminateActiveProcessGroups();
}
const onSigint = () => interrupt("SIGINT");
const onSigterm = () => interrupt("SIGTERM");
process.once("SIGINT", onSigint);
process.once("SIGTERM", onSigterm);

try {
  const result = await runInstalledP1cProbe(parseArguments(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify({
    gate: "p1c-installed-author",
    status: result.p1cStatus,
    report_written: true,
  })}\n`);
  process.exitCode = interruptedSignal === "SIGINT" ? 130
    : interruptedSignal === "SIGTERM" ? 143
      : result.p1cStatus === "go" ? 0 : 1;
} catch (error) {
  if (error instanceof Error && error.message === "USAGE") {
    process.stderr.write(USAGE);
    process.exitCode = 2;
  } else {
    process.stdout.write(`${JSON.stringify({
      gate: "p1c-installed-author",
      status: "no_go",
      report_written: false,
      error_code: "PROBE_INTERNAL_ERROR",
    })}\n`);
    process.exitCode = 1;
  }
} finally {
  process.off("SIGINT", onSigint);
  process.off("SIGTERM", onSigterm);
}
