import { expect, it, vi } from "vitest";

import type { ClientConnectionRpc } from "@deepseek-ai/dsh-client-connection/client";

import {
  formatMeetingReference,
  createMeetingReferenceSource,
  parseMeetingReference,
} from "../../src/client/meeting-reference-source.js";
import { RecordingRpcClient } from "../../src/client/recording-rpc-client.js";

const MEETING_ID = "11111111-1111-4111-8111-111111111111";

it("把冻结 label 编码成可逆且不暴露裸 ID 的 canonical mention", () => {
  const label = String.raw`产品 [周会] (一) \ 复盘`;
  const mention = formatMeetingReference({ meetingId: MEETING_ID, label });

  expect(mention).toBe(
    String.raw`@[产品 \[周会\] \(一\) \\ 复盘](dsh-meeting:11111111-1111-4111-8111-111111111111)`,
  );
  expect(parseMeetingReference(mention)).toEqual({ meetingId: MEETING_ID, label });
});

it.each([
  "@[产品周会](dsh-meeting:11111111-1111-4111-8111-11111111111A)",
  "@[产品[周会]](dsh-meeting:11111111-1111-4111-8111-111111111111)",
  "@[产品\\x周会](dsh-meeting:11111111-1111-4111-8111-111111111111)",
  "@[产品\n周会](dsh-meeting:11111111-1111-4111-8111-111111111111)",
  "@[产品周会](https://example.com/11111111-1111-4111-8111-111111111111)",
])("拒绝非 canonical 或含控制字符的 Meeting mention: %s", (mention) => {
  expect(() => parseMeetingReference(mention)).toThrow("INVALID_MEETING_REFERENCE");
});

it("通过独立 DSH @ source 查询、选择并在发送时重验冻结引用", async () => {
  const candidate = {
    meeting_id: MEETING_ID,
    label: "产品周会",
    origin: "recording",
    phase: "recording",
    started_at: "2026-09-01T00:00:00.000Z",
    created_at: "2026-09-01T00:00:00.000Z",
    recording_elapsed_ms: 65_000,
    duration_ms: null,
  } as const;
  const call = vi.fn(async (_channel, endpoint) => ({
    ok: true as const,
    value: endpoint === "dsh-asr-recording/references/candidates" ? [candidate] : { ...candidate, label: "已改名" },
  }));
  const source = createMeetingReferenceSource({
    client: new RecordingRpcClient({ call } as ClientConnectionRpc),
    hasReference: () => false,
    locale: () => "zh-CN",
    translate: (key) => `本地化:${key}`,
  });
  const signal = new AbortController().signal;

  const candidates = await source.candidates(
    { sessionId: "session-1" as never },
    { query: "产品", position: "inline", signal, drilled: false },
  );

  expect(source).toMatchObject({ trigger: "@", name: "meeting-reference" });
  expect(call).toHaveBeenNthCalledWith(1, "/api", "dsh-asr-recording/references/candidates", {
    session_id: "session-1",
    locale: "zh-CN",
    query: "产品",
  }, signal);
  expect(candidates).toHaveLength(1);
  expect(candidates[0]).toMatchObject({
    name: "产品周会",
    section: "本地化:section.meetings",
  });
  expect(`${candidates[0]!.name} ${candidates[0]!.description}`).not.toContain(MEETING_ID);

  const outcome = source.onPick({
    candidate: candidates[0]!,
    session: { sessionId: "session-1" as never },
    position: "inline",
    via: "menu",
    action: "pick",
    span: { start: 0, end: 2, draftRev: 1 },
  });
  const mention = formatMeetingReference({ meetingId: MEETING_ID, label: "产品周会" });
  expect(outcome).toEqual({
    insert: {
      source: "meeting-reference",
      ref: mention,
      label: "产品周会",
      clipboardText: mention,
    },
  });
  await expect(source.codec!.serialize(mention, signal)).resolves.toBe(mention);
  expect(call).toHaveBeenNthCalledWith(2, "/api", "dsh-asr-recording/references/resolve", {
    locale: "zh-CN",
    meeting_id: MEETING_ID,
  }, signal);
});

it("同一草稿已有相同 meeting_id 时只消费新触发词", async () => {
  const source = createMeetingReferenceSource({
    client: {} as RecordingRpcClient,
    hasReference: () => true,
    locale: () => "en",
    translate: (key) => key,
  });
  const mention = formatMeetingReference({ meetingId: MEETING_ID, label: "Weekly" });

  expect(source.onPick({
    candidate: { name: "Weekly", value: JSON.stringify({ meetingId: MEETING_ID, label: "Weekly" }) },
    session: { sessionId: "session-1" as never },
    position: "inline",
    via: "menu",
    action: "pick",
    span: { start: 0, end: 2, draftRev: 1 },
  })).toEqual({ text: "" });
  expect(source.codec!.clipboardText(mention)).toBe(mention);
});

it("发送时 Meeting 已失效则让 codec 拒绝而不是降级成普通文本", async () => {
  const source = createMeetingReferenceSource({
    client: {
      resolveMeetingReference: vi.fn(async () => { throw new Error("MEETING_NOT_FOUND"); }),
    } as never,
    hasReference: () => false,
    locale: () => "zh",
    translate: (key) => key,
  });
  const mention = formatMeetingReference({ meetingId: MEETING_ID, label: "产品周会" });

  await expect(source.codec!.serialize(mention, new AbortController().signal))
    .rejects.toThrow("MEETING_NOT_FOUND");
});
