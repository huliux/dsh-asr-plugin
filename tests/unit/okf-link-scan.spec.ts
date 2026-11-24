import { describe, expect, it } from "vitest";

import type { OkfFile, OkfLinkViolation, OkfRollupInput } from "../../src/okf/contracts.js";
import { scanBundleLinks } from "../../src/okf/link-scan.js";
import { renderRollups } from "../../src/okf/rollups.js";
import { renderTranscriptCopy } from "../../src/okf/transcript-copy.js";
import type { OkfMeetingView } from "../../src/okf/contracts.js";

const GENERATED_AT = Date.parse("2026-11-24T12:00:00.000Z");
const MEETING_ID = "11111111-1111-4111-8111-111111111111";

function page(relativePath: string, content: readonly string[]): OkfFile {
  return { relativePath, content: content.join("\n") };
}

const ROLLUP_INPUT: OkfRollupInput = {
  generatedAtMs: GENERATED_AT,
  meetings: [{
    meetingId: MEETING_ID,
    title: "Weekly product sync",
    relativePath: "meetings/2026-11-20-weekly-product-sync.md",
    startedAtMs: Date.parse("2026-11-20T09:00:00.000Z"),
    status: "draft",
    actionCount: 2,
    deadlineCount: 1,
  }],
  actions: [
    { id: "a2", title: "Second [action]", state: "open", dueAtMs: Date.parse("2026-11-20T00:00:00.000Z"), sources: [] },
    { id: "a1", title: "First action", state: "open", sources: [] },
    { id: "a3", title: "Third action", state: "done", sources: [] },
  ],
  deadlines: [{
    id: "d1",
    title: "Ship it",
    dueAtMs: Date.parse("2026-11-22T00:00:00.000Z"),
    state: "open",
    meetingId: "m1",
  }],
};

const LINKED_PAGES = [
  "actions/second-action.md",
  "actions/first-action.md",
  "meetings/2026-11-20-weekly-product-sync.md",
];

