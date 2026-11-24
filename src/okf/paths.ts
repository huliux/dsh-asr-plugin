import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";

import type { OkfActionItem, OkfMeetingView } from "./contracts.js";
import { OkfError } from "./contracts.js";

/** Bundle-relative paths that every bundle carries. */
export const OKF_ROOT_INDEX = "index.md";
export const OKF_MEETINGS_INDEX = "meetings/index.md";
export const OKF_ACTIONS_INDEX = "actions/index.md";
export const OKF_DEADLINES_INDEX = "deadlines/index.md";
export const OKF_TRANSCRIPTS_DIRECTORY = "references/transcripts";

const MAX_SLUG_LENGTH = 60;
/** A word-boundary cut is only worth keeping when it leaves a meaningful slug. */
const MIN_CUT_LENGTH = 8;
const SAFE_SEGMENT = /^[a-z0-9._-]+$/u;
const ASCII_FOLD = /[\u0300-\u036f]/gu;
const UNSAFE_SLUG_RUNS = /[^a-z0-9]+/gu;

function hashedSuffix(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 8);
}

/** Cap a slug at a whole-word boundary so file names stay readable and stable. */
function capSlug(slug: string): string {
  if (slug.length <= MAX_SLUG_LENGTH) return slug;
  const cut = slug.slice(0, MAX_SLUG_LENGTH);
  const boundary = cut.lastIndexOf("-");
  const head = boundary >= MIN_CUT_LENGTH ? cut.slice(0, boundary) : cut;
  return head.replace(/-+$/u, "");
}

/**
 * Deterministic ASCII slug for a meeting title or action title.
 *
 * Diacritics fold to ASCII; everything else outside `[a-z0-9]` becomes a
 * separator. A title with no ASCII letters or digits (for example a
 * Chinese-only title) falls back to `m-<8 hex>` derived from the raw trimmed
 * text, because `sha256` is stable across runs, platforms and Node versions.
 */
export function normalizeOkfSlug(text: string): string {
  const raw = text.trim();
  const slug = raw
    .normalize("NFKD")
    .replace(ASCII_FOLD, "")
    .toLowerCase()
    .replace(UNSAFE_SLUG_RUNS, "-")
    .replace(/^-+/u, "")
    .replace(/-+$/u, "");
  if (slug === "") return `m-${hashedSuffix(raw)}`;
  return capSlug(slug);
}

/**
 * `startedAtMs` is read in UTC on purpose.
 *
 * The plugin and its CI must produce byte-identical pages on every machine, so
 * the calendar date never depends on the writer's local time zone. A meeting
 * recorded at 23:30 UTC belongs to that UTC date even when the user's clock has
 * already rolled over. Callers that need local grouping can filter before
 * calling this function; the bundle itself is time-zone free.
 */
export function meetingRelativePath(meeting: OkfMeetingView): string {
  const date = new Date(meeting.startedAtMs).toISOString().slice(0, 10);
  return `meetings/${date}-${normalizeOkfSlug(meeting.title)}.md`;
}

/** Keep a single path segment safe; fall back to a stable hash when impossible. */
function safeSegment(text: string): string {
  const folded = text.trim().toLowerCase()
    .replace(UNSAFE_SLUG_RUNS, "-")
    .replace(/^-+/u, "")
    .replace(/-+$/u, "");
  if (folded === "" || folded === "." || folded === "..") return `m-${hashedSuffix(text.trim())}`;
  if (!SAFE_SEGMENT.test(folded)) return `m-${hashedSuffix(text.trim())}`;
  return folded;
}

/** Transcript copies are keyed by meeting id so re-ingestion overwrites one page. */
export function transcriptCopyRelativePath(meetingId: string): string {
  return `${OKF_TRANSCRIPTS_DIRECTORY}/${safeSegment(meetingId)}.md`;
}

/**
 * `actions/<slug>.md` is shared with the page authoring slice: the same helper
 * keeps rollup links and authored pages in agreement. Titles that collapse to
 * the same slug address the same page, so callers deduplicate by title first.
 */
export function actionRelativePath(item: Pick<OkfActionItem, "title">): string {
  return `actions/${normalizeOkfSlug(item.title)}.md`;
}

function escapeError(relativePath: string, reason: string): never {
  throw new OkfError(
    "OKF_PATH_ESCAPE",
    `Unsafe OKF bundle path ${JSON.stringify(relativePath)}: ${reason}.`,
  );
}

/**
 * Reject a bundle-relative path that could leave the bundle or that the page
 * layout cannot address. Deliberately stricter than the OS: lowercase ASCII,
 * forward slashes and no empty, `.` or `..` segment.
 */
export function assertSafeRelativePath(relativePath: string): void {
  if (relativePath === "") escapeError(relativePath, "empty path");
  if (relativePath.includes("\\")) escapeError(relativePath, "backslashes are not allowed");
  if (relativePath.startsWith("/")) escapeError(relativePath, "absolute paths are not allowed");
  for (const segment of relativePath.split("/")) {
    if (segment === "") escapeError(relativePath, "empty segment");
    if (segment === "." || segment === "..") escapeError(relativePath, `segment ${JSON.stringify(segment)} is not allowed`);
    if (!SAFE_SEGMENT.test(segment)) {
      escapeError(relativePath, `segment ${JSON.stringify(segment)} contains unsupported characters`);
    }
  }
}

function isMissingPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * Resolve symlinks in the existing prefix of an absolute path and re-append the
 * segments that do not exist yet. Resolving only the existing ancestor means a
 * not-yet-created bundle directory still canonicalises consistently.
 */
async function canonicalize(absolutePath: string): Promise<string> {
  const missing: string[] = [];
  let current = absolutePath;
  for (;;) {
    try {
      const resolved = await realpath(current);
      return missing.length === 0 ? resolved : path.join(resolved, ...missing.reverse());
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      const parent = path.dirname(current);
      if (parent === current) return absolutePath;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

function isWithin(root: string, target: string): boolean {
  if (target === root) return true;
  const relative = path.relative(root, target);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

/**
 * Join a validated relative path under `root` and prove the real parent still
 * lives inside the bundle. `realRoot` may be supplied by the caller when it has
 * already resolved the root; it is then used verbatim as the canonical root.
 * Reads only directory metadata, never page contents.
 */
export async function resolveBundlePath(
  root: string,
  relativePath: string,
  realRoot?: string,
): Promise<string> {
  assertSafeRelativePath(relativePath);
  const absoluteRoot = path.resolve(root);
  const target = path.resolve(absoluteRoot, relativePath);
  if (!isWithin(absoluteRoot, target)) escapeError(relativePath, "path leaves the bundle root");
  const canonicalRoot = realRoot === undefined
    ? await canonicalize(absoluteRoot)
    : path.resolve(realRoot);
  const canonicalParent = await canonicalize(path.dirname(target));
  if (!isWithin(canonicalRoot, canonicalParent)) {
    escapeError(relativePath, "resolved parent directory escapes the bundle root");
  }
  return target;
}
