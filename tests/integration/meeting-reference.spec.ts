import { expect, it } from "vitest";

import { createMeetingApplicationHarness } from "../helpers/meeting-application-fixture.js";
import { commitMeeting, meetingId } from "../helpers/meeting-repository-fixture.js";

it("通过 Application 返回最多 20 个非 deleting 的最近 Meeting 候选", async () => {
  const harness = await createMeetingApplicationHarness();
  try {
    for (let index = 1; index <= 25; index += 1) {
      commitMeeting(harness.repository, index, {
        texts: [`会议 ${index} 正文`],
        title: `会议 ${index}`,
      });
    }
    harness.repository.beginDeletion({
      meetingId: meetingId(25),
      expectedVersion: 1,
      nowMs: 26_000,
    });

    const candidates = harness.application.getMeetingReferenceCandidates({ locale: "zh-CN" });

    expect(candidates).toHaveLength(20);
    expect(candidates.map((candidate) => candidate.meetingId)).toEqual(
      Array.from({ length: 20 }, (_, offset) => meetingId(24 - offset)),
    );
    expect(candidates[0]).toEqual({
      meetingId: meetingId(24),
      label: "会议 24",
      origin: "import",
      phase: "completed",
      startedAtMs: null,
      createdAtMs: 24_000,
      recordingElapsedMs: null,
      durationMs: 1_000,
    });
  } finally {
    await harness.dispose();
  }
});

it("按标题的 exact、prefix、substring 依次排序 Meeting 候选", async () => {
  const harness = await createMeetingApplicationHarness();
  try {
    commitMeeting(harness.repository, 1, { texts: ["一"], title: "Roadmap" });
    commitMeeting(harness.repository, 2, { texts: ["二"], title: "Roadmap Review" });
    commitMeeting(harness.repository, 3, { texts: ["三"], title: "Q3 Roadmap Notes" });
    commitMeeting(harness.repository, 4, { texts: ["四"], title: "roadmap" });
    commitMeeting(harness.repository, 5, { texts: ["五"], title: "Unrelated" });

    const candidates = harness.application.getMeetingReferenceCandidates({
      locale: "en-US",
      query: "  ROADMAP  ",
    });

    expect(candidates.map((candidate) => candidate.meetingId)).toEqual([
      meetingId(4),
      meetingId(1),
      meetingId(2),
      meetingId(3),
    ]);
  } finally {
    await harness.dispose();
  }
});

it("提交重验只解析仍可引用的 Meeting", async () => {
  const harness = await createMeetingApplicationHarness();
  try {
    commitMeeting(harness.repository, 1, { texts: ["正文"], title: "产品周会" });

    expect(harness.application.resolveMeetingReference({
      meetingId: meetingId(1),
      locale: "zh-CN",
    })).toMatchObject({ meetingId: meetingId(1), label: "产品周会", phase: "completed" });

    harness.repository.beginDeletion({
      meetingId: meetingId(1),
      expectedVersion: 1,
      nowMs: 2_000,
    });
    expect(() => harness.application.resolveMeetingReference({
      meetingId: meetingId(1),
      locale: "zh-CN",
    })).toThrow(expect.objectContaining({ code: "MEETING_NOT_FOUND" }));
    expect(() => harness.application.resolveMeetingReference({
      meetingId: meetingId(99),
      locale: "zh-CN",
    })).toThrow(expect.objectContaining({ code: "MEETING_NOT_FOUND" }));
  } finally {
    await harness.dispose();
  }
});

it("候选查询只额外匹配导入文件名主体，不读取正文", async () => {
  const harness = await createMeetingApplicationHarness();
  try {
    commitMeeting(harness.repository, 1, {
      sourceName: "Customer-Roadmap.wav",
      texts: ["正文含有 secret-term"],
      title: "客户访谈",
    });

    expect(harness.application.getMeetingReferenceCandidates({
      locale: "en-US",
      query: "customer-roadmap",
    })).toEqual([expect.objectContaining({ meetingId: meetingId(1), label: "客户访谈" })]);
    expect(harness.application.getMeetingReferenceCandidates({
      locale: "en-US",
      query: "secret-term",
    })).toEqual([]);
  } finally {
    await harness.dispose();
  }
});

it("候选与提交重验使用同一稳定 locale 输入错误", async () => {
  const harness = await createMeetingApplicationHarness();
  try {
    commitMeeting(harness.repository, 1, { texts: ["正文"], title: "产品周会" });

    expect(() => harness.application.getMeetingReferenceCandidates({ locale: "not_[a_locale" }))
      .toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
    expect(() => harness.application.resolveMeetingReference({
      locale: "not_[a_locale",
      meetingId: meetingId(1),
    })).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
  } finally {
    await harness.dispose();
  }
});
