import path from "node:path";

import type { OkfFile, OkfLinkViolation } from "./contracts.js";

/**
 * Inline links and images: `[text](target)` and `![alt](target)`. Escaped
 * brackets inside the text are part of the text, so the pattern consumes
 * backslash pairs instead of treating them as delimiters.
 */
const INLINE_LINK = /(!?)\[((?:\\.|[^\]\\])*)\]\(((?:\\.|[^)\\])*)\)/gu;
const EXTERNAL_TARGET = /^(?:https?|mailto|tel):/iu;

function isDelimiter(line: string): boolean {
  return line.trimEnd() === "---";
}

function normalisePagePath(relativePath: string): string {
  return path.posix.normalize(relativePath.replace(/^\.\//u, "")).replace(/^\/+/u, "");
}

/** Number of lines taken by the frontmatter block; 0 when the page has none. */
function frontmatterLines(lines: readonly string[]): number {
  if (!isDelimiter(lines[0] ?? "")) return 0;
  for (let index = 1; index < lines.length; index += 1) {
    if (isDelimiter(lines[index] ?? "")) return index + 1;
  }
  return 0;
}

function isEscaped(line: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && line.charAt(cursor) === "\\"; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

/** Destination text, without angle brackets or an optional link title. */
function destinationOf(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  if (trimmed.startsWith("<")) {
    const close = trimmed.indexOf(">");
    return close === -1 ? undefined : trimmed.slice(1, close);
  }
  const head = trimmed.split(/\s+/u)[0];
  return head === undefined || head === "" ? undefined : head;
}

function resolveTarget(filePath: string, target: string): "ignore" | "outside" | string {
  if (EXTERNAL_TARGET.test(target)) return "ignore";
  if (target.startsWith("#")) return "ignore";
  const cut = target.search(/[?#]/u);
  const pathPart = cut === -1 ? target : target.slice(0, cut);
  if (pathPart === "") return "ignore";
  if (pathPart.startsWith("/")) return "outside";
  const directory = path.posix.dirname(filePath);
  const resolved = path.posix.normalize(path.posix.join(directory, pathPart));
  if (resolved === ".." || resolved.startsWith("../") || path.posix.isAbsolute(resolved)) return "outside";
  return resolved;
}

function knownPaths(files: readonly OkfFile[], existingPaths: readonly string[]): ReadonlySet<string> {
  const known = new Set<string>();
  for (const file of files) known.add(normalisePagePath(file.relativePath));
  for (const existing of existingPaths) known.add(normalisePagePath(existing));
  return known;
}

interface ScanState {
  readonly filePath: string;
  readonly known: ReadonlySet<string>;
  readonly violations: OkfLinkViolation[];
}

function scanLine(state: ScanState, line: string, lineNumber: number): void {
  INLINE_LINK.lastIndex = 0;
  for (let match = INLINE_LINK.exec(line); match !== null; match = INLINE_LINK.exec(line)) {
    if (isEscaped(line, match.index)) continue;
    const target = destinationOf(match[3] ?? "");
    if (target === undefined) continue;
    const resolved = resolveTarget(state.filePath, target);
    if (resolved === "ignore") continue;
    if (resolved === "outside") {
      state.violations.push({
        relativePath: state.filePath,
        line: lineNumber,
        target,
        reason: "outside-bundle",
      });
      continue;
    }
    if (!state.known.has(resolved)) {
      state.violations.push({
        relativePath: state.filePath,
        line: lineNumber,
        target,
        reason: "missing-target",
      });
    }
  }
}

/**
 * Check every inline link in the given pages.
 *
 * Frontmatter and fenced code blocks are not Markdown bodies, so they are
 * skipped while line numbering stays relative to the whole file. Relative
 * targets resolve from the containing page's directory; `#fragment` and
 * `?query` are ignored for resolution but kept in the reported target.
 * Violations sort by page, then line, then target.
 */
export function scanBundleLinks(input: {
  readonly files: readonly OkfFile[];
  readonly existingPaths?: readonly string[];
}): readonly OkfLinkViolation[] {
  const known = knownPaths(input.files, input.existingPaths ?? []);
  const violations: OkfLinkViolation[] = [];
  for (const file of input.files) {
    const filePath = normalisePagePath(file.relativePath);
    const lines = file.content.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n").split("\n");
    const skipUntil = frontmatterLines(lines);
    const state: ScanState = { filePath, known, violations };
    let fence: "```" | "~~~" | undefined;
    for (let index = skipUntil; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      const trimmed = line.trimStart();
      const marker = trimmed.startsWith("```") ? "```" : trimmed.startsWith("~~~") ? "~~~" : undefined;
      if (fence !== undefined) {
        if (marker === fence) fence = undefined;
        continue;
      }
      if (marker !== undefined) {
        fence = marker;
        continue;
      }
      scanLine(state, line, index + 1);
    }
  }
  violations.sort((left, right) => (left.relativePath < right.relativePath ? -1
    : left.relativePath > right.relativePath ? 1 : 0)
    || left.line - right.line
    || (left.target < right.target ? -1 : left.target > right.target ? 1 : 0));
  return violations;
}
