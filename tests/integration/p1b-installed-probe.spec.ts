import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const ORT_INTEGRITY =
  "sha512-9eHMP/HKbbeUcqte1JYzaaRC8JPn7ojWeCeoyShO86TOR97OCyIyAIOGX3V95ErjslVhJRXY8Em/caIUc0hm1Q==";

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dsh-asr-p1b-probe-test-"));
  roots.push(root);
  return root;
}

async function installedIntegrityFixture(lockIntegrity = ORT_INTEGRITY): Promise<{
  packageRoot: string;
  profileRoot: string;
}> {
  const root = await temporaryRoot();
  const packageRoot = join(root, "profile/node_modules/@huliux/dsh-asr-plugin");
  const profileRoot = join(root, "profile");
  await mkdir(join(packageRoot, "dist/assets"), { recursive: true });
  await writeFile(join(packageRoot, "dist/assets/supply-chain.json"), JSON.stringify({
    dependencies: [{
      id: "onnxruntime-node",
      packageName: "onnxruntime-node",
      version: "1.19.2",
      integrity: ORT_INTEGRITY,
    }],
  }));
  await writeFile(join(profileRoot, "pnpm-lock.yaml"), [
    "onnxruntime-node@1.19.2:",
    `  resolution: {integrity: ${lockIntegrity}}`,
  ].join("\n"));
  return { packageRoot, profileRoot };
}

async function verifyInstalledOrtIntegrity(input: {
  packageRoot: string;
  profileRoot: string;
}): Promise<string> {
  const moduleUrl = pathToFileURL(resolve("scripts/release/p1b-probe-runtime.mjs")).href;
  const probe = await import(moduleUrl) as {
    verifyInstalledOrtIntegrity(value: typeof input): Promise<string>;
  };
  return probe.verifyInstalledOrtIntegrity(input);
}

