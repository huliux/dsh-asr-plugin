import assert from "node:assert/strict";
import { copyFile, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { prepareWorld, inspectRegularFile, writeReport } from "./release/p1b-probe-world.mjs";
import { configureIsolatedDependencyPolicy } from "./release/p1b-probe-runtime.mjs";
import { pluginExec } from "./release/p1b-probe-checks.mjs";
import { parseJsonLine, runCommand, ProbeFailure } from "./release/p1b-probe-process.mjs";

const [previous, candidate, base, punctuation, reportPath] = process.argv.slice(2).map(resolvePath);
function resolvePath(value) { return resolve(value); }
assert(reportPath, "Expected previous/candidate/base/punctuation/report paths");
const report = { gate: "installed-scope-upgrade", status: "no_go", artifacts: {
  previous: await inspectRegularFile(previous), candidate: await inspectRegularFile(candidate),
} };
const world = await prepareWorld({ codeTgz: previous, modelPack: base,
  audio: { wav: resolve("data/p0-wav/worker-smoke.wav"),
    m4a: resolve("data/p1a-input/four-zh.m4a"), mp3: resolve("data/private-audio/4人中文.mp3") },
}, { parent: join(homedir(), "Library/Caches"), prefix: "dsh-asr-scope-upgrade-" });
const dsh = process.env.P1B_DSH_BIN ?? "dsh";
const profile = join(world.env.DSH_HOME, "profiles/web");
const dataRoot = join(world.env.DSH_HOME, "dsh-asr-plugin");
const store = ["--store-dir", join(world.root, "pnpm-store")];
const meetingId = "00000000-0000-4000-8000-000000000001";

async function snapshot(packageRoot, seed = false) {
  await mkdir(join(dataRoot, "db"), { recursive: true });
  const { openMeetingRepository } = await import(pathToFileURL(join(packageRoot, "dist/storage/meeting-repository.js")));
  const repository = openMeetingRepository(join(dataRoot, "db/meetings.sqlite3"));
  try {
    if (seed) {
      const runId = "10000000-0000-4000-8000-000000000001";
      repository.createImport({ meetingId, runId, title: "Scope upgrade witness", sourceName: "witness.wav",
        sourceFormat: "wav", sourceSizeBytes: 1024, nowMs: 1000 });
      assert.equal(repository.commitTranscript({ meetingId, runId, baseVersion: 0,
        resultStatus: "completed", resultReason: null, durationMs: 2000, engineFingerprint: "a".repeat(64),
        segments: [{ seq: 0, startMs: 0, endMs: 1000, speakerLabel: "Speaker A", text: "Scope upgrade witness." }],
        nowMs: 1001 }).outcome, "committed");
    }
    return repository.getCommittedTranscriptSnapshot(meetingId);
  } finally { repository.close(); }
}

async function command(args, code) {
  const result = await runCommand(dsh, args, { ...world, timeoutMs: 600_000 });
  if (result.code !== 0) {
    report.diagnostic = { operation: code, output: `${result.stdout}\n${result.stderr}`.slice(-3000) };
    throw new ProbeFailure(code);
  }
  return result;
}

try {
  await command(["plugin", "--profile", "web", "add", "--ignore-scripts", world.artifacts.codeTgz, ...store], "PREVIOUS_INSTALL_FAILED");
  await configureIsolatedDependencyPolicy(profile, join(world.root, "pnpm-store"));
  const oldRoot = await realpath(join(profile, "node_modules/dsh-asr-plugin"));
  const before = await snapshot(oldRoot, true);
  await command(pluginExec("stage", world.artifacts.modelPack), "BASE_STAGE_FAILED");
  const optional = join(world.root, "artifacts/punctuation.tar");
  await copyFile(punctuation, optional);
  await command(pluginExec("stage", optional), "PUNCTUATION_STAGE_FAILED");
  const patch = join(profile, "cordis.patch.yml");
  const initialPatch = await readFile(patch, "utf8");
  assert.match(initialPatch, /^\[\]\s*$/m);
  await writeFile(patch, initialPatch.replace(/^\[\]\s*$/m, "- id: dsh-asr\n  config:\n    punctuation_enabled: true\n"));
  const beforePatch = await readFile(patch, "utf8");
  assert.match((await command(["--profile", "web", "--dump-config"], "PREVIOUS_CONFIG_FAILED")).stdout, /punctuation_enabled: true/);
  const doctorBefore = parseJsonLine((await command(pluginExec("doctor"), "PREVIOUS_DOCTOR_FAILED")).stdout, "DOCTOR_INVALID");
  await command(["plugin", "--profile", "web", "remove", "dsh-asr-plugin", ...store], "PREVIOUS_REMOVE_FAILED");
  const archive = join(world.root, "artifacts/scoped.tgz"); await copyFile(candidate, archive);
  await command(["plugin", "--profile", "web", "add", "--ignore-scripts", archive, ...store], "SCOPED_INSTALL_FAILED");
  const currentRoot = await realpath(join(profile, "node_modules/@huliux/dsh-asr-plugin"));
  assert.deepEqual(await snapshot(currentRoot), before);
  assert.equal(await readFile(patch, "utf8"), beforePatch);
  const manifest = JSON.parse(await readFile(join(profile, "package.json"), "utf8"));
  assert(manifest.dsh.profile.bundles.includes("@huliux/dsh-asr-plugin"));
  assert(!manifest.dsh.profile.bundles.includes("dsh-asr-plugin"));
  const dumped = await command(["--profile", "web", "--dump-config"], "SCOPED_CONFIG_FAILED");
  assert.match(dumped.stdout, /@huliux\/dsh-asr-plugin/);
  assert.match(dumped.stdout, /punctuation_enabled: true/);
  const doctorAfter = parseJsonLine((await command(pluginExec("doctor"), "SCOPED_DOCTOR_FAILED")).stdout, "DOCTOR_INVALID");
  assert(doctorBefore.enhancedReady && doctorAfter.enhancedReady);
  assert.equal(doctorAfter.modelSetFingerprint, doctorBefore.modelSetFingerprint);
  report.status = "go";
  report.preserved = { committedSnapshot: true, profilePatch: true, models: true, punctuationPreference: true, singleScopedBundle: true };
} catch (error) {
  report.failure = { code: error?.code ?? "SCOPE_UPGRADE_FAILED", assertion: error?.operator };
  process.exitCode = 1;
} finally {
  await writeReport(reportPath, report);
  await rm(world.root, { recursive: true, force: true });
}
process.stdout.write(`${JSON.stringify(report)}\n`);
