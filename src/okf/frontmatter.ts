/**
 * Minimal, dependency-free YAML frontmatter writer for OKF pages.
 *
 * Only the shapes the plugin needs are emitted: scalars, booleans, numbers,
 * null and one-line string arrays. Keys keep the caller's insertion order, so a
 * page rendered from the same values is byte-identical every time.
 */

/** Values a page may store in one frontmatter field. */
export type FrontmatterValue = string | number | boolean | readonly string[] | null | undefined;

export type FrontmatterFields = Readonly<Record<string, FrontmatterValue>>;

const PLAIN_KEY = /^[A-Za-z_][A-Za-z0-9_-]*$/u;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f\u2028\u2029]/u;
const AMBIGUOUS_PUNCTUATION = /[:#[\]{}*&!|>@`,%"'\\]/u;
const BOOLEAN_OR_NULL = /^(?:true|false|yes|no|on|off|null|~)$/iu;
const DECIMAL_NUMBER = /^[-+]?(?:\d[\d_]*\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/u;
const RADIX_NUMBER = /^[-+]?0(?:x[0-9a-f]+|o[0-7]+|b[01]+)$/iu;
const SPECIAL_NUMBER = /^[-+]?\.(?:inf|nan)$/iu;
const DATE_LIKE = /^\d{4}-\d{2}-\d{2}$/u;

/** Escape a string for a YAML double-quoted scalar; no raw newline survives. */
function quoteString(value: string): string {
  let out = '"';
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (character === '"') out += '\\"';
    else if (character === "\\") out += "\\\\";
    else if (character === "\n") out += "\\n";
    else if (character === "\t") out += "\\t";
    else if (character === "\r") out += "\\r";
    else if (code < 0x20 || code === 0x7f || code === 0x2028 || code === 0x2029) {
      out += `\\u${code.toString(16).padStart(4, "0")}`;
    } else out += character;
  }
  return `${out}"`;
}

/**
 * A plain scalar keeps the page readable, but any value YAML could re-type or
 * mis-tokenize is quoted instead. Over-quoting is safe; under-quoting is not.
 */
function needsQuotes(value: string): boolean {
  if (value === "") return true;
  if (value !== value.trim()) return true;
  if (CONTROL_CHARACTERS.test(value)) return true;
  if (AMBIGUOUS_PUNCTUATION.test(value)) return true;
  if (/^[-?]/u.test(value)) return true;
  if (BOOLEAN_OR_NULL.test(value)) return true;
  if (DATE_LIKE.test(value)) return true;
  if (DECIMAL_NUMBER.test(value) || RADIX_NUMBER.test(value) || SPECIAL_NUMBER.test(value)) return true;
  return false;
}

function renderString(value: string): string {
  return needsQuotes(value) ? quoteString(value) : value;
}

function renderValue(value: Exclude<FrontmatterValue, undefined>): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : quoteString(String(value));
  }
  if (typeof value === "string") return renderString(value);
  return `[${value.map((item) => renderString(item)).join(", ")}]`;
}

function renderKey(key: string): string {
  return PLAIN_KEY.test(key) ? key : quoteString(key);
}

/**
 * Render one frontmatter block, including both `---` delimiters and the
 * trailing newline that `renderDocument` relies on.
 */
export function renderFrontmatter(fields: FrontmatterFields): string {
  const lines: string[] = ["---"];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    lines.push(`${renderKey(key)}: ${renderValue(value)}`);
  }
  lines.push("---");
  return `${lines.join("\n")}\n`;
}

/**
 * A page body is normalised to LF and ends with exactly one newline, so the
 * same body always produces the same bytes on every platform.
 */
export function renderDocument(fields: FrontmatterFields, body: string): string {
  const normalized = body.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n").replace(/\n+$/u, "");
  const frontmatter = renderFrontmatter(fields);
  return normalized.trim() === "" ? frontmatter : `${frontmatter}\n${normalized}\n`;
}
