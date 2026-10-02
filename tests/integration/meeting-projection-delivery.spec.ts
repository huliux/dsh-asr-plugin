import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { Agent } from "@deepseek-ai/dsh-agent";
import { ToolCallId } from "@deepseek-ai/dsh-llm";
import { Session, SessionId } from "@deepseek-ai/dsh-session";
import { expect, it } from "vitest";

import { registerMeetingTools } from "../../src/tools/meeting-tools.js";
import { decodeTranscriptCursor, encodeTranscriptCursor } from "../../src/storage/query-cursor.js";
import { createMeetingApplicationHarness } from "../helpers/meeting-application-fixture.js";
import { commitMeeting, meetingId } from "../helpers/meeting-repository-fixture.js";

const installedDsh = process.env.DSH_SPILL_PACKAGE_JSON;

it.skipIf(installedDsh === undefined)("真实 DSH spill 后 Agent 仍能逐页读取全部原稿", async () => {
  const resolveInstalled = createRequire(installedDsh!);
  const spill = await import(pathToFileURL(resolveInstalled.resolve("@deepseek-ai/dsh-spill-policy")).href);
  const local = await import(pathToFileURL(resolveInstalled.resolve("@deepseek-ai/dsh-spill-local")).href);
  const tools = await import(pathToFileURL(resolveInstalled.resolve("@deepseek-ai/dsh-tools")).href);
  const prompt = await import(pathToFileURL(resolveInstalled.resolve("@deepseek-ai/dsh-system-prompt")).href);
  const root = await mkdtemp(join(tmpdir(), "dsh-asr-delivery-"));
  const harness = await createMeetingApplicationHarness();
  const context = harness.context;
  try {
    await context.plugin(prompt.default);
    await context.plugin(tools.default);
    await context.plugin(local.default, { root, cleanupPeriodDays: 0 });
    await context.plugin(spill, { maxInlineBytes: 50_000 });
    registerMeetingTools(context, harness.application);
    const agent = { ctx: context, session: Session.create(SessionId("delivery-test")) } as Agent;
    const texts = Array.from({ length: 1_499 }, (_, seq) => `${seq}: 中文 <&> English 🎙`.repeat(5));
    commitMeeting(harness.repository, 90, { texts });
    const received: string[] = [];
    let cursor: string | undefined;
    let firstCursor: string | undefined;
    do {
      const result = await context.tools.execute({
        agent, callId: ToolCallId(`delivery-${received.length}`), name: "meeting_get",
        arguments: { meeting_id: meetingId(90), projection: "agent", ...(cursor ? { cursor } : {}) },
        signal: new AbortController().signal,
      });
      expect(result.isError).toBe(false);
      const text = result.content.map((block) => block.type === "text" ? block.text : "").join("");
      expect(text.includes("Full formatted result stored at:")).toBe(false);
      expect(text).toContain("核对同一版本各页 seq 从 0 连续到 total_segments-1");
      const page = JSON.parse(text.split("<meeting_data>\n")[1]!.split("\n</meeting_data>")[0]!);
      for (const segment of page.transcript.segments) {
        expect(segment.seq).toBe(received.length);
        received.push(segment.text);
      }
      cursor = page.transcript.next_cursor ?? undefined;
      firstCursor ??= cursor;
      expect(page.transcript.coverage.complete).toBe(cursor === undefined);
      expect(page.transcript.coverage.rendered_bytes).toBe(Buffer.byteLength(text));
    } while (cursor !== undefined);
    expect(received).toEqual(texts);
    const skippedCursor = encodeTranscriptCursor({
      meetingId: meetingId(90), version: 1, projection: "agent", lastSeq: 499,
      nextSegmentDigest: decodeTranscriptCursor(firstCursor!).nextSegmentDigest!,
    });
    const skipped = await context.tools.execute({
      agent, callId: ToolCallId("delivery-skipped"), name: "meeting_get",
      arguments: { meeting_id: meetingId(90), projection: "agent", cursor: skippedCursor },
      signal: new AbortController().signal,
    });
    expect(skipped).toMatchObject({
      isError: true,
      error: { message: expect.stringContaining("restart from the first page") },
    });
    const failureText = skipped.content.map((block) => block.type === "text" ? block.text : "").join("");
    expect(failureText).toContain("restart from the first page");
  } finally {
    await harness.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
