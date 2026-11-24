import { describe, expect, it } from "vitest";

import type { OkfActionItem, OkfBundleRow, OkfDeadline, OkfFile } from "../../src/okf/contracts.js";
import { readOkfPages, renderRollups } from "../../src/okf/rollups.js";

const MEETING_ID = "11111111-1111-4111-8111-111111111111";
const GENERATED_AT = Date.parse("2026-11-24T12:00:00.000Z");

function lines(...items: readonly string[]): string {
  return `${items.join("\n")}\n`;
}

function meeting(overrides: Partial<OkfBundleRow> = {}): OkfBundleRow {
  return {
    meetingId: MEETING_ID,
    title: "Weekly product sync",
    relativePath: "meetings/2026-11-20-weekly-product-sync.md",
    startedAtMs: Date.parse("2026-11-20T09:00:00.000Z"),
    status: "draft",
    actionCount: 2,
    deadlineCount: 1,
    ...overrides,
  };
}

function action(overrides: Partial<OkfActionItem>): OkfActionItem {
  return { id: "a0", title: "Action", state: "open", sources: [], ...overrides };
}

function deadline(overrides: Partial<OkfDeadline>): OkfDeadline {
  return { id: "d0", title: "Deadline", dueAtMs: GENERATED_AT, state: "open", meetingId: "m1", ...overrides };
}

function fixture(): {
  readonly generatedAtMs: number;
  readonly meetings: readonly OkfBundleRow[];
  readonly actions: readonly OkfActionItem[];
  readonly deadlines: readonly OkfDeadline[];
} {
  return {
    generatedAtMs: GENERATED_AT,
    meetings: [meeting()],
    actions: [
      action({ id: "a2", title: "Second [action]", dueAtMs: Date.parse("2026-11-20T00:00:00.000Z"), owner: "Alice" }),
      action({ id: "a1", title: "First action", dueAtMs: Date.parse("2026-11-26T00:00:00.000Z") }),
      action({ id: "a3", title: "No date" }),
      action({ id: "a4", title: "Done thing", state: "done" }),
    ],
    deadlines: [
      deadline({ id: "d1", title: "Ship it", dueAtMs: Date.parse("2026-11-22T00:00:00.000Z") }),
      deadline({ id: "d2", title: "Plan", dueAtMs: Date.parse("2026-11-27T00:00:00.000Z"), owner: "Bob" }),
      deadline({ id: "d3", title: "Later", dueAtMs: Date.parse("2027-01-01T00:00:00.000Z") }),
    ],
  };
}

function page(files: readonly OkfFile[], relativePath: string): string {
  const found = files.find((file) => file.relativePath === relativePath);
  if (found === undefined) throw new Error(`missing page ${relativePath}`);
  return found.content;
}

