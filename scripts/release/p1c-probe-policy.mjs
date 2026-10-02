import { ProbeFailure } from "./p1b-probe-process.mjs";

const MAX_RSS_BYTES = 2 * 1_024 ** 3;
const AUTHOR_RECORDING_KEYS = [
  "mode",
  "success",
  "live_read",
  "qa",
  "on_demand_summary",
  "committed_result_consumed",
  "draft_freshness_under_10s",
  "stop_under_30s",
  "crash_or_data_loss",
];

function record(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
}

function exactKeys(value, keys) {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function finite(value, minimum = 0) {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum;
}

function replayFailure(code) {
  throw new ProbeFailure(code);
}

export function validateReplayWitness(value, minimumDurationMs) {
  const witness = record(value);
  const draft = record(witness?.draft);
  const stop = record(witness?.stop);
  const correctness = record(witness?.correctness);
  const resources = record(witness?.resources);
  if (witness?.status !== "passed" || draft === null || stop === null ||
    correctness === null || resources === null) replayFailure("P1C_REPLAY_REPORT_INVALID");
  if (!finite(witness.duration_ms, minimumDurationMs)) {
    replayFailure("P1C_REPLAY_DURATION_INVALID");
  }
  if (!finite(draft.worst_case_freshness_ms) || draft.worst_case_freshness_ms >= 10_000 ||
    !finite(draft.maximum_backlog_ms)) replayFailure("P1C_REPLAY_FRESHNESS_FAILED");
  if (!finite(stop.stop_to_commit_ms) || stop.stop_to_commit_ms >= 30_000 ||
    stop.under_30_seconds !== true) replayFailure("P1C_REPLAY_STOP_DEADLINE_FAILED");
  if (correctness.exact_segment_match !== true || correctness.result_status_match !== true ||
    correctness.result_reason_match !== true || correctness.duration_ms_match !== true ||
    !Number.isSafeInteger(correctness.incremental_segment_count) ||
    correctness.incremental_segment_count < 0 ||
    correctness.incremental_segment_count !== correctness.reference_segment_count) {
    replayFailure("P1C_REPLAY_CORRECTNESS_FAILED");
  }
  if (!finite(resources.max_rss_bytes) || resources.max_rss_bytes > MAX_RSS_BYTES) {
    replayFailure("P1C_REPLAY_RESOURCE_FAILED");
  }
  return {
    duration_ms: witness.duration_ms,
    stop_to_commit_ms: stop.stop_to_commit_ms,
    worst_case_freshness_ms: draft.worst_case_freshness_ms,
  };
}

function validAuthorRecording(value) {
  const item = record(value);
  if (item === null || !exactKeys(item, AUTHOR_RECORDING_KEYS) ||
    !["mic-only", "system-only", "dual"].includes(item.mode)) return false;
  return AUTHOR_RECORDING_KEYS.slice(1).every((key) => typeof item[key] === "boolean");
}

function validSuccessfulJourney(recording) {
  return !recording.success || (
    recording.live_read && recording.qa && recording.on_demand_summary &&
    recording.committed_result_consumed && recording.draft_freshness_under_10s &&
    recording.stop_under_30s
  );
}

function invalidAuthorEvidence() {
  throw new ProbeFailure("AUTHOR_PRODUCT_EVIDENCE_INVALID");
}

export function evaluateAuthorEvidence(value, codeSha256) {
  const evidence = record(value);
  const permissions = record(evidence?.permissions);
  const rootKeys = ["schema_version", "gate", "code_tgz_sha256", "permissions", "recordings"];
  const permissionKeys = [
    "first_use_prompt_observed",
    "restart_permission_persisted_or_actionable",
  ];
  if (evidence === null || !exactKeys(evidence, rootKeys) || evidence.schema_version !== 1 ||
    evidence.gate !== "p1c-author-product" || evidence.code_tgz_sha256 !== codeSha256 ||
    permissions === null || !exactKeys(permissions, permissionKeys) ||
    permissions.first_use_prompt_observed !== true ||
    permissions.restart_permission_persisted_or_actionable !== true ||
    !Array.isArray(evidence.recordings) || evidence.recordings.length < 5 ||
    !evidence.recordings.every(validAuthorRecording)) invalidAuthorEvidence();
  const recordings = evidence.recordings;
  const successful = recordings.filter((recording) => recording.success);
  const successfulModes = new Set(successful.map((recording) => recording.mode));
  if (successful.length / recordings.length < 0.8 ||
    !["mic-only", "system-only", "dual"].every((mode) => successfulModes.has(mode)) ||
    recordings.some((recording) => recording.crash_or_data_loss ||
      !validSuccessfulJourney(recording))) invalidAuthorEvidence();
  return {
    successful_recordings: successful.length,
    total_recordings: recordings.length,
  };
}