async function runProbe(arguments_: readonly string[]): Promise<{
  code: number | null;
  stderr: string;
  stdout: string;
}> {
  const child = spawn(process.execPath, [resolve("scripts/probe-p1b.mjs"), ...arguments_], {
    cwd: resolve("."),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const code = await new Promise<number | null>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", resolveExit);
  });
  return { code, stderr, stdout };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function withAuthenticatedWeb(
  redirect: string,
  verify: (request: () => Promise<Response>) => Promise<void>,
): Promise<void> {
  const root = await temporaryRoot();
  const executable = join(root, "web.mjs");
  await writeFile(executable, `#!/usr/bin/env node
import { createServer } from "node:http";
const server = createServer((request, response) => {
  if (request.url === "/?token=probe") {
    response.writeHead(302, { location: ${JSON.stringify(redirect)}, "set-cookie": "probe=ok; HttpOnly" });
  } else {
    response.writeHead(request.headers.cookie === "probe=ok" ? 200 : 401);
  }
  response.end();
});
server.listen(0, "127.0.0.1", () => console.log("dsh web: http://127.0.0.1:" + server.address().port + "/?token=probe"));
`, { mode: 0o700 });
  const host = await import(pathToFileURL(resolve("scripts/release/p1b-probe-host.mjs")).href);
  const processTools = await import(pathToFileURL(resolve("scripts/release/p1b-probe-process.mjs")).href);
  const web = await host.startWeb(executable, { workspace: root, env: process.env });
  try {
    await verify(web.request);
  } finally {
    await processTools.stopProcessTree(web.child);
  }
}

describe("P1b 已安装发布物 probe 运行边界", () => {
  it("Web 就绪检查携带同源登录重定向的 cookie", async () => {
    await withAuthenticatedWeb("/", async (request) => {
      expect((await request()).status).toBe(200);
    });
  });

  it("Web 就绪检查拒绝把 cookie 发往另一来源", async () => {
    await withAuthenticatedWeb("http://127.0.0.1:1/", async (request) => {
      await expect(request()).rejects.toMatchObject({ code: "WEB_AUTH_REDIRECT_INVALID" });
    });
  });

  it("在隔离 profile 持久记录精确的 ORT 构建拒绝与独立 store", async () => {
    const root = await temporaryRoot();
    const workspace = join(root, "pnpm-workspace.yaml");
    await writeFile(workspace, "packages:\n  - .\nnodeLinker: hoisted\n");
    const probe = await import(pathToFileURL(resolve("scripts/release/p1b-probe-runtime.mjs")).href);
    await probe.configureIsolatedDependencyPolicy(root, join(root, "store"));
    const text = await readFile(workspace, "utf8");
    expect(text).toContain('"onnxruntime-node@1.19.2": false');
    expect(text).toContain(`storeDir: ${JSON.stringify(join(root, "store"))}`);
    expect(text).toContain("nodeLinker: hoisted");
    expect(text).not.toContain("ignoreScripts:");
  });

  it("保留资产 CLI 返回的稳定失败码", async () => {
    const moduleUrl = pathToFileURL(resolve("scripts/release/p1b-probe-runtime.mjs")).href;
    const probe = await import(moduleUrl) as {
      assertAssetCommand(result: { code: number | null; stderr: string }, fallback: string): unknown;
    };

    expect(() => probe.assertAssetCommand({
      code: 1,
      stderr: `${JSON.stringify({ code: "MODEL_PACK_INCOMPATIBLE" })}\n`,
    }, "ASSETS_STAGE_FAILED")).toThrow(expect.objectContaining({
      code: "MODEL_PACK_INCOMPATIBLE",
    }));
  });

  it("保留已安装 Host 子进程报告的具体失败码", async () => {
    const moduleUrl = pathToFileURL(resolve("scripts/release/p1b-probe-host.mjs")).href;
    const probe = await import(moduleUrl) as {
      installedHostWitness(result: { code: number | null; stdout: string }): unknown;
    };

    expect(() => probe.installedHostWitness({
      code: 1,
      stdout: `${JSON.stringify({
        status: "failed",
        error_code: "INSTALLED_HOST_IMPORT_WAV_FAILED",
      })}\n`,
    })).toThrow(expect.objectContaining({
      code: "INSTALLED_HOST_IMPORT_WAV_FAILED",
    }));
  });

  it("条件成立后以指定信号中断真实进程组", async () => {
    const moduleUrl = pathToFileURL(resolve("scripts/release/p1b-probe-process.mjs")).href;
    const probe = await import(moduleUrl) as {
      runCommand(command: string, args: string[], options: object): Promise<{ signal: string }>;
    };
    let readyToInterrupt = false;
    const timer = setTimeout(() => { readyToInterrupt = true; }, 20);
    const result = await probe.runCommand(process.execPath,
      ["-e", "setInterval(() => {}, 1000)"], {
        interruptSignal: "SIGKILL",
        interruptWhen: () => readyToInterrupt,
        timeoutMs: 2_000,
      });
    clearTimeout(timer);

    expect(result.signal).toBe("SIGKILL");
  });

  it("条件谓词异常时立即结束子进程并返回稳定错误", async () => {
    const moduleUrl = pathToFileURL(resolve("scripts/release/p1b-probe-process.mjs")).href;
    const probe = await import(moduleUrl) as {
      runCommand(command: string, args: string[], options: object): Promise<unknown>;
    };

    await expect(probe.runCommand(process.execPath,
      ["-e", "setInterval(() => {}, 1000)"], {
        interruptWhen() { throw new Error("predicate failed"); },
        timeoutMs: 2_000,
      })).rejects.toMatchObject({ code: "INTERRUPT_CONDITION_FAILED" });
  });

  it("不把模型 staging 目录读取错误伪装成尚未观测到", async () => {
    const root = await temporaryRoot();
    await writeFile(join(root, "assets"), "not a directory");
    const moduleUrl = pathToFileURL(resolve("scripts/release/p1b-probe-assets.mjs")).href;
    const probe = await import(moduleUrl) as {
      partialStageFileVisible(dataRoot: string): Promise<boolean>;
    };

    await expect(probe.partialStageFileVisible(root)).rejects.toMatchObject({
      code: "STAGE_OBSERVATION_FAILED",
    });
  });

  it("从已安装包台账锁定 profile 中的 ORT npm integrity", async () => {
    const fixture = await installedIntegrityFixture();

    await expect(verifyInstalledOrtIntegrity(fixture)).resolves.toBe(ORT_INTEGRITY);
  });

  it("拒绝 profile 未锁定已安装包声明的 ORT npm integrity", async () => {
    const fixture = await installedIntegrityFixture(`sha512-${"A".repeat(86)}==`);

    await expect(verifyInstalledOrtIntegrity(fixture)).rejects.toMatchObject({
      code: "ORT_INTEGRITY_NOT_LOCKED",
    });
  });
});

describe("P1b 已安装发布物 probe 报告", () => {
  it("缺少发行制品时生成 content-free No-Go 报告", async () => {
    const root = await temporaryRoot();
    const reportPath = join(root, "report.json");
    const missingCode = join(root, "missing-code.tgz");
    const missingModels = join(root, "missing-models.tar");
    const result = await runProbe([
      "--",
      "--code-tgz", missingCode,
      "--model-pack", missingModels,
      "--wav", join(root, "missing.wav"),
      "--m4a", join(root, "missing.m4a"),
      "--mp3", join(root, "missing.mp3"),
      "--report", reportPath,
    ]);

    expect(result.code).toBe(1);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      gate: "p1b-installed-artifact",
      status: "no_go",
      report_written: true,
    });
    const report = JSON.parse(await readFile(reportPath, "utf8")) as Record<string, unknown>;
    expect(report).toMatchObject({
      schema_version: 1,
      gate: "p1b-installed-artifact",
      engineering_status: "no_go",
      closed_pilot_status: "no_go",
      public_release_status: "no_go",
      checks: [
        { id: "input_code_tgz", status: "failed", error_code: "ARTIFACT_MISSING" },
        { id: "input_model_pack", status: "failed", error_code: "ARTIFACT_MISSING" },
        { id: "input_wav", status: "failed", error_code: "ARTIFACT_MISSING" },
        { id: "input_m4a", status: "failed", error_code: "ARTIFACT_MISSING" },
        { id: "input_mp3", status: "failed", error_code: "ARTIFACT_MISSING" },
      ],
    });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(root);
    expect(serialized).not.toContain("Bitbook");
    expect(serialized).not.toContain("clerki");
  });
});
