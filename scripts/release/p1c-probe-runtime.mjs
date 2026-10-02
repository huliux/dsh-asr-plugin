import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import {
  FORBIDDEN_SOURCE_MARKERS,
  prepareInstalledRuntime,
} from "./p1b-probe-runtime.mjs";
import { runInstalledProductChecks } from "./p1b-probe-host.mjs";
import { writeReport } from "./p1b-probe-world.mjs";
import { ProbeFailure } from "./p1b-probe-process.mjs";
import {
  runP1cInstalledHostChecks,
  verifyP1cUninstall,
} from "./p1c-probe-host.mjs";
import { evaluateAuthorEvidence } from "./p1c-probe-policy.mjs";
import { runInstalledReplayChecks } from "./p1c-probe-replay.mjs";
import { inspectP1cInputs, prepareP1cWorld } from "./p1c-probe-world.mjs";

export { evaluateAuthorEvidence, validateReplayWitness } from "./p1c-probe-policy.mjs";

async function readAuthorEvidence(world, codeSha256) {
  if (world.artifacts.authorEvidence === undefined) return null;
  try {
    return evaluateAuthorEvidence(
      JSON.parse(await readFile(world.artifacts.authorEvidence, "utf8")),
      codeSha256,
    );
  } catch (error) {
    if (error instanceof ProbeFailure) throw error;
    throw new ProbeFailure("AUTHOR_PRODUCT_EVIDENCE_INVALID");
  }
}

async function runMainline(input, checks, report) {
  const world = await prepareP1cWorld(input);
  try {
    const context = await prepareInstalledRuntime(world, checks, report);
    const host = await runInstalledProductChecks(
      context,
      checks,
      FORBIDDEN_SOURCE_MARKERS,
    );
    const recording = await runP1cInstalledHostChecks(context, host, checks);
    report.recording = {
      draft_revision_observed: recording.draft_revision_observed,
      max_finalization_ms: recording.max_finalization_ms,
      restart_permission_capture: true,
      tracks: ["mic", "system"],
    };
    await runInstalledReplayChecks(context, checks, report);
    await verifyP1cUninstall(
      context,
      join(world.env.DSH_HOME, "dsh-asr-plugin"),
      checks,
    );
    try {
      return {
        author: await readAuthorEvidence(world, report.artifacts.input_code_tgz.sha256),
        authorError: undefined,
      };
    } catch (error) {
      return { author: null, authorError: error };
    }
  } finally {
    await rm(world.root, { force: true, recursive: true });
  }
}

function authorCheck(check) {
  return check.id === "input_author_evidence" || check.id === "author_product_evidence";
}

function engineeringFailure(checks) {
  return checks.some((check) => check.status === "failed" && !authorCheck(check));
}

function engineeringInput(input, checks) {
  return checks.some((check) => check.id === "input_author_evidence" && check.status === "failed")
    ? { ...input, authorEvidence: undefined }
    : input;
}

function recordAuthorOutcome(report, author, error) {
  if (error !== undefined) {
    report.checks.push({
      id: "author_product_evidence",
      status: "failed",
      error_code: error instanceof ProbeFailure ? error.code : "AUTHOR_PRODUCT_EVIDENCE_INVALID",
    });
    report.author_product_status = "no_go";
    return;
  }
  if (author === null) {
    report.checks.push({
      id: "author_product_evidence",
      status: "skipped",
      error_code: "AUTHOR_PRODUCT_GATE_PENDING",
    });
    return;
  }
  report.checks.push({ id: "author_product_evidence", status: "passed" });
  report.author = author;
  report.author_product_status = "go";
}

function initialReport(inspected) {
  return {
    schema_version: 1,
    gate: "p1c-installed-author",
    generated_at: new Date().toISOString(),
    engineering_status: "no_go",
    author_product_status: "pending",
    p1c_status: "no_go",
    p1b_non_author_status: "no_go",
    public_release_status: "no_go",
    artifacts: inspected.artifacts,
    checks: [...inspected.checks],
  };
}

export async function runInstalledP1cProbe(input) {
  const inspected = await inspectP1cInputs(input);
  const report = initialReport(inspected);
  const inputFailure = engineeringFailure(report.checks);
  let author = null;
  let authorError;
  if (!inputFailure) {
    try {
      const outcome = await runMainline(
        engineeringInput(input, report.checks),
        report.checks,
        report,
      );
      author = outcome.author;
      authorError = outcome.authorError;
    } catch (error) {
      report.checks.push({
        id: "probe_mainline",
        status: "failed",
        error_code: error instanceof ProbeFailure ? error.code : "UNEXPECTED_FAILURE",
      });
    }
  }
  if (input.authorEvidence !== undefined && author === null && authorError === undefined &&
    !engineeringFailure(report.checks)) {
    authorError = new ProbeFailure("AUTHOR_PRODUCT_EVIDENCE_INVALID");
  }
  if (!inputFailure) recordAuthorOutcome(report, author, authorError);
  if (!engineeringFailure(report.checks)) report.engineering_status = "go";
  if (report.engineering_status === "go" && report.author_product_status === "go") {
    report.p1c_status = "go";
  }
  await writeReport(input.reportPath, report);
  return { p1cStatus: report.p1c_status };
}
