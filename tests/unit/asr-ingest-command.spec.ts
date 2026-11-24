import { describe, expect, it } from "vitest";

import { OkfError } from "../../src/okf/contracts.js";
import {
  ASR_INGEST_COMMAND_NAME, createAsrIngestCommand, OKF_DIRECTORY_REQUIRED_MESSAGE, parseAsrIngestArgs,
  type AsrIngestCommandDeps, type OkfCommandDefinition,
} from "../../src/okf/asr-ingest-command.js";

const MEETING_ID = "a4f7e766-928b-4a96-87d7-f81921fddd1c";

interface IngestCall {
  readonly meetingId: string;
  readonly force: boolean;
}

interface Harness {
  readonly definition: OkfCommandDefinition;
  readonly calls: IngestCall[];
}

function harness(overrides: Partial<AsrIngestCommandDeps> = {}): Harness {
  const calls: IngestCall[] = [];
  const definition = createAsrIngestCommand({
    directory: () => "/tmp/okf-bundle",
    referencedMeetingId: () => null,
    meeting: meetingId => meetingId === MEETING_ID ? { meetingId, title: "Weekly sync" } : null,
    async ingest(meetingId, options) {
      calls.push({ meetingId, force: options.force });
      return { jobId: "job-1" };
    },
    ...overrides,
  });
  return { definition, calls };
}

describe("parseAsrIngestArgs", () => {
  it("parses a meeting id", () => {
    expect(parseAsrIngestArgs("a4f7e766")).toEqual({ kind: "ok", meetingId: "a4f7e766", force: false });
  });

  it("parses --force before or after the meeting id", () => {
    expect(parseAsrIngestArgs("a4f7e766 --force")).toEqual({ kind: "ok", meetingId: "a4f7e766", force: true });
    expect(parseAsrIngestArgs("--force a4f7e766")).toEqual({ kind: "ok", meetingId: "a4f7e766", force: true });
  });

  it("accepts a bare --force for the referenced meeting", () => {
    expect(parseAsrIngestArgs("--force")).toEqual({ kind: "ok", meetingId: null, force: true });
  });

  it("accepts empty arguments for the referenced meeting", () => {
    expect(parseAsrIngestArgs("   ")).toEqual({ kind: "ok", meetingId: null, force: false });
  });

  it("rejects a duplicate --force", () => {
    expect(parseAsrIngestArgs("--force --force")).toEqual({ kind: "error", message: "Pass --force only once." });
  });

  it("rejects unknown options", () => {
    expect(parseAsrIngestArgs("--bogus")).toEqual({ kind: "error", message: "Unknown option --bogus." });
  });

  it("rejects more than one meeting id", () => {
    expect(parseAsrIngestArgs("one two")).toEqual({ kind: "error", message: "Pass exactly one meeting id." });
  });
});

describe("createAsrIngestCommand", () => {
  it("exposes the runtime metadata", () => {
    const { definition } = harness();
    expect(definition.name).toBe(ASR_INGEST_COMMAND_NAME);
    expect(definition.description).toContain("Open knowledge base");
    expect(definition.input?.hint).toBe("<meeting-id> [--force]");
  });

  it("requires a configured folder", async () => {
    const test = harness({ directory: () => "" });
    const result = await test.definition.handler({ args: MEETING_ID });
    expect(result).toEqual({ kind: "error", text: OKF_DIRECTORY_REQUIRED_MESSAGE });
    expect(test.calls).toHaveLength(0);
  });

  it("treats a throwing folder getter as not configured", async () => {
    const test = harness({ directory: () => { throw new Error("unavailable"); } });
    const result = await test.definition.handler({ args: MEETING_ID });
    expect(result).toEqual({ kind: "error", text: OKF_DIRECTORY_REQUIRED_MESSAGE });
  });

  it("rejects an unknown meeting", async () => {
    const test = harness();
    const result = await test.definition.handler({ args: "not-a-meeting" });
    expect(result.kind).toBe("error");
    expect(result.kind === "error" ? result.text : "").toContain("not-a-meeting");
    expect(test.calls).toHaveLength(0);
  });

  it("uses the referenced meeting for a bare --force", async () => {
    const test = harness({ referencedMeetingId: () => MEETING_ID });
    const result = await test.definition.handler({ args: "--force" });
    expect(result.kind).toBe("success");
    expect(test.calls).toEqual([{ meetingId: MEETING_ID, force: true }]);
  });

  it("requires a referenced meeting when no id is given", async () => {
    const test = harness();
    const result = await test.definition.handler({ args: "" });
    expect(result.kind).toBe("error");
    expect(test.calls).toHaveLength(0);
  });

  it("names the meeting and the job on success", async () => {
    const test = harness();
    const result = await test.definition.handler({ args: MEETING_ID });
    expect(result).toEqual({
      kind: "success",
      text: `Ingestion of "Weekly sync" (${MEETING_ID}) started as job job-1.`,
    });
    expect(test.calls).toEqual([{ meetingId: MEETING_ID, force: false }]);
  });

  it("maps a typed ingestion error to a short message without the cause text", async () => {
    const test = harness({
      ingest: async () => { throw new OkfError("OKF_BUSY", "busy at /secret/bundle"); },
    });
    const result = await test.definition.handler({ args: MEETING_ID });
    expect(result).toEqual({ kind: "error", text: "Another ingestion is already running. Try again when it finishes." });
    expect(result.kind === "error" ? result.text : "").not.toContain("/secret");
  });

  it("maps an untyped failure to a generic message", async () => {
    const test = harness({
      ingest: async () => { throw new Error("boom at /secret/bundle"); },
    });
    const result = await test.definition.handler({ args: MEETING_ID });
    expect(result).toEqual({ kind: "error", text: "Open knowledge base ingestion failed." });
    expect(result.kind === "error" ? result.text : "").not.toContain("/secret");
  });

  it("passes the parsed force flag through", async () => {
    const test = harness();
    await test.definition.handler({ args: `${MEETING_ID} --force` });
    expect(test.calls).toEqual([{ meetingId: MEETING_ID, force: true }]);
  });
});
