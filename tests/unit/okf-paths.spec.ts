import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import type { OkfMeetingView } from "../../src/okf/contracts.js";
import { OkfError } from "../../src/okf/contracts.js";
import {
  OKF_ACTIONS_INDEX,
  OKF_ROOT_INDEX,
  OKF_TRANSCRIPTS_DIRECTORY,
  actionRelativePath,
  assertSafeRelativePath,
  meetingRelativePath,
  normalizeOkfSlug,
  resolveBundlePath,
  transcriptCopyRelativePath,
} from "../../src/okf/paths.js";

function meeting(overrides: Partial<OkfMeetingView> = {}): OkfMeetingView {
  return {
    meetingId: "11111111-1111-4111-8111-111111111111",
    title: "Weekly product sync",
    startedAtMs: Date.parse("2026-11-20T09:00:00.000Z"),
    durationMs: 60_000,
    speakers: ["Alice"],
    transcriptVersion: 1,
    committedAtMs: Date.parse("2026-11-20T09:05:00.000Z"),
    partial: false,
    segments: [],
    ...overrides,
  };
}

describe("normalizeOkfSlug", () => {
  it.each([
    ["Weekly Product Sync", "weekly-product-sync"],
    ["Café: Überblick!", "cafe-uberblick"],
    ["  --Hello---World--  ", "hello-world"],
    ["Meeting / 42", "meeting-42"],
    ["2026 Q4 OKRs", "2026-q4-okrs"],
    ["日本語のみ", "m-1864ec8f"],
    ["   ", "m-e3b0c442"],
    ["😀🚀", "m-bb1f6c3c"],
  ])("turns %j into %j", (input, expected) => {
    expect(normalizeOkfSlug(input)).toBe(expected);
  });

  it("caps long titles at a word boundary without a trailing separator", () => {
    const slug = normalizeOkfSlug("a very long title that keeps going and going beyond sixty characters in total length");
    expect(slug).toBe("a-very-long-title-that-keeps-going-and-going-beyond-sixty");
    expect(slug.length).toBeLessThanOrEqual(60);
    expect(slug.endsWith("-")).toBe(false);
  });

  it("is a pure function of the trimmed text", () => {
    expect(normalizeOkfSlug("  Weekly Product Sync  ")).toBe(normalizeOkfSlug("Weekly Product Sync"));
  });
});

describe("meetingRelativePath", () => {
  it("uses the UTC calendar date, never the writer's local date", () => {
    // 23:30 UTC is already the next day in Europe and Asia; the bundle keeps UTC.
    expect(meetingRelativePath(meeting({ startedAtMs: Date.parse("2026-11-20T23:30:00.000Z") })))
      .toBe("meetings/2026-11-20-weekly-product-sync.md");
  });

  it("zero-pads single-digit months and days", () => {
    expect(meetingRelativePath(meeting({
      startedAtMs: Date.parse("2026-01-05T00:00:00.000Z"),
      title: "Kickoff",
    }))).toBe("meetings/2026-01-05-kickoff.md");
  });
});

describe("transcriptCopyRelativePath", () => {
  it("keys the copy by meeting id under references/transcripts", () => {
    expect(transcriptCopyRelativePath("11111111-1111-4111-8111-111111111111"))
      .toBe(`${OKF_TRANSCRIPTS_DIRECTORY}/11111111-1111-4111-8111-111111111111.md`);
  });

  it.each([
    ["Meeting / 42", "references/transcripts/meeting-42.md"],
    ["ABC", "references/transcripts/abc.md"],
  ])("keeps %j addressable as %j", (meetingId, expected) => {
    expect(transcriptCopyRelativePath(meetingId)).toBe(expected);
  });

  it("falls back to a hash for ids that cannot be a file name", () => {
    expect(transcriptCopyRelativePath("..")).toMatch(/^references\/transcripts\/m-[0-9a-f]{8}\.md$/u);
    expect(transcriptCopyRelativePath("  ")).toMatch(/^references\/transcripts\/m-[0-9a-f]{8}\.md$/u);
  });
});

