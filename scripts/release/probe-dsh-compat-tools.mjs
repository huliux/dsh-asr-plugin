import { useInstalledHostModules } from "./installed-host-modules.mjs";
import assert from "node:assert/strict";
import { access, mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [packageRoot, hostEntry, dataRoot] = process.argv.slice(2);
assert.ok(packageRoot && hostEntry && dataRoot);
const hostRequire = createRequire(hostEntry);
const loadHost = (name) => import(pathToFileURL(hostRequire.resolve(`@deepseek-ai/${name}`)).href);
const loadPlugin = (path) => import(pathToFileURL(join(packageRoot, "dist", path)).href);
useInstalledHostModules(hostEntry);
const { Context } = await loadHost("cordis");
const { Session, SessionId } = await loadHost("dsh-session");
const { MEETING_TOOL_NAMES } = await loadPlugin("tools/meeting-tools.js");
const plugin = await loadPlugin("index.js");
const meetingId = "55555555-5555-4555-8555-555555555555";
let sequence = 0;

async function seedMeeting() {
  await mkdir(join(dataRoot, "db"), { recursive: true });
  const { openMeetingRepository } = await loadPlugin("storage/meeting-repository.js");
  const repository = openMeetingRepository(join(dataRoot, "db/meetings.sqlite3"));
  const runId = "66666666-6666-4666-8666-666666666666";
  try {
    repository.createImport({ meetingId, runId, title: "Compatibility fixture",
      sourceName: "fixture.wav", sourceFormat: "wav", sourceSizeBytes: 1024, nowMs: 1000 });
    repository.commitTranscript({ meetingId, runId, baseVersion: 0, resultStatus: "completed",
      resultReason: null, durationMs: 120_000, engineFingerprint: "a".repeat(64), nowMs: 1001,
      segments: Array.from({ length: 120 }, (_, seq) => ({ seq, startMs: seq * 1000,
        endMs: seq * 1000 + 750, speakerLabel: "Speaker A", text: `Fixture segment ${seq}` })),
    });
  } finally { repository.close(); }
}

async function createHost() {
  const context = new Context();
  try {
    for (const name of ["dsh-agent", "dsh-system-prompt", "dsh-tools", "dsh-user-approval",
      "dsh-jobs-local", "dsh-subprocess-local"]) {
      await context.plugin((await loadHost(name)).default);
    }
    const session = Session.create(SessionId("dsh-compat-fixture"));
    session.append("turn/start", { turn: 1 });
    const agent = { id: session.id, ctx: context, session };
    const fiber = await context.plugin(plugin, { data_dir: dataRoot });
    for (const name of MEETING_TOOL_NAMES) assert.ok(context.tools.get(name), name);
    return { context, agent, fiber };
  } catch (error) { await context.fiber.dispose(); throw error; }
}

function call(host, name, args) {
  return host.context.tools.execute({ agent: host.agent, callId: `compat-${++sequence}`,
    name, arguments: args, signal: new AbortController().signal });
}

async function readProjection(host) {
  let cursor;
  let count = 0;
  do {
    const result = await call(host, "meeting_get", { meeting_id: meetingId, projection: "agent",
      ...(cursor === undefined ? {} : { cursor }) });
    assert.equal(result.isError, false);
    for (const segment of result.value.transcript.segments) assert.equal(segment.seq, count++);
    cursor = result.value.transcript.next_cursor ?? undefined;
  } while (cursor !== undefined);
  assert.equal(count, 120);
}

async function exerciseApproval(host) {
  let outcome = "rejected";
  let requests = 0;
  host.context.on("approval/request", async () => { requests++; return outcome; });
  const output = join(dataRoot, "../fixture-export.txt");
  const args = { meeting_id: meetingId, format: "txt", output_path: output };
  assert.equal((await call(host, "meeting_transcript_export", args)).isError, true);
  await assert.rejects(access(output), { code: "ENOENT" });
  outcome = "allowed-once";
  const exported = await call(host, "meeting_transcript_export", args);
  assert.equal(exported.isError, false, JSON.stringify(exported.error));
  assert.equal(exported.value.segment_count, 120);
  assert.equal(exported.value.bytes, (await readFile(output)).byteLength);
  assert.equal(requests, 2);
  assert.equal((await call(host, "meeting_transcript_export", args)).error.info.code,
    "EXPORT_TARGET_EXISTS");
  assert.equal((await call(host, "meeting_transcript_export", { ...args, overwrite: true })).isError,
    false);
}

await seedMeeting();
let host = await createHost();
try {
  await readProjection(host);
  await exerciseApproval(host);
  await host.fiber.dispose();
  for (const name of MEETING_TOOL_NAMES) assert.equal(host.context.tools.get(name), undefined);
} finally { await host.context.fiber.dispose(); }
host = await createHost();
try { await readProjection(host); }
finally { await host.context.fiber.dispose(); }
console.log(JSON.stringify({ status: "passed", registered_tools: MEETING_TOOL_NAMES.length,
  projection_segments: 120, approval_reject_recover: true, export_overwrite: true,
  unload_reload: true }));