describe("renderRollups", () => {
  it("emits the index pages in layout order", () => {
    expect(renderRollups(fixture()).map((file) => file.relativePath)).toEqual([
      "index.md",
      "meetings/index.md",
      "actions/index.md",
      "deadlines/index.md",
    ]);
  });

  it("renders the actions index from open and closed items", () => {
    expect(page(renderRollups(fixture()), "actions/index.md")).toBe(lines(
      "---",
      "type: Index",
      "title: Actions",
      'generated_at: "2026-11-24T12:00:00.000Z"',
      "---",
      "",
      "# Actions",
      "",
      "Open items come first: dated items by due date, then undated items by title.",
      "Closed items are counted only.",
      "",
      "## Open",
      "",
      "- [Second \\[action\\]](./second-action.md) — due 2026-11-20 (overdue by 5 days) · **overdue** · owner: Alice",
      "- [First action](./first-action.md) — due 2026-11-26 (in 2 days) · due soon",
      "- [No date](./no-date.md) — no due date",
      "",
      "## Closed",
      "",
      "1 done, 0 dropped.",
    ));
  });

  it("renders the deadlines index grouped by urgency", () => {
    expect(page(renderRollups(fixture()), "deadlines/index.md")).toBe(lines(
      "---",
      "type: Index",
      "title: Deadlines",
      'generated_at: "2026-11-24T12:00:00.000Z"',
      "---",
      "",
      "# Deadlines",
      "",
      "Open deadlines, grouped by how soon they are due at 2026-11-24T12:00:00.000Z.",
      "",
      "## Overdue",
      "",
      "- **Ship it** — due 2026-11-22 (overdue by 3 days) · meeting m1",
      "",
      "## Next 7 days",
      "",
      "- **Plan** — due 2026-11-27 (in 3 days) · owner: Bob · meeting m1",
      "",
      "## Later",
      "",
      "- **Later** — due 2027-01-01 (in 38 days) · meeting m1",
      "",
      "## No date",
      "",
      "None yet.",
    ));
  });

  it("counts meetings, open actions and overdue deadlines on the root page", () => {
    const root = page(renderRollups(fixture()), "index.md");
    expect(root).toContain("## Counts\n\n- Meetings: 1\n- Open actions: 3\n- Overdue deadlines: 1\n");
    expect(root).toContain("- [Meetings](./meetings/index.md)\n- [Actions](./actions/index.md)\n- [Deadlines](./deadlines/index.md)");
    expect(root).toContain("- [Weekly product sync](./meetings/2026-11-20-weekly-product-sync.md) — 2026-11-20 · draft · 2 actions · 1 deadlines");
  });

  it("links the meetings index relative to its own directory", () => {
    const meetings = page(renderRollups(fixture()), "meetings/index.md");
    expect(meetings).toContain("- [Weekly product sync](./2026-11-20-weekly-product-sync.md) — 2026-11-20 · draft · 2 actions · 1 deadlines");
  });

  it("escapes link text so a title cannot inject markup", () => {
    const files = renderRollups({ ...fixture(), meetings: [meeting({ title: "Design [Q4](x)" })] });
    expect(page(files, "index.md")).toContain("[Design \\[Q4\\]\\(x\\)]");
    expect(page(files, "meetings/index.md")).toContain("[Design \\[Q4\\]\\(x\\)]");
  });

  it("lists at most ten recent meetings, newest first", () => {
    const meetings = Array.from({ length: 12 }, (_, index) => meeting({
      meetingId: `meeting-${index}`,
      title: `Meeting ${index}`,
      relativePath: `meetings/2026-11-${String(index + 1).padStart(2, "0")}-meeting-${index}.md`,
      startedAtMs: Date.parse(`2026-11-${String(index + 1).padStart(2, "0")}T09:00:00.000Z`),
    }));
    const root = page(renderRollups({ ...fixture(), meetings }), "index.md");
    const recent = root.slice(root.indexOf("## Recent meetings"));
    expect(recent.split("\n").filter((line) => line.startsWith("- ["))).toHaveLength(10);
    expect(recent.indexOf("[Meeting 11]")).toBeLessThan(recent.indexOf("[Meeting 10]"));
    expect(recent).not.toContain("[Meeting 1]");
  });

  it("renders empty bundles with explicit 'None yet' sections", () => {
    const files = renderRollups({ generatedAtMs: GENERATED_AT, meetings: [], actions: [], deadlines: [] });
    expect(page(files, "index.md")).toContain("## Recent meetings\n\nNone yet.");
    expect(page(files, "meetings/index.md")).toContain("# Meetings\n\nEvery ingested meeting, newest first.\n\nNone yet.");
    expect(page(files, "actions/index.md")).toContain("## Open\n\nNone yet.\n\n## Closed\n\nNone.");
    expect(page(files, "deadlines/index.md")).toContain("## No date\n\nNone yet.");
  });

  it("does not depend on the order of the input arrays", () => {
    const input = fixture();
    const shuffled = {
      ...input,
      meetings: [...input.meetings].reverse(),
      actions: [...input.actions].reverse(),
      deadlines: [...input.deadlines].reverse(),
    };
    expect(renderRollups(shuffled)).toEqual(renderRollups(input));
  });

  it("is deterministic across repeated calls", () => {
    expect(renderRollups(fixture())).toEqual(renderRollups(fixture()));
  });

  it("keeps undated items after dated ones and closed items out of the open list", () => {
    const actions = page(renderRollups(fixture()), "actions/index.md");
    expect(actions.indexOf("First action")).toBeLessThan(actions.indexOf("No date"));
    expect(actions).not.toContain("Done thing");
  });
});

