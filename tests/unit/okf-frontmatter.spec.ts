import { describe, expect, it } from "vitest";

import { renderDocument, renderFrontmatter } from "../../src/okf/frontmatter.js";
import { parseFrontmatter } from "../../src/okf/frontmatter-read.js";

function lines(...items: readonly string[]): string {
  return `${items.join("\n")}\n`;
}

describe("renderFrontmatter", () => {
  it("quotes every ambiguous scalar and keeps insertion order", () => {
    const rendered = renderFrontmatter({
      plain: "plain",
      colon: "a: b",
      hash: "#x",
      ws: " x",
      empty: "",
      num: "123",
      bool: "true",
      nul: "null",
      date: "2026-11-24",
      dash: "- x",
      q: 'a"b',
      bs: "a\\b",
      nl: "a\nb",
      tab: "a\tb",
      quote: "it's",
      arr: ["a", "b: c", "123", 'x"y'],
      none: null,
      neg: -5,
      yes: true,
    });
    expect(rendered).toBe(lines(
      "---",
      "plain: plain",
      'colon: "a: b"',
      'hash: "#x"',
      'ws: " x"',
      'empty: ""',
      'num: "123"',
      'bool: "true"',
      'nul: "null"',
      'date: "2026-11-24"',
      'dash: "- x"',
      'q: "a\\"b"',
      'bs: "a\\\\b"',
      'nl: "a\\nb"',
      'tab: "a\\tb"',
      "quote: \"it's\"",
      'arr: [a, "b: c", "123", "x\\"y"]',
      "none: null",
      "neg: -5",
      "yes: true",
      "---",
    ));
  });

  it("drops undefined values without leaving a key behind", () => {
    expect(renderFrontmatter({ kept: "v", skipped: undefined })).toBe(lines("---", "kept: v", "---"));
  });

  it("escapes control characters instead of writing them raw", () => {
    expect(renderFrontmatter({ control: "a\u0001b" })).toBe(lines("---", 'control: "a\\u0001b"', "---"));
  });

  it("quotes keys the reader could not split", () => {
    expect(renderFrontmatter({ ok_key: "v", "bad key": "v", "k:v": "v" })).toBe(lines(
      "---",
      "ok_key: v",
      '"bad key": v',
      '"k:v": v',
      "---",
    ));
  });

  it("returns a block with exactly one trailing newline", () => {
    const rendered = renderFrontmatter({ type: "Index" });
    expect(rendered.endsWith("---\n")).toBe(true);
    expect(rendered.endsWith("\n\n")).toBe(false);
  });
});

describe("renderDocument", () => {
  it("separates frontmatter from the body with one blank line", () => {
    expect(renderDocument({ type: "Index" }, "Hello")).toBe(lines("---", "type: Index", "---", "", "Hello"));
  });

  it("ends a page with exactly one newline, whatever the body ends with", () => {
    expect(renderDocument({ type: "Index" }, "Hello\n\n\n")).toBe(lines("---", "type: Index", "---", "", "Hello"));
  });

  it("renders an empty body as frontmatter only", () => {
    expect(renderDocument({ type: "Index" }, "  \n\n")).toBe(lines("---", "type: Index", "---"));
  });

  it("normalises CRLF and lone CR bodies to LF", () => {
    expect(renderDocument({ type: "Index" }, "a\r\nb\rc")).toBe(lines("---", "type: Index", "---", "", "a", "b", "c"));
  });

  it("is deterministic for repeated calls", () => {
    expect(renderDocument({ b: 2, a: 1 }, "Body")).toBe(renderDocument({ b: 2, a: 1 }, "Body"));
  });
});

describe("parseFrontmatter", () => {
  it("reads plain, quoted and single-quoted values", () => {
    const parsed = parseFrontmatter([
      "---",
      "plain: text",
      'double: "a: b # not a comment"',
      "single: 'it''s'",
      "number: 42",
      "flag: true",
      "---",
      "Body",
    ].join("\n"));
    expect(parsed.fields).toEqual({
      plain: "text",
      double: "a: b # not a comment",
      single: "it's",
      number: "42",
      flag: "true",
    });
    expect(parsed.body).toBe("Body");
  });

  it("parses inline arrays with quoted commas and brackets", () => {
    const parsed = parseFrontmatter([
      "---",
      "tags: [a, 'b, c', \"d]e\", plain]",
      "empty: []",
      "---",
    ].join("\n"));
    expect(parsed.fields).toEqual({ tags: ["a", "b, c", "d]e", "plain"], empty: [] });
  });

  it("tolerates CRLF, comments and unknown lines", () => {
    const parsed = parseFrontmatter("---\r\na: b # note\r\n# whole comment\r\ngarbage\r\nnot a field\r\n---\r\n\r\nBody\r\n");
    expect(parsed.fields).toEqual({ a: "b" });
    expect(parsed.body).toBe("Body");
  });

  it("accepts a quoted key and a byte-order mark", () => {
    expect(parseFrontmatter("\uFEFF---\n\"a b\": v\n---\nBody")).toEqual({ fields: { "a b": "v" }, body: "Body" });
  });

  it("treats YAML null and empty values as absent fields", () => {
    expect(parseFrontmatter("---\na: null\nb: ~\nc:\nd: v\n---\n").fields).toEqual({ d: "v" });
  });

  it("leaves the source alone when no complete frontmatter block exists", () => {
    expect(parseFrontmatter("plain body")).toEqual({ fields: {}, body: "plain body" });
    expect(parseFrontmatter("---\na: b")).toEqual({ fields: {}, body: "---\na: b" });
  });

  it("round-trips everything the writer emits", () => {
    const fields = {
      type: "Note",
      title: 'Q: "quoted" \\ path',
      tags: ["a", "b: c", "[x]"],
      count: "42",
      draft: "true",
      date: "2026-11-24",
    } as const;
    const parsed = parseFrontmatter(renderDocument(fields, "Body\nline"));
    expect(parsed.fields).toEqual(fields);
    expect(parsed.body).toBe("Body\nline");
  });
});
