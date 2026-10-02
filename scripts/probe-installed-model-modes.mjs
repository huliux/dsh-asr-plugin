import assert from "node:assert/strict";
import { copyFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareWorld, inspectRegularFile, writeReport } from "./release/p1b-probe-world.mjs";
import { prepareInstalledRuntime } from "./release/p1b-probe-runtime.mjs";
import { runCommand, runRequired } from "./release/p1b-probe-process.mjs";
import { pluginExec } from "./release/p1b-probe-checks.mjs";

const [codeTgz, basePath, punctuationPath, reportPath] = process.argv.slice(2).map((path) => resolve(path));
assert(reportPath);
const report = { gate: "local-installed-model-modes", status: "no_go", checks: [], modes: [],
  artifacts: { code: await inspectRegularFile(codeTgz) } };
const world = await prepareWorld({ codeTgz, modelPack: basePath,
  audio: { wav: resolve("data/p0-wav/worker-smoke.wav"),
    m4a: resolve("data/p1a-input/four-zh.m4a"), mp3: resolve("data/private-audio/4人中文.mp3") },
}, { parent: join(homedir(), "Library/Caches"), prefix: "dsh-asr-model-modes-" });
try {
  const installed = await prepareInstalledRuntime(world, report.checks, report);
  const runner = join(installed.profileRoot, "model-mode-host.mjs");
  await copyFile(fileURLToPath(new URL("./release/probe-installed-model-mode-host.mjs", import.meta.url)), runner);
  await copyFile(fileURLToPath(new URL("./release/installed-host-modules.mjs", import.meta.url)),
    join(installed.profileRoot, "installed-host-modules.mjs"));
  const dataRoot = join(world.env.DSH_HOME, "dsh-asr-plugin");
  for (const scenario of ["base-only", "base-with-punctuation", "enhanced"]) {
    const mode = scenario === "enhanced" ? "enhanced" : "base";
    if (scenario === "base-with-punctuation") await runRequired(installed.dsh,
      pluginExec("stage", punctuationPath), { ...world, timeoutMs: 300_000 }, "PUNCTUATION_STAGE_FAILED");
    const result = await runCommand(process.execPath, [runner, mode, dataRoot,
      world.artifacts.wav, world.workspace, installed.dsh], { ...world, cwd: installed.profileRoot, timeoutMs: 240_000 });
    let witness;
    try { witness = JSON.parse(result.stdout.trim().split("\n").filter(Boolean).at(-1)); }
    catch {
      report.modes.push({ scenario, ok: false, exitCode: result.code, diagnostic: result.stderr.slice(-1000) });
      throw Object.assign(new Error("Installed report missing"), { code: "INSTALLED_REPORT_INVALID" });
    }
    report.modes.push({ scenario, ...witness, maxRssBytes: result.maxRssBytes });
    if (result.code !== 0 || !witness.ok) throw Object.assign(new Error("Installed journey failed"), { code: witness.code });
  }
  report.status = "go";
} catch (error) {
  report.checks.push({ id: "installed_modes", status: "failed", code: error?.code ?? "JOURNEY_FAILED" });
  process.exitCode = 1;
} finally {
  await writeReport(reportPath, report);
  await rm(world.root, { recursive: true, force: true });
}
process.stdout.write(`${JSON.stringify({ gate: report.gate, status: report.status,
  modes: report.modes.map(({ mode, ok }) => ({ mode, ok })) })}\n`);