describe("readOkfPages", () => {
  function authored(relativePath: string, frontmatter: readonly string[], body = "Body."): OkfFile {
    return { relativePath, content: lines("---", ...frontmatter, "---", "", body) };
  }

  it("reads an authored action page back into an action item", () => {
    const result = readOkfPages([
      authored("actions/second-action.md", [
        "type: Action",
        'title: "Second [action]"',
        "state: done",
        "owner: Alice",
        "due: 2026-11-20",
        `sources: [${MEETING_ID}]`,
      ]),
    ]);
    expect(result.actions).toEqual([{
      id: "second-action",
      title: "Second [action]",
      state: "done",
      owner: "Alice",
      dueAtMs: Date.parse("2026-11-20"),
      sources: [{ meetingId: MEETING_ID, transcriptVersion: 0 }],
    }]);
  });

  it("reads an authored deadline page back into a deadline", () => {
    const result = readOkfPages([
      authored("deadlines/ship-it.md", [
        "type: Deadline",
        "title: Ship it",
        "state: open",
        "due: 2026-11-22T17:00:00.000Z",
        "meeting_id: m1",
      ]),
    ]);
    expect(result.deadlines).toEqual([{
      id: "ship-it",
      title: "Ship it",
      dueAtMs: Date.parse("2026-11-22T17:00:00.000Z"),
      state: "open",
      meetingId: "m1",
    }]);
  });

  it("prefers an explicit id and keeps transcript versions", () => {
    const result = readOkfPages([
      authored("actions/slug-name.md", [
        "id: custom-id",
        "title: Custom",
        "state: open",
        `sources: [${MEETING_ID}]`,
        "transcript_version: 4",
      ]),
    ]);
    expect(result.actions[0]).toMatchObject({
      id: "custom-id",
      sources: [{ meetingId: MEETING_ID, transcriptVersion: 4 }],
    });
  });

  it("derives a deadline's meeting from its sources when meeting_id is absent", () => {
    const result = readOkfPages([
      authored("deadlines/x.md", ["title: X", "state: open", "due: 2026-11-22", `sources: [${MEETING_ID}]`]),
    ]);
    expect(result.deadlines[0]?.meetingId).toBe(MEETING_ID);
  });

  it("skips pages it cannot understand instead of failing", () => {
    const result = readOkfPages([
      authored("actions/no-state.md", ["title: Untitled"]),
      authored("actions/no-title.md", ["state: open"]),
      authored("deadlines/no-due.md", ["title: X", "state: open", "meeting_id: m1"]),
      authored("deadlines/no-meeting.md", ["title: X", "state: open", "due: 2026-11-22"]),
      authored("actions/index.md", ["type: Index", "title: Actions", "state: open"]),
      authored("deadlines/index.md", ["type: Index", "title: Deadlines", "state: open", "due: 2026-11-22"]),
      authored("entities/person/jane.md", ["title: Jane", "state: open"]),
      { relativePath: "actions/notes.txt", content: "not a page" },
    ]);
    expect(result).toEqual({ actions: [], deadlines: [] });
  });

  it("returns a stable order regardless of input order", () => {
    const files = [
      authored("actions/b.md", ["title: Bee", "state: open"]),
      authored("actions/a.md", ["title: Aye", "state: open"]),
    ];
    expect(readOkfPages(files).actions.map((item) => item.id)).toEqual(["a", "b"]);
    expect(readOkfPages([...files].reverse()).actions.map((item) => item.id)).toEqual(["a", "b"]);
  });

  it("round-trips the pages the rollups describe", () => {
    const files = renderRollups(fixture());
    const authoredPages = [
      authored("actions/second-action.md", ["title: Second [action]", "state: open", "due: 2026-11-20"]),
      authored("deadlines/ship-it.md", ["title: Ship it", "state: open", "due: 2026-11-22", "meeting_id: m1"]),
    ];
    const result = readOkfPages([...files, ...authoredPages]);
    expect(result.actions.map((item) => item.title)).toEqual(["Second [action]"]);
    expect(result.deadlines.map((item) => item.title)).toEqual(["Ship it"]);
  });
});
