import assert from "node:assert/strict";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { prepareWorld, inspectRegularFile, writeReport } from "./release/p1b-probe-world.mjs";
import { prepareInstalledRuntime } from "./release/p1b-probe-runtime.mjs";
import { runRequired, startObservedCommand, stopProcessTree } from "./release/p1b-probe-process.mjs";
import { pluginExec } from "./release/p1b-probe-checks.mjs";
import { seedLegacyMeeting, verifyLegacyMeeting } from "./release/model-settings-legacy.mjs";

const [code, base, punctuation, output, legacyModels, legacyCode] = process.argv.slice(2).map(path => resolve(path));
assert(output && process.env.P1B_DSH_BIN);
assert(Boolean(legacyModels) === Boolean(legacyCode));
const report = { gate: "local-installed-model-settings", status: "in_progress", checks: [], states: [],
  artifacts: { code: await inspectRegularFile(code), base: await inspectRegularFile(base), punctuation: await inspectRegularFile(punctuation) } };
const world = await prepareWorld({ codeTgz: code, modelPack: base,
  audio: { wav: resolve("data/p0-wav/worker-smoke.wav"), m4a: resolve("data/p1a-input/four-zh.m4a"),
    mp3: resolve("data/private-audio/4人中文.mp3") } },
{ parent: join(homedir(), "Library/Caches"), prefix: "dsh-asr-settings-" });
const livePath = join(output, "live.json"), controlPath = join(output, "control.json");
let host, installed, legacy, punctuationRoot, closing = false;
process.on("SIGTERM", () => { closing = true; });
process.on("SIGINT", () => { closing = true; });

async function boot() {
  host = await startObservedCommand(installed.dsh, ["--profile", "web", "--port", "0", "--no-open"],
    { ...world, timeoutMs: 1_800_000 }, /http:\/\/127\.0\.0\.1:\d+\/\?token=/);
  const url = host.output().match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/)?.[0];
  assert(url);
  const login = await fetch(url, { redirect: "manual" });
  const cookie = login.headers.getSetCookie().map(item => item.split(";")[0]).join("; ");
  return { url, cookie };
}
async function rpc(login, method, payload = {}) {
  const origin = new URL(login.url).origin;
  const response = await fetch(`${origin}/dsh-asr-recording/${method}`, {
    method: "POST", headers: { cookie: login.cookie, origin, "content-type": "application/json" },
    body: JSON.stringify({ type: "client-request", rpcId: "model-settings", method, payload }),
  });
  assert.equal(response.status, 200);
  return (await response.json()).result;
}
async function status(login) {
  const result = await rpc(login, "models/status");
  assert(result.ok);
  return result.value;
}
async function corruptPunctuation() {
  const manifest = JSON.parse(await readFile(join(installed.packageRoot, "dist/assets/manifest.json"), "utf8"));
  const asset = manifest.assets.find(asset => asset.id === "punc-model");
  const store = join(world.env.DSH_HOME, "dsh-asr-plugin/assets");
  assert(punctuationRoot);
  const handle = await open(join(store, punctuationRoot, asset.relativePath), "r+");
  try { const byte = Buffer.alloc(1); await handle.read(byte, 0, 1, 0); byte[0] ^= 1; await handle.write(byte, 0, 1, 0); }
  finally { await handle.close(); }
}
try {
  await mkdir(output, { recursive: true, mode: 0o700 });
  installed = await prepareInstalledRuntime(world, report.checks, report);
  assert.equal(report.environment.dsh_version, "0.2.0-rc.2");
  const dataRoot = join(world.env.DSH_HOME, "dsh-asr-plugin");
  const savedAssets = join(world.root, "saved-base-assets");
  await rename(join(dataRoot, "assets"), savedAssets);
  if (legacyModels) {
    report.artifacts.legacyModels = await inspectRegularFile(legacyModels);
    report.artifacts.legacyCode = await inspectRegularFile(legacyCode);
    await runRequired(installed.dsh, pluginExec("stage", legacyModels), world, "LEGACY_STAGE_FAILED");
    legacy = await seedLegacyMeeting(legacyCode, world, dataRoot);
  }
  let login = await boot();
  const publish = async scenario => {
    const modelStatus = await status(login);
    if (!modelStatus.selectedReady) {
      const start = await rpc(login, "control", { action: "start" });
      assert.equal(start.ok, false);
      assert.equal(start.error.message, "MODEL_NOT_READY");
      const state = await rpc(login, "state");
      assert.equal(state.value.recording, null);
      report.checks.push({ id: `${scenario}_blocks_recording_start`, status: "passed" });
    }
    if (legacy) report.migration = await verifyLegacyMeeting(legacy, installed.packageRoot);
    report.states.push({ scenario, ...modelStatus });
    await writeReport(livePath, { root: world.root, packageRoot: installed.packageRoot,
      profileRoot: installed.profileRoot, dataRoot, url: login.url, scenario, modelStatus });
    await writeReport(join(output, "report.json"), report);
    process.stdout.write(`${JSON.stringify({ scenario, mode: modelStatus.mode, selectedReady: modelStatus.selectedReady })}\n`);
  };
  await publish(legacy ? "legacy-complete" : "fresh");
  if (legacy) {
    assert.equal(report.states[0].mode, "enhanced");
    assert.equal(report.states[0].inheritedLegacy, true);
    assert.equal(report.states[0].selectedReady, true);
  }
  while (!closing) {
    let control;
    try { control = JSON.parse(await readFile(controlPath, "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; await delay(250); continue; }
    await rm(controlPath);
    if (control.action === "base") await rename(savedAssets, join(dataRoot, "assets"));
    else if (control.action === "punctuation" || control.action === "repair") {
      const staged = await runRequired(installed.dsh, pluginExec("stage", punctuation), { ...world, timeoutMs: 300_000 }, "PUNCTUATION_STAGE_FAILED");
      punctuationRoot = JSON.parse(staged.stdout.trim().split("\n").at(-1)).modelSetFingerprint;
    } else if (control.action === "corrupt") await corruptPunctuation();
    else if (control.action === "restart") {
      await stopProcessTree(host.child); login = await boot();
    } else if (control.action === "finish") {
      report.status = "passed"; report.ui = control.ui; closing = true;
    } else if (control.action !== "observe") throw new Error("Unknown qualification control");
    if (!closing) await publish(control.scenario ?? control.action);
  }
} catch (error) {
  report.status = "failed"; report.failure = { code: error.code ?? error.message };
  process.exitCode = 1;
} finally {
  if (host) await stopProcessTree(host.child);
  await writeReport(join(output, "report.json"), report);
  await rm(livePath, { force: true });
  await rm(world.root, { recursive: true, force: true });
}
