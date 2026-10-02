import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
const CODE_SHA256 = "a".repeat(64);

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dsh-asr-p1c-probe-test-"));
  roots.push(root);
  return root;
}

async function runProbe(arguments_: readonly string[]): Promise<{
  code: number | null;
  stderr: string;
  stdout: string;
}> {
  const child = spawn(process.execPath, [resolve("scripts/probe-p1c.mjs"), ...arguments_], {
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

async function p1cRuntime() {
  const moduleUrl = pathToFileURL(resolve("scripts/release/p1c-probe-runtime.mjs")).href;
  return import(moduleUrl) as Promise<{
    evaluateAuthorEvidence(value: unknown, codeSha256: string): {
      successful_recordings: number;
      total_recordings: number;
    };
    validateReplayWitness(value: unknown, minimumDurationMs: number): {
      duration_ms: number;
      stop_to_commit_ms: number;
      worst_case_freshness_ms: number;
    };
  }>;
}

async function p1cWorld() {
  const moduleUrl = pathToFileURL(resolve("scripts/release/p1c-probe-world.mjs")).href;
  return import(moduleUrl) as Promise<{
    prepareP1cWorld(input: Record<string, unknown>): Promise<{
      root: string;
      env: Record<string, string>;
    }>;
  }>;
}

async function p1cHost() {
  const moduleUrl = pathToFileURL(resolve("scripts/release/p1c-probe-host.mjs")).href;
  return import(moduleUrl) as Promise<{
    validateRecordingWitness(value: unknown): unknown;
  }>;
}

function authorRecording(mode: "mic-only" | "system-only" | "dual", success = true) {
  return {
    mode,
    success,
    live_read: success,
    qa: success,
    on_demand_summary: success,
    committed_result_consumed: success,
    draft_freshness_under_10s: success,
    stop_under_30s: success,
    crash_or_data_loss: false,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("P1c 已安装制品 probe 报告", () => {
  it("在用户 Cache 下创建签名录音 Helper 可启动的随机隔离环境", async () => {
    const inputRoot = await temporaryRoot();
    const artifact = join(inputRoot, "artifact.bin");
    await writeFile(artifact, "probe");
    const { prepareP1cWorld } = await p1cWorld();
    const world = await prepareP1cWorld({
      codeTgz: artifact,
      modelPack: artifact,
      audio: { wav: artifact, m4a: artifact, mp3: artifact },
      replays: { replay30m: artifact, replay60m: artifact, replay180m: artifact },
    });
    roots.push(world.root);

    expect(world.root).toMatch(new RegExp(
      `^${join(homedir(), "Library", "Caches", "dsh-asr-p1c-installed-")}`,
    ));
    expect(world.env.DSH_HOME).toBe(join(world.root, "dsh-home"));
  });

  it("缺少发行物和三档回放输入时生成 content-free No-Go 报告", async () => {
    const root = await temporaryRoot();
    const reportPath = join(root, "report.json");
    const result = await runProbe([
      "--",
      "--code-tgz", join(root, "missing-code.tgz"),
      "--model-pack", join(root, "missing-models.tar"),
      "--wav", join(root, "missing.wav"),
      "--m4a", join(root, "missing.m4a"),
      "--mp3", join(root, "missing.mp3"),
      "--replay-30m", join(root, "missing-30m.wav"),
      "--replay-60m", join(root, "missing-60m.wav"),
      "--replay-180m", join(root, "missing-180m.wav"),
      "--report", reportPath,
    ]);

    expect(result.code).toBe(1);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      gate: "p1c-installed-author",
      status: "no_go",
      report_written: true,
    });
    const report = JSON.parse(await readFile(reportPath, "utf8")) as Record<string, unknown>;
    expect(report).toMatchObject({
      schema_version: 1,
      gate: "p1c-installed-author",
      engineering_status: "no_go",
      author_product_status: "pending",
      p1b_non_author_status: "no_go",
      public_release_status: "no_go",
      checks: [
        { id: "input_code_tgz", status: "failed", error_code: "ARTIFACT_MISSING" },
        { id: "input_model_pack", status: "failed", error_code: "ARTIFACT_MISSING" },
        { id: "input_wav", status: "failed", error_code: "ARTIFACT_MISSING" },
        { id: "input_m4a", status: "failed", error_code: "ARTIFACT_MISSING" },
        { id: "input_mp3", status: "failed", error_code: "ARTIFACT_MISSING" },
        { id: "input_replay_30m", status: "failed", error_code: "ARTIFACT_MISSING" },
        { id: "input_replay_60m", status: "failed", error_code: "ARTIFACT_MISSING" },
        { id: "input_replay_180m", status: "failed", error_code: "ARTIFACT_MISSING" },
      ],
    });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(root);
    expect(serialized).not.toContain("Bitbook");
    expect(serialized).not.toContain("clerki");
  });

  it("拒绝未知参数且不写报告", async () => {
    const root = await temporaryRoot();
    const reportPath = join(root, "report.json");
    const result = await runProbe(["--unknown", "value", "--report", reportPath]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("usage: node scripts/probe-p1c.mjs");
    await expect(readFile(reportPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("P1c 长回放与作者证据门", () => {
  it("已安装 Host 旅程覆盖长原稿投影与原稿导出恢复", async () => {
    const runner = await readFile("scripts/release/probe-installed-host.mjs", "utf8");

    expect(runner).toContain("async function waitForDualRecording");
    expect(runner).toContain("await waitForDualRecording(host, started)");
    expect(runner).toContain(
      'view.mic.state === "on" ? "mic_on" : "system_on"',
    );
    expect(runner).toContain("await waitForDualRecording(host, micStarted)");
    expect(runner).toContain("await waitForDualRecording(host, systemStarted)");
    expect(runner).toContain('projection: "agent"');
    expect(runner).toContain('"meeting_transcript_export"');
    expect(runner).toContain('format: "md"');
    expect(runner).toContain('format: "srt"');
    expect(runner).toContain('overwrite: true');
  });

  it("拒绝缺少 revision 或停止时延的录音 witness", async () => {
    const { validateRecordingWitness } = await p1cHost();
    const valid = {
      status: "passed",
      draft_revision_observed: 1,
      max_finalization_ms: 500,
      first_use_tracks: ["mic", "system"],
      restart_tracks: ["mic", "system"],
      result_statuses: ["empty", "partial"],
    };

    expect(validateRecordingWitness(valid)).toBe(valid);
    for (const invalid of [
      { ...valid, draft_revision_observed: undefined },
      { ...valid, max_finalization_ms: undefined },
      { ...valid, max_finalization_ms: -1 },
    ]) {
      expect(() => validateRecordingWitness(invalid)).toThrow(expect.objectContaining({
        code: "INSTALLED_RECORDING_WITNESS_INVALID",
      }));
    }
  });

  it("让从零参考链使用与增量链隔离的全新 cache", async () => {
    const runner = await readFile(
      "scripts/release/probe-installed-recording-replay.mjs",
      "utf8",
    );

    expect(runner).toContain('join(resources.runRoot, "incremental-cache")');
    expect(runner).toContain('join(resources.runRoot, "reference-cache")');
  });

  it("只接受逐段等价、草稿小于 10 秒、停止小于 30 秒且不超资源的回放", async () => {
    const { validateReplayWitness } = await p1cRuntime();
    const valid = {
      status: "passed",
      duration_ms: 10_900_000,
      draft: { worst_case_freshness_ms: 8_250, maximum_backlog_ms: 500 },
      stop: { stop_to_commit_ms: 19_500, under_30_seconds: true },
      correctness: {
        exact_segment_match: true,
        incremental_segment_count: 400,
        reference_segment_count: 400,
        result_status_match: true,
        result_reason_match: true,
        duration_ms_match: true,
      },
      resources: { max_rss_bytes: 1_900_000_000 },
    };

    expect(validateReplayWitness(valid, 10_800_000)).toEqual({
      duration_ms: 10_900_000,
      stop_to_commit_ms: 19_500,
      worst_case_freshness_ms: 8_250,
    });
    for (const invalid of [
      { ...valid, duration_ms: 10_799_999 },
      { ...valid, draft: { ...valid.draft, worst_case_freshness_ms: 10_000 } },
      { ...valid, stop: { stop_to_commit_ms: 30_000, under_30_seconds: false } },
      { ...valid, correctness: { ...valid.correctness, exact_segment_match: false } },
      { ...valid, correctness: { ...valid.correctness, result_reason_match: false } },
      { ...valid, resources: { max_rss_bytes: 2 * 1_024 ** 3 + 1 } },
    ]) {
      expect(() => validateReplayWitness(invalid, 10_800_000)).toThrow(
        expect.objectContaining({ code: expect.stringMatching(/^P1C_REPLAY_/) }),
      );
    }
  });

  it("作者证据绑定安装包并要求五场、三种轨道和至少 80% 完整闭环", async () => {
    const { evaluateAuthorEvidence } = await p1cRuntime();
    const valid = {
      schema_version: 1,
      gate: "p1c-author-product",
      code_tgz_sha256: CODE_SHA256,
      permissions: {
        first_use_prompt_observed: true,
        restart_permission_persisted_or_actionable: true,
      },
      recordings: [
        authorRecording("mic-only"),
        authorRecording("system-only"),
        authorRecording("dual"),
        authorRecording("dual"),
        authorRecording("mic-only", false),
      ],
    };

    expect(evaluateAuthorEvidence(valid, CODE_SHA256)).toEqual({
      successful_recordings: 4,
      total_recordings: 5,
    });
    for (const invalid of [
      { ...valid, code_tgz_sha256: "b".repeat(64) },
      { ...valid, recordings: valid.recordings.slice(0, 4) },
      { ...valid, recordings: valid.recordings.map(() => authorRecording("dual")) },
      { ...valid, recordings: [
        authorRecording("mic-only", false),
        authorRecording("system-only"),
        authorRecording("dual"),
        authorRecording("dual"),
        authorRecording("system-only"),
      ] },
      { ...valid, recordings: [
        authorRecording("mic-only"),
        authorRecording("system-only"),
        authorRecording("dual"),
        authorRecording("dual", false),
        authorRecording("mic-only", false),
      ] },
      { ...valid, recordings: [
        { ...authorRecording("mic-only"), crash_or_data_loss: true },
        ...valid.recordings.slice(1),
      ] },
    ]) {
      expect(() => evaluateAuthorEvidence(invalid, CODE_SHA256)).toThrow(
        expect.objectContaining({ code: "AUTHOR_PRODUCT_EVIDENCE_INVALID" }),
      );
    }
  });
});
