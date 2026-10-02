#!/usr/bin/env node

import { resolve } from "node:path";

import { runInstalledArtifactProbe } from "./release/p1b-probe-runtime.mjs";
import { terminateActiveProcessGroups } from "./release/p1b-probe-process.mjs";

const USAGE = "usage: node scripts/probe-p1b.mjs --code-tgz <file> --model-pack <file> --wav <file> --m4a <file> --mp3 <file> [--report <file>]\n";
const VALUE_FLAGS = new Set(["--code-tgz", "--model-pack", "--wav", "--m4a", "--mp3", "--report"]);

function parseArguments(rawArguments) {
  const argv = rawArguments.filter((argument) => argument !== "--");
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!VALUE_FLAGS.has(flag) || values.has(flag)) throw new Error("USAGE");
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--") || value.trim().length === 0) {
      throw new Error("USAGE");
    }
    values.set(flag, resolve(value));
    index += 1;
  }
  for (const required of ["--code-tgz", "--model-pack", "--wav", "--m4a", "--mp3"]) {
    if (!values.has(required)) throw new Error("USAGE");
  }
  return {
    codeTgz: values.get("--code-tgz"),
    modelPack: values.get("--model-pack"),
    audio: {
      wav: values.get("--wav"),
      m4a: values.get("--m4a"),
      mp3: values.get("--mp3"),
    },
    reportPath: values.get("--report") ?? resolve("data/p1b-probe/latest.json"),
  };
}

let interruptedSignal;
const interrupt = (signal) => {
  interruptedSignal ??= signal;
  terminateActiveProcessGroups();
};
const onSigint = () => interrupt("SIGINT");
const onSigterm = () => interrupt("SIGTERM");
process.once("SIGINT", onSigint);
process.once("SIGTERM", onSigterm);

try {
  const result = await runInstalledArtifactProbe(parseArguments(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify({
    gate: "p1b-installed-artifact",
    status: result.engineeringStatus,
    report_written: true,
  })}\n`);
  process.exitCode = interruptedSignal === "SIGINT" ? 130
    : interruptedSignal === "SIGTERM" ? 143
      : result.engineeringStatus === "go" ? 0 : 1;
} catch (error) {
  if (error instanceof Error && error.message === "USAGE") {
    process.stderr.write(USAGE);
    process.exitCode = 2;
  } else {
    process.stdout.write(`${JSON.stringify({
      gate: "p1b-installed-artifact",
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
