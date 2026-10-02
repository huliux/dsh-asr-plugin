import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EXPECTED_DSH_VERSION = "0.1.1-rc.2";
const REQUIRED_ROWS = {
  jobs: "@deepseek-ai/dsh-jobs-local",
  subprocess: "@deepseek-ai/dsh-subprocess-local",
  tool_jobs: "@deepseek-ai/dsh-tool-jobs",
  tools: "@deepseek-ai/dsh-tools",
};

function runDsh(args, environment = process.env) {
  const result = spawnSync("dsh", args, {
    encoding: "utf8",
    env: environment,
    maxBuffer: 4 * 1_024 * 1_024,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) throw new Error("DSH_COMMAND_FAILED");
  return result.stdout;
}

function verifyRows(config) {
  const missing = Object.entries(REQUIRED_ROWS)
    .filter(([, packageName]) => !config.includes(`name: '${packageName}'`))
    .map(([service]) => service);
  if (missing.length > 0) throw new Error("DSH_REQUIRED_SERVICE_MISSING");
  return Object.keys(REQUIRED_ROWS);
}

const isolatedRoot = mkdtempSync(join(tmpdir(), "dsh-asr-config-probe-"));
try {
  const version = runDsh(["--version"]).trim();
  if (version !== EXPECTED_DSH_VERSION) throw new Error("DSH_VERSION_MISMATCH");
  const environment = {
    ...process.env,
    DSH_HOME: join(isolatedRoot, ".dsh"),
    DSH_AGENTS_HOME: join(isolatedRoot, ".agents"),
  };
  const config = runDsh(["--profile", "headless", "--dump-config"], environment);
  console.log(JSON.stringify({
    ok: true,
    dsh_version: version,
    profile: "headless",
    required_rows: verifyRows(config),
  }));
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    code: error instanceof Error && /^[A-Z_]+$/.test(error.message)
      ? error.message
      : "INTERNAL_ERROR",
  }));
  process.exitCode = 1;
} finally {
  rmSync(isolatedRoot, { recursive: true, force: true });
}
