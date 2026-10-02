import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { runCommand, runRequired, startObservedCommand, stopProcessTree } from "./release/p1b-probe-process.mjs";
import { configureIsolatedDependencyPolicy } from "./release/p1b-probe-runtime.mjs";

const archive = resolve(process.argv[2] ?? "");
assert.ok(process.argv[2], "Provide the built plugin tarball");
const root = await mkdtemp(join(tmpdir(), "dsh-asr-rpc-"));
const env = { ...process.env, DSH_HOME: join(root, "home"), DSH_AGENTS_HOME: join(root, "agents") };
const world = { env, workspace: root, timeoutMs: 600_000 };
const dsh = process.env.P1B_DSH_BIN ?? "dsh";
let host;
let toolReport;

async function qualifyTools() {
  const binary = await runRequired("which", [dsh], world, "DSH_PATH_FAILED");
  const packageRoot = await realpath(join(env.DSH_HOME, "profiles/web/node_modules/@huliux/dsh-asr-plugin"));
  assert.ok(packageRoot.startsWith(`${await realpath(root)}/`));
  const runner = fileURLToPath(new URL("./release/probe-dsh-compat-tools.mjs", import.meta.url));
  const result = await runCommand(process.execPath, [runner, packageRoot,
    process.env.P1B_DSH_HOST_ENTRY ?? await realpath(binary.stdout.trim()),
    join(env.DSH_HOME, "dsh-asr-plugin")],
  world);
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout);
}

async function rpcResponse(method = "state", payload = {}, authenticated = true) {
  const url = host.output().match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/)?.[0];
  assert.ok(url, "Authenticated host URL missing");
  const origin = new URL(url).origin;
  const login = await fetch(url, { redirect: "manual" });
  const cookie = login.headers.getSetCookie().map((item) => item.split(";")[0]).join("; ");
  return fetch(`${origin}/dsh-asr-recording/${method}`, {
    method: "POST",
    headers: { ...(authenticated ? { cookie } : {}), origin, "content-type": "application/json" },
    body: JSON.stringify({ type: "client-request", rpcId: "qualification", method, payload }),
  });
}

try {
  const version = await runRequired(dsh, ["--version"], world, "VERSION_FAILED");
  assert.equal(version.stdout.trim(), "0.2.0-rc.2", "This qualification targets one installed DSH version");
  await runRequired(dsh, ["plugin", "--profile", "web", "add", "--ignore-scripts", archive,
    "--store-dir", join(root, "pnpm-store")], world, "INSTALL_FAILED");
  await configureIsolatedDependencyPolicy(join(env.DSH_HOME, "profiles/web"), join(root, "pnpm-store"));
  const patchPath = join(env.DSH_HOME, "profiles/web/cordis.patch.yml");
  const profilePatch = await readFile(patchPath, "utf8");
  assert.ok(!profilePatch.includes("webServer"), "Probe must not repair the user profile");
  if (process.argv.includes("--tools")) toolReport = await qualifyTools();
  host = await startObservedCommand(dsh, ["--profile", "web", "--port", "0", "--no-open"],
    { ...world, timeoutMs: 120_000 }, /http:\/\/127\.0\.0\.1:\d+\/\?token=/);
  let response;
  for (let attempt = 0; attempt < 20; attempt++) {
    response = await rpcResponse();
    if (response.status === 200) break;
    await response.text();
    await delay(250);
  }
  assert.equal(response.status, 200, "Recording RPC must be registered by the installed bundle");
  const body = await response.json();
  assert.equal(body.result?.ok, true);
  assert.equal(body.result.value.recording, null);
  assert.deepEqual(body.result.value.preview, []);
  assert.equal(body.result.value.hasRecordingHistory, false);
  const models = await rpcResponse("models/status");
  const modelStatus = (await models.json()).result.value;
  assert.equal(modelStatus.mode, "base");
  assert.equal(modelStatus.selectedReady, false);
  const notReady = await rpcResponse("control", { action: "start" });
  assert.equal((await notReady.json()).result.error.message, "MODEL_NOT_READY");
  assert.equal((await (await rpcResponse()).json()).result.value.recording, null);
  const denied = await rpcResponse("state", {}, false);
  assert.equal(denied.status, 401, "Bundle repair must preserve authentication");
  await denied.text();
  const invalid = await rpcResponse("control", { action: "invalid" });
  assert.equal(invalid.status, 200);
  assert.equal((await invalid.json()).result?.ok, false);
  if (toolReport) {
    const candidates = await rpcResponse("references/candidates", { session_id: "qualification", locale: "en", query: "Compatibility" });
    const items = (await candidates.json()).result.value;
    assert.equal(items.length, 1);
    const resolved = await rpcResponse("references/resolve", {
      locale: "en", meeting_id: items[0].meeting_id,
    });
    assert.equal((await resolved.json()).result.value.meeting_id, items[0].meeting_id);
  }
  assert.equal(await readFile(patchPath, "utf8"), profilePatch);
  console.log(JSON.stringify({ status: "passed", dsh_version: version.stdout.trim(), http: 200,
    unauthenticated_http: 401, invalid_control_rejected: true, profile_repair: false,
    missing_assets_block_start: true, model_status_mode: modelStatus.mode,
    ...(toolReport ? { tools: toolReport, reference_rpc: true } : {}),
    archive_sha256: createHash("sha256").update(await readFile(archive)).digest("hex") }));
} finally {
  if (host) await stopProcessTree(host.child);
  await rm(root, { recursive: true, force: true });
}