describe("scanBundleLinks", () => {
  it("reports nothing for a bundle whose links all resolve", () => {
    expect(scanBundleLinks({ files: renderRollups(ROLLUP_INPUT), existingPaths: LINKED_PAGES })).toEqual([]);
  });

  it("reports missing and escaping links with 1-based line numbers", () => {
    const file = page("one.md", [
      "---",
      'title: "[front](./front.md)"',
      "---",
      "",
      "[ok](./target.md)",
      "[down](../outside.md)",
      "[gone](./missing.md)",
      "[web](https://example.com/x) [mail](mailto:a@b) [tel](tel:+1) [anchor](#top)",
      "![img](./pic.png)",
      "\\[escaped\\](./escaped.md)",
      "```",
      "[fenced](./fenced.md)",
      "```",
      "[frag](./target.md#section) [query](./target.md?raw=1)",
      '[title](./target.md "Label")',
    ]);
    expect(scanBundleLinks({ files: [file], existingPaths: ["./target.md"] })).toEqual([
      { relativePath: "one.md", line: 6, target: "../outside.md", reason: "outside-bundle" },
      { relativePath: "one.md", line: 7, target: "./missing.md", reason: "missing-target" },
      { relativePath: "one.md", line: 9, target: "./pic.png", reason: "missing-target" },
    ]);
  });

  it("ignores frontmatter, fenced code, escapes and external destinations", () => {
    const file = page("quiet.md", [
      "---",
      'title: "[front](./front.md)"',
      "---",
      "",
      "\\[not a link\\](./nowhere.md)",
      "~~~",
      "[code](./nowhere.md)",
      "~~~",
      "[web](https://example.com) [http](http://example.com) [mail](mailto:x@y) [tel](tel:112)",
      "",
    ]);
    expect(scanBundleLinks({ files: [file] })).toEqual([]);
  });

  it("detects links whose text contains an escaped bracket", () => {
    const file = page("index.md", ["[a \\] b](./missing.md)"]);
    expect(scanBundleLinks({ files: [file] })).toEqual([
      { relativePath: "index.md", line: 1, target: "./missing.md", reason: "missing-target" },
    ]);
  });

  it("resolves angle-bracket destinations", () => {
    const files = [
      page("index.md", ["[a](<./actions/a.md>) [b](<./gone.md>)"]),
      page("actions/a.md", ["# A"]),
    ];
    expect(scanBundleLinks({ files })).toEqual([
      { relativePath: "index.md", line: 1, target: "./gone.md", reason: "missing-target" },
    ]);
  });

  it("treats root-absolute destinations as outside the bundle", () => {
    expect(scanBundleLinks({ files: [page("index.md", ["[a](/etc/passwd)"])] })).toEqual([
      { relativePath: "index.md", line: 1, target: "/etc/passwd", reason: "outside-bundle" },
    ]);
  });

  it("resolves links from the containing directory, not the bundle root", () => {
    const files = [
      page("actions/index.md", ["[a](./a.md)", "[b](../meetings/m.md)"]),
      page("actions/a.md", ["# A"]),
      page("meetings/m.md", ["# M"]),
    ];
    expect(scanBundleLinks({ files })).toEqual([]);
  });

  it("flags a link that climbs above the bundle from a nested page", () => {
    expect(scanBundleLinks({ files: [page("actions/index.md", ["[x](../../x.md)"])] })).toEqual([
      { relativePath: "actions/index.md", line: 1, target: "../../x.md", reason: "outside-bundle" },
    ]);
  });

  it("sorts violations by page, then line, then target", () => {
    const files = [
      page("b.md", ["[x](./x.md)", "[y](./y.md)"]),
      page("a.md", ["[y](./y.md)", "[x](./x.md)"]),
    ];
    expect(scanBundleLinks({ files }).map((item: OkfLinkViolation) => `${item.relativePath}:${item.line}:${item.target}`))
      .toEqual(["a.md:1:./y.md", "a.md:2:./x.md", "b.md:1:./x.md", "b.md:2:./y.md"]);
  });

  it("does not depend on the order of the input files", () => {
    const files = [page("b.md", ["[x](./x.md)"]), page("a.md", ["[y](./y.md)"])];
    expect(scanBundleLinks({ files: [...files].reverse() })).toEqual(scanBundleLinks({ files }));
  });

  it("accepts existing paths that are not part of the current file set", () => {
    const files = [page("index.md", ["[a](./actions/new.md)"])];
    expect(scanBundleLinks({ files, existingPaths: ["actions/new.md"] })).toEqual([]);
  });

  it("accepts images whose target exists", () => {
    const files = [page("index.md", ["![diagram](./assets/diagram.png)"]), page("assets/diagram.png", ["png"])];
    expect(scanBundleLinks({ files })).toEqual([]);
  });

  it("flags a broken image like a broken link", () => {
    expect(scanBundleLinks({ files: [page("index.md", ["![diagram](./assets/gone.png)"])] })).toEqual([
      { relativePath: "index.md", line: 1, target: "./assets/gone.png", reason: "missing-target" },
    ]);
  });

  it("reports nothing for a transcript copy whose links are escaped", () => {
    const meeting: OkfMeetingView = {
      meetingId: MEETING_ID,
      title: "Weekly product sync",
      startedAtMs: Date.parse("2026-11-20T09:00:00.000Z"),
      durationMs: 60_000,
      speakers: ["Alice", "Bob"],
      transcriptVersion: 1,
      committedAtMs: Date.parse("2026-11-20T09:05:00.000Z"),
      partial: false,
      segments: [{
        seq: 0,
        speaker: "Alice",
        startMs: 0,
        endMs: 1_000,
        text: "See [docs](https://example.com) and ![img](pic.png) and [x](./relative.md).",
      }],
    };
    const copy = renderTranscriptCopy({ meeting });
    expect(scanBundleLinks({ files: [copy] })).toEqual([]);
  });
});
