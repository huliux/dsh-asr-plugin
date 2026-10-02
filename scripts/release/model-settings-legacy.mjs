import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runRequired } from "./p1b-probe-process.mjs";

const meetingId = "00000000-0000-4000-8000-000000000001";
const runId = "10000000-0000-4000-8000-000000000001";
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export async function seedLegacyMeeting(archive, world, dataRoot) {
  const root = join(world.root, "legacy-code");
  await mkdir(root);
  await runRequired("/usr/bin/tar", ["-xf", archive, "-C", root], world, "LEGACY_EXTRACT_FAILED");
  const { SCHEMA_VERSION } = await import(pathToFileURL(join(root, "package/dist/storage/schema.js")));
  assert.equal(SCHEMA_VERSION, 3);
  await mkdir(join(dataRoot, "db"), { recursive: true });
  const filename = join(dataRoot, "db/meetings.sqlite3");
  const { openMeetingRepository } = await import(pathToFileURL(join(root, "package/dist/storage/meeting-repository.js")));
  const repository = openMeetingRepository(filename);
  try {
    repository.createImport({ meetingId, runId, title: "Migration witness", sourceName: "witness.wav",
      sourceFormat: "wav", sourceSizeBytes: 1024, nowMs: 1000 });
    const committed = repository.commitTranscript({ meetingId, runId, baseVersion: 0,
      resultStatus: "completed", resultReason: null, durationMs: 2000, engineFingerprint: "a".repeat(64),
      segments: [{ seq: 0, startMs: 0, endMs: 1000, speakerLabel: "Speaker A", text: "Migration witness." }], nowMs: 1001 });
    assert.equal(committed.outcome, "committed");
    return { filename, schemaVersion: SCHEMA_VERSION,
      snapshot: repository.getCommittedTranscriptSnapshot(meetingId) };
  } finally { repository.close(); }
}

export async function verifyLegacyMeeting(seed, packageRoot) {
  const { openMeetingRepository } = await import(pathToFileURL(join(packageRoot, "dist/storage/meeting-repository.js")));
  const { SCHEMA_VERSION } = await import(pathToFileURL(join(packageRoot, "dist/storage/schema.js")));
  const repository = openMeetingRepository(seed.filename);
  try {
    const snapshot = repository.getCommittedTranscriptSnapshot(meetingId);
    const { runIdentity, transcriptIdentity, ...originalFields } = snapshot.meeting;
    assert.equal(runIdentity, null);
    assert.equal(transcriptIdentity, null);
    assert.deepEqual(originalFields, seed.snapshot.meeting);
    assert.deepEqual(snapshot.segments, seed.snapshot.segments);
    assert.equal(SCHEMA_VERSION, 4);
    return { sourceSchema: seed.schemaVersion, targetSchema: SCHEMA_VERSION,
      transcriptVersion: snapshot.meeting.transcriptVersion, segments: snapshot.segments.length,
      originalFieldsSha256: hash(originalFields), segmentsSha256: hash(snapshot.segments),
      originalUnchanged: true, identity: "unknown" };
  } finally { repository.close(); }
}