describe("actionRelativePath", () => {
  it("derives the page from the action title", () => {
    expect(actionRelativePath({ title: "Ship it: now" })).toBe("actions/ship-it-now.md");
    expect(actionRelativePath({ title: "日本語" })).toMatch(/^actions\/m-[0-9a-f]{8}\.md$/u);
    expect(actionRelativePath({ title: "Ship it: now" })).not.toBe(OKF_ACTIONS_INDEX);
  });
});

describe("assertSafeRelativePath", () => {
  it.each([
    OKF_ROOT_INDEX,
    "meetings/2026-11-20-weekly-product-sync.md",
    "entities/person/jane_doe.md",
    "a.b/c-d_e.md",
    OKF_ACTIONS_INDEX,
  ])("accepts %j", (relativePath) => {
    expect(() => assertSafeRelativePath(relativePath)).not.toThrow();
  });

  it.each([
    ["", "empty path"],
    ["/etc/passwd", "absolute"],
    ["a\\b.md", "backslash"],
    ["a//b.md", "empty segment"],
    ["a/", "empty segment"],
    ["./a.md", "dot segment"],
    ["a/./b.md", "dot segment"],
    ["a/../b.md", "dot segment"],
    ["..", "dot segment"],
    ["Upper.md", "uppercase"],
    ["a b.md", "space"],
    ["a\tb.md", "control"],
    ["å.md", "non-ascii"],
  ])("rejects %j (%s)", (relativePath) => {
    try {
      assertSafeRelativePath(relativePath);
    } catch (error) {
      expect(error).toBeInstanceOf(OkfError);
      expect((error as OkfError).code).toBe("OKF_PATH_ESCAPE");
      return;
    }
    expect.unreachable(`${JSON.stringify(relativePath)} should have been rejected`);
  });
});

describe("resolveBundlePath", () => {
  const created: string[] = [];

  async function tempDir(prefix: string): Promise<string> {
    const directory = await mkdtemp(path.join(tmpdir(), prefix));
    created.push(directory);
    return directory;
  }

  afterAll(async () => {
    for (const directory of created) await rm(directory, { recursive: true, force: true });
  });

  it("joins a safe path under the root, creating nothing", async () => {
    const root = await tempDir("okf-root-");
    await expect(resolveBundlePath(root, "meetings/x.md")).resolves.toBe(path.resolve(root, "meetings/x.md"));
    await expect(resolveBundlePath(root, "index.md")).resolves.toBe(path.resolve(root, OKF_ROOT_INDEX));
  });

  it("rejects traversal before touching the filesystem", async () => {
    const root = await tempDir("okf-root-");
    await expect(resolveBundlePath(root, "../escape.md")).rejects.toMatchObject({ code: "OKF_PATH_ESCAPE" });
  });

  it("accepts a pre-resolved real root", async () => {
    const root = await tempDir("okf-root-");
    const realRoot = await realpath(root);
    await expect(resolveBundlePath(root, "actions/a.md", realRoot)).resolves.toBe(path.resolve(root, "actions/a.md"));
  });

  it("rejects a symlinked parent that leaves the bundle", async () => {
    const root = await tempDir("okf-root-");
    const outside = await tempDir("okf-outside-");
    await mkdir(path.join(root, "meetings"), { recursive: true });
    await symlink(outside, path.join(root, "escape"));
    await expect(resolveBundlePath(root, "escape/notes.md")).rejects.toMatchObject({ code: "OKF_PATH_ESCAPE" });
  });

  it("rejects a sibling directory whose name only shares the root prefix", async () => {
    const root = await tempDir("okf-root-");
    const sibling = `${root}-evil`;
    created.push(sibling);
    await mkdir(sibling, { recursive: true });
    await symlink(sibling, path.join(root, "sibling"));
    await expect(resolveBundlePath(root, "sibling/notes.md")).rejects.toMatchObject({ code: "OKF_PATH_ESCAPE" });
  });

  it("allows a symlinked parent that stays inside the bundle", async () => {
    const root = await tempDir("okf-root-");
    await mkdir(path.join(root, "real"), { recursive: true });
    await symlink(path.join(root, "real"), path.join(root, "link"));
    await expect(resolveBundlePath(root, "link/notes.md")).resolves.toBe(path.resolve(root, "link/notes.md"));
  });
});
